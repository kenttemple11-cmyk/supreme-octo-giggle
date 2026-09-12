const STORAGE_KEY = 'rl-mmr-watchlist-v1';
const grid = document.getElementById('grid');
const emptyEl = document.getElementById('empty');
const addForm = document.getElementById('addForm');
const platformSelect = document.getElementById('platform');
const identifierInput = document.getElementById('identifier');
const pollRateSelect = document.getElementById('pollRate');
const cardTemplate = document.getElementById('cardTemplate');
const playlistTemplate = document.getElementById('playlistTemplate');

const TIER_COLOR = {
  bronze: 'var(--bronze)',
  silver: 'var(--silver)',
  gold: 'var(--gold)',
  platinum: 'var(--platinum)',
  diamond: 'var(--diamond)',
  champion: 'var(--champion)',
  'grand champion': 'var(--grand-champion)',
  'supersonic legend': 'var(--ssl)',
};

function tierColor(tierName) {
  if (!tierName) return 'var(--muted)';
  const key = tierName.toLowerCase().replace(/\s+(i{1,3}|iv|v)$/i, '').trim();
  return TIER_COLOR[key] || 'var(--muted)';
}

// ---------------- watchlist persistence ----------------
function loadWatchlist() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || [];
  } catch {
    return [];
  }
}

function saveWatchlist(list) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
}

let watchlist = loadWatchlist();
const cardEls = new Map(); // key -> card element
const lastSeen = new Map(); // key -> last profile (for delta calc)
let pollTimer = null;

function keyFor(entry) {
  return `${entry.platform}:${entry.identifier.toLowerCase()}`;
}

function renderEmptyState() {
  emptyEl.hidden = watchlist.length > 0;
}

function timeAgo(ts) {
  if (!ts) return '';
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ago`;
}

function buildCard(entry) {
  const node = cardTemplate.content.firstElementChild.cloneNode(true);
  node.dataset.key = keyFor(entry);
  node.querySelector('.platform-badge').textContent = entry.platform;
  node.querySelector('.handle').textContent = entry.identifier;

  node.querySelector('.debug-btn').addEventListener('click', () => {
    window.open(
      `/api/profile/${encodeURIComponent(entry.platform)}/${encodeURIComponent(entry.identifier)}?raw=true`,
      '_blank'
    );
  });

  node.querySelector('.remove-btn').addEventListener('click', () => {
    watchlist = watchlist.filter((e) => keyFor(e) !== keyFor(entry));
    saveWatchlist(watchlist);
    node.remove();
    cardEls.delete(keyFor(entry));
    lastSeen.delete(keyFor(entry));
    renderEmptyState();
  });

  grid.appendChild(node);
  cardEls.set(keyFor(entry), node);
  return node;
}

function drawSparkline(canvas, history, playlistId) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  const points = history
    .map((snap) => snap.playlists?.[playlistId]?.mmr)
    .filter((v) => typeof v === 'number');

  if (points.length < 2) {
    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.beginPath();
    ctx.moveTo(0, h / 2);
    ctx.lineTo(w, h / 2);
    ctx.stroke();
    return;
  }

  const min = Math.min(...points);
  const max = Math.max(...points);
  const range = max - min || 1;
  const stepX = w / (points.length - 1);

  ctx.strokeStyle = '#3da9fc';
  ctx.lineWidth = 2;
  ctx.beginPath();
  points.forEach((v, i) => {
    const x = i * stepX;
    const y = h - ((v - min) / range) * (h - 6) - 3;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();

  const last = points[points.length - 1];
  const lastX = (points.length - 1) * stepX;
  const lastY = h - ((last - min) / range) * (h - 6) - 3;
  ctx.fillStyle = '#3da9fc';
  ctx.beginPath();
  ctx.arc(lastX, lastY, 2.6, 0, Math.PI * 2);
  ctx.fill();
}

function renderPlaylists(container, profile, history, prevProfile) {
  container.innerHTML = '';
  const playlists = profile.playlists || [];

  if (playlists.length === 0) {
    const p = document.createElement('p');
    p.style.color = 'var(--muted)';
    p.style.fontSize = '13px';
    p.textContent = 'No ranked playlist data returned for this player yet.';
    container.appendChild(p);
    return;
  }

  playlists.forEach((pl) => {
    const node = playlistTemplate.content.firstElementChild.cloneNode(true);
    node.querySelector('.playlist-name').textContent = pl.name;

    const badge = node.querySelector('.tier-badge');
    badge.textContent = pl.tier ? `${pl.tier}${pl.division ? ' ' + pl.division : ''}` : 'Unranked';
    badge.style.color = tierColor(pl.tier);

    node.querySelector('.mmr-value').textContent = pl.mmr != null ? pl.mmr : pl.mmrDisplay || '—';

    const deltaEl = node.querySelector('.mmr-delta');
    const prevPl = prevProfile?.playlists?.find((p) => p.playlistId === pl.playlistId);
    if (prevPl && typeof prevPl.mmr === 'number' && typeof pl.mmr === 'number') {
      const diff = pl.mmr - prevPl.mmr;
      if (diff > 0) {
        deltaEl.textContent = `+${diff}`;
        deltaEl.className = 'mmr-delta up';
      } else if (diff < 0) {
        deltaEl.textContent = `${diff}`;
        deltaEl.className = 'mmr-delta down';
      } else {
        deltaEl.textContent = '±0';
        deltaEl.className = 'mmr-delta flat';
      }
    } else {
      deltaEl.textContent = '';
    }

    container.appendChild(node);
    drawSparkline(node.querySelector('.sparkline'), history, pl.playlistId);
  });
}

async function refreshEntry(entry) {
  const key = keyFor(entry);
  const card = cardEls.get(key) || buildCard(entry);
  const errorEl = card.querySelector('.card-error');

  try {
    const res = await fetch(
      `/api/profile/${encodeURIComponent(entry.platform)}/${encodeURIComponent(entry.identifier)}`
    );
    const json = await res.json();

    if (json.error) {
      errorEl.hidden = false;
      errorEl.textContent = json.message || 'Failed to fetch this player.';
      card.querySelector('.updated').textContent = `error ${timeAgo(Date.now())}`;
      return;
    }

    errorEl.hidden = true;
    const prev = lastSeen.get(key);
    renderPlaylists(card.querySelector('.playlists'), json.profile, json.history, prev);
    lastSeen.set(key, json.profile);
    card.querySelector('.updated').textContent = `updated ${timeAgo(Date.now())}`;
  } catch (err) {
    errorEl.hidden = false;
    errorEl.textContent = 'Network error reaching the server.';
    console.error(err);
  }
}

function refreshAll() {
  watchlist.forEach(refreshEntry);
}

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  const rate = Number(pollRateSelect.value);
  pollTimer = setInterval(refreshAll, rate);
}

addForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const entry = {
    platform: platformSelect.value,
    identifier: identifierInput.value.trim(),
  };
  if (!entry.identifier) return;

  const key = keyFor(entry);
  if (watchlist.some((w) => keyFor(w) === key)) {
    identifierInput.value = '';
    return;
  }

  watchlist.push(entry);
  saveWatchlist(watchlist);
  renderEmptyState();
  refreshEntry(entry);
  identifierInput.value = '';
});

pollRateSelect.addEventListener('change', startPolling);

// ---------------- init ----------------
renderEmptyState();
watchlist.forEach((entry) => refreshEntry(entry));
startPolling();
