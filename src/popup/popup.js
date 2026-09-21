import {
  parseProxyLine, profileLabel, geoLine, normalizeScheme,
  formatBytes, formatDuration, emptyUsage, throughput,
  normalizeScope, normalizeSessionFormat, normalizeCountry,
  buildUsername, sessionRemainingMs, SESSION_FORMATS, hostOf
} from '../engine/proxy.js';

const $ = (id) => document.getElementById(id);
const send = (type, extra = {}) =>
  new Promise((resolve) => {
    chrome.runtime.sendMessage({ type, ...extra }, (res) => {
      if (chrome.runtime.lastError) return resolve({ ok: false, error: chrome.runtime.lastError.message });
      resolve(res || { ok: false, error: 'No response from background' });
    });
  });

let state = {
  profiles: [], activeId: null, connected: false,
  geo: null, lastError: null, usage: emptyUsage()
};
let busy = false;
let usageTimer = null;
let currentTab = null;      // the tab the user had open when the popup launched
let tabProxied = false;

/* ------------------------------------------------------------------ tabs */
document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => showTab(tab.dataset.tab));
});
function showTab(name) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('active', p.id === 'panel-' + name));
}

/* --------------------------------------------------------------- render */
function activeProfile() {
  return state.profiles.find((p) => p.id === state.activeId) || null;
}

function render() {
  const p = activeProfile();
  const on = state.connected;

  $('logoDot').classList.toggle('on', on);
  $('statusLine').classList.toggle('on', on);
  $('statusLine').textContent = on ? 'Connected · ' + profileLabel(p) : 'Disconnected';

  $('powerBtn').classList.toggle('on', on);
  $('powerBtn').classList.toggle('busy', busy);
  $('powerLabel').classList.toggle('on', on);
  $('powerLabel').textContent = busy
    ? (on ? 'Disconnecting…' : 'Connecting…')
    : on ? 'Connected — tap to stop' : (p ? 'Tap to connect' : 'Add a server first');
  $('powerBtn').disabled = busy || !p;

  $('acScheme').textContent = p ? normalizeScheme(p.scheme).toUpperCase() : 'HTTP';
  $('acName').textContent = p ? profileLabel(p) : 'No server selected';
  $('acHost').textContent = p
    ? `${p.host}:${p.port}${p.username ? ' · auth' : ''}`
    : 'Add one in the Add tab';

  renderScope();
  renderSession();
  renderUsage();
  renderGeo();
  renderServers();

  if (state.lastError) showAlert($('alertBox'), state.lastError, 'err');
  else hideAlert($('alertBox'));
}

const lastShown = {};
function setStat(id, text) {
  const el = $(id);
  if (el.textContent === text) return;
  el.textContent = text;
  if (lastShown[id] !== undefined) {
    el.classList.add('bump');
    setTimeout(() => el.classList.remove('bump'), 320);
  }
  lastShown[id] = text;
}

function renderUsage() {
  const u = state.usage || emptyUsage();
  $('statsCard').classList.toggle('live', !!state.connected);
  setStat('sDown', formatBytes(u.down));
  setStat('sUp', formatBytes(u.up));
  setStat('sReq', String(u.requests || 0));
  setStat('sTime', u.startedAt ? formatDuration(Date.now() - u.startedAt) : '0:00');
  const rate = throughput(u);
  $('sRate').textContent = rate > 0
    ? `${formatBytes(rate)}/s avg · estimated`
    : (state.connected ? 'waiting for traffic…' : 'not connected');
}

/** While connected, poll live counters straight from the worker's memory. */
function startUsageTimer() {
  stopUsageTimer();
  usageTimer = setInterval(async () => {
    if (!state.connected) return;
    const res = await send('getUsage');
    if (res.ok) { state.usage = res.data; renderUsage(); }
  }, 1000);
}
function stopUsageTimer() {
  if (usageTimer) { clearInterval(usageTimer); usageTimer = null; }
}

