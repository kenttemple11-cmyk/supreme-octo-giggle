# MMR Watch — Rocket League live tracker

A small full-stack app: an Express backend proxies the Tracker Network Rocket
League API (keeping your API key server-side, never in the browser), and a
plain HTML/JS dashboard lets you add any player by platform + handle, see
their live MMR/tier per playlist, and watch a session sparkline build up as
it polls.

## 1. Local setup

```bash
npm install
cp .env.example .env
# edit .env and paste your real TRN_API_KEY
npm start
```

Open http://localhost:3000

## 2. Important: about your API key

Your key came from the Tracker Network developer portal and is currently
tied to an app **awaiting production approval** — until that's approved you're
likely on a sandbox tier with tighter rate limits, so keep polling intervals
conservative (30–60s) while testing.

Also: **treat the key as sensitive.** It only ever lives in `.env` on the
server and is never sent to the browser — the frontend only talks to your
own `/api/...` routes. Don't commit `.env`, and don't paste the raw key into
screenshots or chats going forward (worth rotating it from the dashboard if
it's ever been shared anywhere).

## 3. How players are identified

| Platform | What to type |
|---|---|
| Steam | Vanity name or SteamID64 |
| Epic | Exact Epic display name |
| PlayStation | Exact PSN name |
| Xbox | Exact gamertag |
| Switch | Exact display name |

## 4. If playlist data looks wrong or empty

Tracker Network's response shape can vary slightly by title/season, and I
built the parser (`parseProfile` in `server.js`) against their documented
`segments` structure, but I can't verify field names against a live response
in this environment. Each card has a **"raw" button** that opens the
unparsed upstream JSON in a new tab — use that to check the actual field
names if something's off, then adjust `parseProfile()` in `server.js`
accordingly. The main things to check:

- `data.segments[].type === 'playlist'`
- `stats.rating.value` (MMR)
- `stats.tier.metadata.name` (tier name)
- `stats.division.metadata.name` (division)

## 5. What "live" means here

- The dashboard polls each tracked player on the interval you pick (top
  right), default 30s.
- The server caches upstream responses for `CACHE_TTL_MS` (default 20s) so
  multiple browser tabs or a fast poll rate don't multiply your API usage.
- Every non-cached fetch appends a snapshot to `data/history.json`, which
  powers the small sparkline per playlist and the MMR delta shown next to
  the current rating. This file grows per player up to 500 points, then
  trims oldest entries.
- Your watchlist (who you're tracking) is stored in the browser's
  `localStorage`, not on the server — different browsers/devices have
  independent watchlists.

## 6. Deploying it

Any Node host works. Two easy options:

**Render / Railway / Fly.io (recommended for "always on" so history keeps building):**
1. Push this folder to a GitHub repo.
2. Create a new Web Service pointing at it.
3. Build command: `npm install` — Start command: `npm start`.
4. Add an environment variable `TRN_API_KEY` with your real key in the
   host's dashboard (never in the repo).
5. Note: `data/history.json` lives on local disk — most of these platforms
   use ephemeral filesystems on redeploy, so history resets when you
   redeploy. Add a persistent volume/disk if you want it to survive
   redeploys, or swap it for a small hosted DB (e.g. SQLite on a mounted
   volume, or Postgres) later if you want it durable long-term.

**A VPS (DigitalOcean/Linode/etc.) or your own machine:**
- `npm install && npm start`, put it behind a process manager (`pm2`) and a
  reverse proxy (nginx/Caddy) with HTTPS if exposing it publicly.

## 7. Project layout

```
server.js            Express app: /api/profile/:platform/:identifier,
                      /api/history/:platform/:identifier, static file serving
public/index.html     Dashboard markup
public/style.css      Dashboard styling
public/app.js         Watchlist, polling, rendering, sparklines
data/history.json     Created automatically; per-player MMR snapshots
.env.example          Copy to .env and fill in TRN_API_KEY
```

## 8. Ideas for later

- Per-match deltas (win/loss, goals) if your API tier includes a matches
  endpoint — the profile endpoint here only gives current standing, not
  individual match history.
- Discord/webhook alerts on rank-up.
- Swap `data/history.json` for SQLite if you want more players/longer
  history without one big JSON file.
