# MMR Watch — Rocket League live tracker

A small full-stack app: an Express backend proxies Parse.bot's Tracker API
(a managed wrapper over rocketleague.tracker.network), keeping your API key
server-side, and a plain HTML/JS dashboard lets you add any player by
platform + handle, see their MMR/tier per playlist, and refresh on demand
(or on a long auto-refresh interval), with a session sparkline that builds
up over time.

## 1. Get an API key

Sign up free at https://parse.bot and grab your API key. The free tier is
**200 credits/month, 5 requests/minute** — each profile lookup costs 1
credit. That's enough for regular manual checks on a handful of players, but
not for continuous 24/7 polling — see "How refreshing works" below.

## 2. Local setup

```bash
npm install
cp .env.example .env
# edit .env and paste your real PARSE_API_KEY
npm start
```

Open http://localhost:3000

## 3. How players are identified

| Platform | What to type |
|---|---|
| Steam | Vanity name or SteamID64 |
| Epic | Exact Epic display name |
| PlayStation (psn) | Exact PSN name |
| Xbox | Exact gamertag |

(Parse.bot's Tracker API covers these four platforms; Switch isn't
supported by this data source.)

## 4. How refreshing works

- Each card has a **refresh button (↻)** that fetches fresh data on demand,
  bypassing the cache.
- The **Auto-refresh** dropdown (top right) is **off by default**. You can
  turn on a long interval (15m / 30m / 1h / 3h) if you want it to update
  itself, but given the free tier's monthly credit cap, manual refresh is
  the more sustainable default for a personal dashboard.
- The server also caches each player's response for `CACHE_TTL_MS`
  (default 15 minutes) so rapid repeat clicks or multiple browser tabs
  don't multiply your credit usage — the refresh button explicitly bypasses
  this cache when you really want a fresh pull.
- Every non-cached fetch appends a snapshot to `data/history.json`, which
  powers the small sparkline per playlist and the MMR delta shown next to
  the current rating (last 500 points per player, oldest trimmed first).
- Your watchlist (who you're tracking) lives in the browser's
  `localStorage`, not on the server.

## 5. If playlist data looks wrong or empty

Each card has a **"raw" button** that opens the unparsed upstream JSON in a
new tab — useful for checking actual field names if a rating or tier looks
off. The parser (`parseProfile` in `server.js`) expects:

- `data.segments[].type === 'playlist'`
- `stats.rating.value` (MMR)
- `stats.tier.metadata.name` (tier name)
- `stats.division.metadata.name` (division)

Parse.bot's endpoints are actively monitored and self-healing against
upstream site changes, so this should stay accurate, but double-check with
the raw view if something looks wrong.

## 6. Deploying it

**Render (recommended, free, no card required):**
1. Push this folder to a GitHub repo (as actual files, not a zip — GitHub
   won't unzip an uploaded archive for you).
2. Render dashboard → New → Web Service → connect the repo.
3. Build command: `npm install` — Start command: `npm start` — Instance
   type: Free.
4. In the Environment tab, add `PARSE_API_KEY` with your real key.
5. Deploy — you'll get a URL like `https://your-app.onrender.com`.

Notes:
- Render's free tier spins down after 15 minutes idle (30-60s cold start
  on the next visit).
- Free tier has no persistent disk, so `data/history.json` resets on
  redeploy/restart — fine for current MMR, just don't expect long-term
  history to survive a redeploy.

## 7. Project layout

```
server.js             Express app: /api/profile/:platform/:identifier,
                       /api/history/:platform/:identifier, static file serving
public/index.html      Dashboard markup
public/style.css       Dashboard styling
public/app.js          Watchlist, manual/auto refresh, rendering, sparklines
data/history.json       Created automatically; per-player MMR snapshots
.env.example            Copy to .env and fill in PARSE_API_KEY
```

## 8. Ideas for later

- Parse.bot's Tracker API also has a `get_player_sessions` endpoint (recent
  match-by-match results) and `get_historical_season_data` — both could
  extend this app with real per-match deltas instead of just poll-to-poll
  snapshots. Not wired in yet.
- Discord/webhook alerts on rank-up.
- Swap `data/history.json` for SQLite if you want more players/longer
  history without one growing JSON file.