function renderGeo() {
  const g = state.geo;
  const card = $('geoCard');
  const pill = $('geoPill');
  card.classList.toggle('live', !!(g && state.connected));

  if (busy && !g) {
    pill.className = 'pill busy';
    pill.textContent = 'checking';
  } else if (g) {
    pill.className = 'pill live';
    pill.textContent = state.connected ? 'proxy ip' : 'your ip';
  } else {
    pill.className = 'pill';
    pill.textContent = state.connected ? 'no data' : 'idle';
  }

  const set = (id, val) => { $(id).textContent = val || '—'; };
  renderFlag(g);
  set('geoIp', g && g.ip);
  $('geoPlace').textContent = g ? (geoLine(g) || 'Unknown location') : 'IP location will appear after connecting';
  set('gCity', g && g.city);
  set('gRegion', g && g.region);
  set('gCountry', g && (g.country + (g.countryCode ? ` (${g.countryCode})` : '')));
  set('gPostal', g && g.postal);
  set('gIsp', g && g.isp);
  set('gAsn', g && (g.asn ? String(g.asn).replace(/^AS/i, 'AS') : ''));
  set('gTz', g && g.timezone);
  set('gCoord', g && g.latitude != null && g.longitude != null ? `${g.latitude.toFixed(3)}, ${g.longitude.toFixed(3)}` : '');
  set('gLat', g && g.latencyMs ? g.latencyMs + ' ms' : '');
  $('geoSource').textContent = g && g.source ? 'via ' + g.source : '—';
}

/**
 * Windows ships no country-flag emoji font, so U+1F1FA U+1F1F8 renders as the
 * bare letters "US". Draw a real flag image (flagcdn, tiny PNG) and fall back
 * to the emoji/letters only when the image cannot load.
 */
function renderFlag(g) {
  const el = $('geoFlag');
  const cc = g && g.countryCode ? g.countryCode.toLowerCase() : '';
  if (!cc) {
    el.textContent = '🌐';
    el.title = 'Not connected';
    return;
  }
  el.title = (g.country || cc.toUpperCase());
  const img = new Image();
  img.alt = g.flag || cc.toUpperCase();
  img.onerror = () => { el.textContent = g.flag || cc.toUpperCase(); };
  img.src = `https://flagcdn.com/w40/${cc}.png`;
  el.textContent = '';
  el.appendChild(img);
}

/* ------------------------------------------------- scope + session UI */

function renderScope() {
  const p = activeProfile();
  const scope = normalizeScope(p && p.scope);
  document.querySelectorAll('#scopeSeg .scope-item').forEach((el) =>
    el.classList.toggle('active', el.dataset.scope === scope));

  const isTabs = scope === 'tabs';
  $('tabToggle').hidden = !isTabs;
  $('scopeHint').textContent = isTabs
    ? 'Only the tabs you switch on below go through the proxy. Everything else stays on your real IP.'
    : 'Every tab uses the proxy.';

  if (isTabs && currentTab) {
    $('ttTitle').textContent = hostOf(currentTab.url) || currentTab.title || 'Current tab';
    $('ttSub').textContent = tabProxied ? 'routed through the proxy' : 'not proxied — real IP';
    $('tabSwitch').setAttribute('aria-checked', tabProxied ? 'true' : 'false');
    $('tabToggle').classList.toggle('on', tabProxied);
    const n = (state.proxiedTabs || []).length;
    if (n > 1) $('ttSub').textContent += ` · ${n} tabs on`;
  }
}

function renderSession() {
  const p = activeProfile();
  const fmt = normalizeSessionFormat(p && p.sessionFormat);
  const card = $('sessionCard');
  if (!p || fmt === 'none') { card.hidden = true; return; }

  card.hidden = false;
  card.classList.toggle('live', !!state.connected && !!p.sessionId);
  $('sessFmt').textContent = '· ' + (SESSION_FORMATS[fmt].label.split(' (')[0]);
  $('sessId').textContent = p.sessionId || 'not started';

  const remaining = sessionRemainingMs(p);
  const ttl = Number(p.sessionTtlMin) || 0;
  if (!ttl) {
    $('sessTtl').textContent = p.sessionStartedAt
      ? `held ${formatDuration(Date.now() - p.sessionStartedAt)} · no expiry`
      : 'holds this IP indefinitely';
  } else if (remaining === null) {
    $('sessTtl').textContent = `holds for ${ttl} min`;
  } else {
    $('sessTtl').textContent = `rotates in ${formatDuration(remaining)}`;
  }
  $('sessUser').textContent = buildUsername(p);
  $('sessUser').title = buildUsername(p);
}

