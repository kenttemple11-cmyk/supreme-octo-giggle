import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

const PORT = process.env.PORT || 3000;
const PARSE_API_KEY = process.env.PARSE_API_KEY;
// Parse.bot's hosted wrapper over rocketleague.tracker.network (see parse.bot/marketplace).
// This endpoint id is specific to that marketplace listing; only change it if Parse.bot
// tells you the API moved to a new id.
const PARSE_BASE_URL = 'https://api.parse.bot/scraper/d0dcf8e8-3a72-4b21-bffb-8fa735257835/get_player_profile';
// Free tier is 200 credits/month + 5 req/min — cache aggressively by default so a personal
// dashboard doesn't burn the monthly quota in an afternoon. Override via .env if you're on a paid tier.
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 15 * 60 * 1000); // 15 min default
const HISTORY_DIR = path.join(__dirname, 'data');
const HISTORY_FILE = path.join(HISTORY_DIR, 'history.json');
const MAX_SNAPSHOTS_PER_PLAYER = 500;

if (!PARSE_API_KEY) {
  console.warn('[warn] PARSE_API_KEY is not set. Copy .env.example to .env and add your key.');
}

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------- tiny in-memory response cache (per platform+identifier) ----------
const cache = new Map(); // key -> { data, ts }

// ---------- simple queued file writer to avoid concurrent write corruption ----------
let writeQueue = Promise.resolve();
function queueWrite(fn) {
  writeQueue = writeQueue.then(fn).catch((err) => console.error('[history write error]', err));
  return writeQueue;
}

async function loadHistory() {
  try {
    const raw = await fs.readFile(HISTORY_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    console.error('[history load error]', err);
    return {};
  }
}

async function appendSnapshot(key, snapshot) {
  await fs.mkdir(HISTORY_DIR, { recursive: true });
  return queueWrite(async () => {
    const all = await loadHistory();
    const arr = all[key] || [];
    arr.push(snapshot);
    if (arr.length > MAX_SNAPSHOTS_PER_PLAYER) {
      arr.splice(0, arr.length - MAX_SNAPSHOTS_PER_PLAYER);
    }
    all[key] = arr;
    await fs.writeFile(HISTORY_FILE, JSON.stringify(all), 'utf-8');
  });
}

async function getHistoryFor(key) {
  const all = await loadHistory();
  return all[key] || [];
}

// ---------- playlist id -> friendly name (Tracker Network RL playlist ids) ----------
const PLAYLIST_NAMES = {
  10: 'Ranked Duel 1v1',
  11: 'Ranked Doubles 2v2',
  13: 'Ranked Standard 3v3',
  12: 'Ranked Solo Standard',
  27: 'Ranked Hoops',
  28: 'Ranked Rumble',
  29: 'Ranked Dropshot',
  30: 'Ranked Snow Day',
  34: 'Tournament Matches',
};

function parseProfile(raw) {
  const data = raw?.data;
  if (!data) return { playlists: [], overview: null, platformInfo: null };

  const platformInfo = data.platformInfo || null;
  const segments = Array.isArray(data.segments) ? data.segments : [];

  const playlists = segments
    .filter((s) => s.type === 'playlist')
    .map((s) => {
      const playlistId = s.attributes?.playlistId;
      const stats = s.stats || {};
      return {
        playlistId,
        name: s.metadata?.name || PLAYLIST_NAMES[playlistId] || `Playlist ${playlistId}`,
        mmr: stats.rating?.value ?? null,
        mmrDisplay: stats.rating?.displayValue ?? stats.rating?.value ?? '—',
        tier: stats.tier?.metadata?.name ?? null,
        division: stats.division?.metadata?.name ?? null,
        matchesPlayed: stats.matchesPlayed?.value ?? null,
        winStreak: stats.winStreak?.value ?? null,
        peakRating: stats.peakRating?.value ?? null,
      };
    });

  const overviewSeg = segments.find((s) => s.type === 'overview');
  const overview = overviewSeg
    ? {
        wins: overviewSeg.stats?.wins?.value ?? null,
        goals: overviewSeg.stats?.goals?.value ?? null,
        mvps: overviewSeg.stats?.mVPs?.value ?? overviewSeg.stats?.mvps?.value ?? null,
        saves: overviewSeg.stats?.saves?.value ?? null,
        assists: overviewSeg.stats?.assists?.value ?? null,
      }
    : null;

  return { platformInfo, playlists, overview };
}

function historyKey(platform, identifier) {
  return `${platform}:${identifier.toLowerCase()}`;
}

const SUPPORTED_PLATFORMS = new Set(['epic', 'steam', 'xbox', 'psn']);

app.get('/api/profile/:platform/:identifier', async (req, res) => {
  const { platform, identifier } = req.params;
  const wantRaw = req.query.raw === 'true' || req.query.raw === '1';
  const key = historyKey(platform, identifier);

  if (!SUPPORTED_PLATFORMS.has(platform)) {
    return res.status(400).json({
      error: true,
      message: `Unsupported platform "${platform}". Parse.bot's Tracker API supports: epic, steam, xbox, psn.`,
    });
  }

  const forceRefresh = req.query.force === 'true' || req.query.force === '1';

  try {
    let upstreamJson;
    const cached = cache.get(key);
    const fresh = !forceRefresh && cached && Date.now() - cached.ts < CACHE_TTL_MS;

    if (fresh) {
      upstreamJson = cached.data;
    } else {
      const url = `${PARSE_BASE_URL}?platform=${encodeURIComponent(platform)}&username=${encodeURIComponent(
        identifier
      )}`;

      const upstream = await fetch(url, {
        headers: { 'X-API-Key': PARSE_API_KEY },
      });

      if (!upstream.ok) {
        const body = await upstream.text();
        return res.status(upstream.status).json({
          error: true,
          status: upstream.status,
          message:
            upstream.status === 404
              ? 'Player not found. Check the platform and exact handle.'
              : upstream.status === 401 || upstream.status === 403
              ? 'Auth error — check your PARSE_API_KEY.'
              : upstream.status === 429
              ? 'Rate limited or out of monthly credits on Parse.bot. Slow down polling or check your usage at parse.bot.'
              : `Upstream error (${upstream.status})`,
          upstreamBody: body?.slice(0, 500),
        });
      }

      upstreamJson = await upstream.json();
      cache.set(key, { data: upstreamJson, ts: Date.now() });
    }

    const parsed = parseProfile(upstreamJson);

    // Record a snapshot for history/graphing (only when not served from cache,
    // so repeated fast polls don't spam duplicate points)
    if (!fresh) {
      const snapshot = {
        t: Date.now(),
        playlists: Object.fromEntries(
          parsed.playlists.map((p) => [p.playlistId, { mmr: p.mmr, tier: p.tier, division: p.division }])
        ),
      };
      appendSnapshot(key, snapshot);
    }

    const history = await getHistoryFor(key);

    res.json({
      error: false,
      fromCache: fresh,
      profile: parsed,
      history,
      ...(wantRaw ? { raw: upstreamJson } : {}),
    });
  } catch (err) {
    console.error('[profile fetch error]', err);
    res.status(500).json({ error: true, message: 'Server error fetching profile.', detail: String(err) });
  }
});

app.get('/api/history/:platform/:identifier', async (req, res) => {
  const { platform, identifier } = req.params;
  const key = historyKey(platform, identifier);
  const history = await getHistoryFor(key);
  res.json({ error: false, history });
});

app.listen(PORT, () => {
  console.log(`RL MMR Tracker server listening on http://localhost:${PORT}`);
});