document.getElementById('scopeSeg').addEventListener('click', async (e) => {
  const item = e.target.closest('.scope-item');
  if (!item) return;
  const p = activeProfile();
  if (!p) return;
  const res = await send('saveProfile', { profile: { ...p, scope: item.dataset.scope } });
  if (!res.ok) return showAlert($('alertBox'), res.error, 'err');
  // Switching to tab scope with nothing selected would proxy nothing at all,
  // so opt the current tab in automatically.
  if (item.dataset.scope === 'tabs' && currentTab && !tabProxied) {
    const t = await send('setTabProxied', { tabId: currentTab.id, on: true });
    if (t.ok) tabProxied = true;
  }
  await refresh();
});

$('tabSwitch').addEventListener('click', async () => {
  if (!currentTab) return;
  const next = !tabProxied;
  const res = await send('setTabProxied', { tabId: currentTab.id, on: next });
  if (!res.ok) return showAlert($('alertBox'), res.error, 'err');
  tabProxied = res.data.proxied;
  await refresh();
});

$('rotateBtn').addEventListener('click', async () => {
  const btn = $('rotateBtn');
  btn.disabled = true;
  btn.textContent = '…';
  const res = await send('rotateSession');
  btn.disabled = false;
  btn.textContent = 'Rotate';
  await refresh();
  if (!res.ok) showAlert($('alertBox'), res.error, 'err');
  else if (res.data && res.data.geoError) showAlert($('alertBox'), 'New session, but IP lookup failed: ' + res.data.geoError, 'warn');
  else showAlert($('alertBox'), 'New session — exit IP re-pinned.', 'ok');
});

function renderServers() {
  const list = $('serverList');
  list.innerHTML = '';
  $('serverEmpty').hidden = state.profiles.length > 0;

  for (const p of state.profiles) {
    const isActive = p.id === state.activeId;
    const row = document.createElement('div');
    row.className = 'srv' + (isActive ? ' active' : '') + (isActive && state.connected ? ' connected' : '');
    row.innerHTML = `
      <span class="srv-dot"></span>
      <div class="srv-main">
        <div class="srv-name"></div>
        <div class="srv-sub"></div>
      </div>
      <span class="srv-tag"></span>
      <button class="srv-btn edit" title="Edit">✎</button>
      <button class="srv-btn del" title="Delete">✕</button>`;
    row.querySelector('.srv-name').textContent = profileLabel(p);
    row.querySelector('.srv-sub').textContent = `${p.host}:${p.port}${p.username ? ' · ' + p.username : ''}`;
    row.querySelector('.srv-tag').textContent = normalizeScheme(p.scheme).toUpperCase();

    row.addEventListener('click', async (e) => {
      if (e.target.closest('.srv-btn')) return;
      await send('setActive', { id: p.id });
      await refresh();
      showTab('connect');
    });
    row.querySelector('.edit').addEventListener('click', (e) => { e.stopPropagation(); editProfile(p); });
    row.querySelector('.del').addEventListener('click', async (e) => {
      e.stopPropagation();
      await send('deleteProfile', { id: p.id });
      await refresh();
    });
    list.appendChild(row);
  }
}

function showAlert(el, text, kind = 'err') {
  el.textContent = text;
  el.className = 'alert' + (kind === 'warn' ? ' warn' : kind === 'ok' ? ' ok' : '');
  el.hidden = false;
}
function hideAlert(el) { el.hidden = true; }

/* -------------------------------------------------------------- actions */
async function refresh() {
  const res = await send('getState');
  if (res.ok) state = res.data;
  render();
  if (state.connected) startUsageTimer(); else stopUsageTimer();
}

$('resetUsageBtn').addEventListener('click', async () => {
  const res = await send('resetUsage');
  if (res.ok) { state.usage = res.data; renderUsage(); }
});

$('powerBtn').addEventListener('click', async () => {
  const p = activeProfile();
  if (!p || busy) return;
  busy = true;
  hideAlert($('alertBox'));
  render();
  const res = state.connected ? await send('disconnect') : await send('connect', { id: p.id });
  busy = false;
  await refresh();
  if (!res.ok) showAlert($('alertBox'), res.error, 'err');
  else if (res.data && res.data.geoError) showAlert($('alertBox'), 'Connected, but IP lookup failed: ' + res.data.geoError, 'warn');
  else if (res.data && res.data.warnings && res.data.warnings.length) showAlert($('alertBox'), res.data.warnings.join(' · '), 'warn');
});

$('refreshBtn').addEventListener('click', async () => {
  const btn = $('refreshBtn');
  btn.classList.add('spin');
  const res = await send('refreshGeo');
  btn.classList.remove('spin');
  if (res.ok) { state.geo = res.data; renderGeo(); hideAlert($('alertBox')); }
  else showAlert($('alertBox'), res.error, 'err');
});

$('switchBtn').addEventListener('click', () => showTab('servers'));

$('copyBtn').addEventListener('click', async () => {
  const g = state.geo;
  if (!g) return;
  const text = [
    `IP: ${g.ip}`, `City: ${g.city}`, `Region: ${g.region}`,
    `Country: ${g.country} (${g.countryCode})`, `ISP: ${g.isp}`,
    `ASN: ${g.asn}`, `Timezone: ${g.timezone}`,
    g.latitude != null ? `Coords: ${g.latitude}, ${g.longitude}` : ''
  ].filter(Boolean).join('\n');
  await navigator.clipboard.writeText(text);
  $('copyBtn').textContent = 'Copied!';
  setTimeout(() => ($('copyBtn').textContent = 'Copy details'), 1400);
});

$('exportBtn').addEventListener('click', async () => {
  const data = JSON.stringify(state.profiles, null, 2);
  await navigator.clipboard.writeText(data);
  $('exportBtn').textContent = 'Copied to clipboard';
  setTimeout(() => ($('exportBtn').textContent = 'Export JSON'), 1600);
});

/* ----------------------------------------------------------------- form */
const seg = $('schemeSeg');
seg.addEventListener('click', (e) => {
  const item = e.target.closest('.seg-item');
  if (!item) return;
  seg.querySelectorAll('.seg-item').forEach((s) => s.classList.toggle('active', s === item));
});
function currentScheme() {
  const el = seg.querySelector('.seg-item.active');
  return el ? el.dataset.scheme : 'http';
}
function setScheme(scheme) {
  const s = normalizeScheme(scheme);
  seg.querySelectorAll('.seg-item').forEach((el) => el.classList.toggle('active', el.dataset.scheme === s));
}

const fScopeSeg = $('fScopeSeg');
fScopeSeg.addEventListener('click', (e) => {
  const item = e.target.closest('.seg-item');
  if (!item) return;
  fScopeSeg.querySelectorAll('.seg-item').forEach((s) => s.classList.toggle('active', s === item));
});
function formScope() {
  const el = fScopeSeg.querySelector('.seg-item.active');
  return el ? el.dataset.scope : 'all';
}
function setFormScope(scope) {
  const s = normalizeScope(scope);
  fScopeSeg.querySelectorAll('.seg-item').forEach((el) => el.classList.toggle('active', el.dataset.scope === s));
}

/** Show the user the exact username that will hit the gateway. */
function updateUserPreview() {
  const fmt = normalizeSessionFormat($('fSessionFormat').value);
  $('sessionOpts').hidden = fmt === 'none';
  $('customTplWrap').hidden = fmt !== 'custom';
  if (fmt === 'none') { $('userPreview').textContent = ''; return; }
  const sample = buildUsername({
    username: $('fUser').value || 'username',
    sessionFormat: fmt,
    sessionTemplate: $('fSessionTemplate').value,
    sessionCountry: $('fSessionCountry').value,
    sessionId: 'a1b2c3d4'
  });
  $('userPreview').textContent = 'Sends as:  ' + sample;
}
['fSessionFormat', 'fSessionCountry', 'fSessionTemplate', 'fUser'].forEach((id) => {
  $(id).addEventListener('input', updateUserPreview);
  $(id).addEventListener('change', updateUserPreview);
});

$('eyeBtn').addEventListener('click', () => {
  const f = $('fPass');
  f.type = f.type === 'password' ? 'text' : 'password';
});

$('quickBtn').addEventListener('click', () => {
  const parsed = parseProxyLine($('quickInput').value);
  if (!parsed) return showAlert($('formAlert'), 'Could not parse that line.', 'err');
  setScheme(parsed.scheme);
  $('fHost').value = parsed.host;
  $('fPort').value = parsed.port || '';
  $('fUser').value = parsed.username;
  $('fPass').value = parsed.password;
  updateUserPreview();
  showAlert($('formAlert'), 'Parsed — review and save.', 'ok');
});
$('quickInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); $('quickBtn').click(); }
});

function editProfile(p) {
  $('fId').value = p.id;
  $('fName').value = p.name || '';
  setScheme(p.scheme);
  $('fHost').value = p.host;
  $('fPort').value = p.port;
  $('fUser').value = p.username || '';
  $('fPass').value = p.password || '';
  $('fBypass').value = (p.bypassList || []).join(', ');
  setFormScope(p.scope);
  $('fStrictTabs').checked = !!p.strictTabs;
  $('fSessionFormat').value = normalizeSessionFormat(p.sessionFormat);
  $('fSessionCountry').value = p.sessionCountry || '';
  $('fSessionTtl').value = p.sessionTtlMin || '';
  $('fSessionTemplate').value = p.sessionTemplate || '';
  $('fPortRangeStart').value = p.portRangeStart || '';
  $('fPortRangeEnd').value = p.portRangeEnd || '';
  updateUserPreview();
  $('saveBtn').textContent = 'Update & Connect';
  hideAlert($('formAlert'));
  showTab('add');
}

function resetForm() {
  $('addForm').reset();
  $('fId').value = '';
  setScheme('http');
  setFormScope('all');
  $('fSessionFormat').value = 'none';
  updateUserPreview();
  $('saveBtn').textContent = 'Save & Connect';
  hideAlert($('formAlert'));
  document.querySelectorAll('.inp.bad').forEach((i) => i.classList.remove('bad'));
}
$('resetBtn').addEventListener('click', resetForm);

$('addForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  hideAlert($('formAlert'));
  document.querySelectorAll('.inp.bad').forEach((i) => i.classList.remove('bad'));

  const profile = {
    id: $('fId').value || undefined,
    name: $('fName').value,
    scheme: currentScheme(),
    host: $('fHost').value,
    port: $('fPort').value,
    username: $('fUser').value,
    password: $('fPass').value,
    bypassList: $('fBypass').value,
    scope: formScope(),
    strictTabs: $('fStrictTabs').checked,
    sessionFormat: $('fSessionFormat').value,
    sessionTemplate: $('fSessionTemplate').value,
    sessionCountry: $('fSessionCountry').value,
    sessionTtlMin: $('fSessionTtl').value,
    portRangeStart: $('fPortRangeStart').value,
    portRangeEnd: $('fPortRangeEnd').value
  };

  $('saveBtn').disabled = true;
  const saved = await send('saveProfile', { profile });
  $('saveBtn').disabled = false;

  if (!saved.ok) {
    if (/host|server/i.test(saved.error)) $('fHost').classList.add('bad');
    if (/port/i.test(saved.error)) $('fPort').classList.add('bad');
    return showAlert($('formAlert'), saved.error, 'err');
  }

  const id = saved.data.profile.id;
  resetForm();
  await refresh();
  showTab('connect');

  busy = true; render();
  const res = await send('connect', { id });
  busy = false;
  await refresh();
  if (!res.ok) showAlert($('alertBox'), res.error, 'err');
  else if (res.data.geoError) showAlert($('alertBox'), 'Connected, but IP lookup failed: ' + res.data.geoError, 'warn');
  else if (res.data.warnings && res.data.warnings.length) showAlert($('alertBox'), res.data.warnings.join(' · '), 'warn');
});

/* ------------------------------------------------------------------ boot */
/**
 * The popup must know which tab it was opened over. chrome.tabs.query with
 * `active: true, currentWindow: true` returns the popup's OWN page when the
 * popup is opened as a normal tab (as the E2E harness does), so fall back to
 * the last focused normal tab and ignore extension pages.
 */
async function resolveCurrentTab() {
  const isReal = (t) => t && t.url && !t.url.startsWith('chrome-extension://') &&
    !t.url.startsWith('chrome://') && !t.url.startsWith('devtools://');
  try {
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (isReal(active)) return active;
    const all = await chrome.tabs.query({});
    const reals = all.filter(isReal);
    return reals[reals.length - 1] || null;
  } catch (_) {
    return null;
  }
}

async function boot() {
  currentTab = await resolveCurrentTab();
  if (currentTab) {
    const t = await send('getTabState', { tabId: currentTab.id });
    if (t.ok) tabProxied = !!t.data.proxied;
  }
  await refresh();
  updateUserPreview();
  if (!state.profiles.length) showTab('add');
}

chrome.storage.onChanged.addListener(() => { if (!busy) refresh(); });
setInterval(() => { if (!busy && state.connected) renderSession(); }, 1000);
boot();
