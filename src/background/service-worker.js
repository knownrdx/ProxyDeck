/**
 * ProxyDeck service worker.
 * Owns: proxy settings, proxy auth, geo lookup, badge state.
 * The popup is a thin client that talks to this over chrome.runtime.sendMessage.
 */
import {
  buildProxyConfig,
  DIRECT_CONFIG,
  authCredentialsFor,
  isOurProxyChallenge,
  sanitizeProfile,
  validateProfile,
  normalizeGeo,
  makeId,
  normalizeScope,
  normalizeSessionFormat,
  buildConfigForScope,
  buildUsername,
  rotateSession,
  sessionExpired,
  sessionRemainingMs,
  hostOf,
  emptyUsage,
  addUsage,
  estimateRequestBytes,
  estimateResponseBytes
} from '../engine/proxy.js';

const STORE = {
  profiles: 'profiles',
  activeId: 'activeId',
  connected: 'connected',
  geo: 'geo',
  lastError: 'lastError',
  stats: 'stats',
  usage: 'usage'
};

const GEO_PROVIDERS = [
  { url: 'https://ipwho.is/', name: 'ipwho.is' },
  { url: 'https://ipapi.co/json/', name: 'ipapi.co' },
  { url: 'https://get.geojs.io/v1/ip/geo.json', name: 'geojs.io' },
  { url: 'http://ip-api.com/json/?fields=66846719', name: 'ip-api.com' }
];

let activeProfile = null; // cached for the auth handler (sync path, no await)
/**
 * Tab scope: Chrome has no per-tab proxy API, so we keep the set of tab ids the
 * user proxied and the hosts those tabs have loaded, then compile that into a
 * PAC script. Hosts not in the map stay DIRECT, so other tabs are untouched.
 */
const proxiedTabs = new Set();          // tab ids the user switched on
const tabHosts = new Map();             // tabId -> Set(host)
let usage = emptyUsage();  // live byte counters; flushed to storage on a timer
let usageDirty = false;
const pendingUp = new Map(); // requestId -> estimated upload bytes

/* ------------------------------------------------------------------ state */

async function getState() {
  const s = await chrome.storage.local.get(null);
  const profiles = Array.isArray(s.profiles) ? s.profiles : [];
  return {
    profiles,
    activeId: s.activeId || (profiles[0] && profiles[0].id) || null,
    connected: !!s.connected,
    geo: s.geo || null,
    lastError: s.lastError || null,
    stats: s.stats || { connects: 0, lastConnectedAt: null },
    usage: s.usage || emptyUsage(),
    proxiedTabs: Array.from(proxiedTabs)
  };
}

async function findProfile(id) {
  const { profiles } = await getState();
  return profiles.find((p) => p.id === id) || null;
}

async function setBadge(on) {
  const kind = on ? 'on' : 'off';
  try {
    await chrome.action.setIcon({
      path: {
        16: `icons/${kind}-16.png`,
        32: `icons/${kind}-32.png`,
        48: `icons/${kind}-48.png`,
        128: `icons/${kind}-128.png`
      }
    });
  } catch (_) { /* icons optional */ }
  await chrome.action.setBadgeText({ text: on ? 'ON' : '' });
  await chrome.action.setBadgeBackgroundColor({ color: on ? '#16c47f' : '#6b7280' });
}

/* ------------------------------------------------------------ proxy apply */

/** Every host currently loaded in a proxied tab, de-duplicated. */
function proxiedHostList() {
  const out = new Set();
  for (const tabId of proxiedTabs) {
    const hosts = tabHosts.get(tabId);
    if (hosts) for (const h of hosts) out.add(h);
  }
  return Array.from(out);
}

async function applyProxy(profile, scope = profile && profile.scope) {
  const config = normalizeScope(scope) === 'tabs'
    ? buildConfigForScope(profile, 'tabs', proxiedHostList(), { strict: !!profile.strictTabs })
    : buildProxyConfig(profile);
  await new Promise((resolve, reject) => {
    chrome.proxy.settings.set({ value: config, scope: 'regular' }, () => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve();
    });
  });
}

async function clearProxy() {
  await new Promise((resolve) => {
    chrome.proxy.settings.set({ value: DIRECT_CONFIG, scope: 'regular' }, () => {
      void chrome.runtime.lastError;
      resolve();
    });
  });
}

async function levelOfControl() {
  try {
    const cfg = await new Promise((resolve) =>
      chrome.proxy.settings.get({ incognito: false }, resolve)
    );
    return cfg ? cfg.levelOfControl : 'unknown';
  } catch (_) {
    return 'unknown';
  }
}

/* --------------------------------------------------------------- geo/ipinfo */

async function fetchJson(url, timeoutMs = 9000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { cache: 'no-store', signal: ctrl.signal });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function lookupGeo() {
  const errors = [];
  for (const provider of GEO_PROVIDERS) {
    const started = Date.now();
    try {
      const raw = await fetchJson(provider.url);
      if (raw && raw.success === false) throw new Error(raw.message || 'provider said no');
      const geo = normalizeGeo(raw, provider.name);
      if (!geo) throw new Error('unrecognised payload');
      geo.latencyMs = Date.now() - started;
      geo.checkedAt = Date.now();
      return geo;
    } catch (e) {
      errors.push(`${provider.name}: ${e.message}`);
    }
  }
  throw new Error('All geo providers failed — ' + errors.join(' | '));
}

/* ---------------------------------------------------------- usage tracking */

/**
 * Byte counting rides on webRequest, which is the only wire-level signal an
 * MV3 extension gets. Downloads prefer the real Content-Length header and fall
 * back to an estimate for chunked/compressed responses, so the number is
 * "close", not billing-grade — the UI labels it as an estimate.
 *
 * Counters live in memory and are flushed to storage on a 2s alarm, because
 * writing on every request would hammer chrome.storage on a busy page.
 */
function trackingActive() {
  return !!activeProfile;
}

chrome.webRequest.onSendHeaders.addListener(
  (details) => {
    if (!trackingActive()) return;
    pendingUp.set(details.requestId, estimateRequestBytes(details));
  },
  { urls: ['<all_urls>'] },
  ['requestHeaders']
);

chrome.webRequest.onCompleted.addListener(
  (details) => {
    if (!trackingActive()) return;
    const up = pendingUp.get(details.requestId) || estimateRequestBytes(details);
    pendingUp.delete(details.requestId);
    const down = details.fromCache ? 0 : estimateResponseBytes(details);
    usage = addUsage(usage, down, up);
    usageDirty = true;
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders']
);

chrome.webRequest.onErrorOccurred.addListener(
  (details) => { pendingUp.delete(details.requestId); },
  { urls: ['<all_urls>'] }
);

async function flushUsage(force = false) {
  if (!usageDirty && !force) return;
  usageDirty = false;
  await chrome.storage.local.set({ usage });
}

chrome.alarms.create('flush-usage', { periodInMinutes: 1 / 30 }); // ~2s
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'flush-usage') flushUsage();
  else if (a.name === 'session-ttl') checkSessionTtl();
});

/* ------------------------------------------------ tab scope + sessions */

/**
 * Record a host a proxied tab wants, then recompile the PAC if it is new.
 * Called from the navigation listeners AND from the webRequest hook, so a
 * subresource on a third-party host (CDN, API) also gets proxied.
 */
let pacRebuildTimer = null;
function notePacHost(tabId, url) {
  if (!activeProfile || normalizeScope(activeProfile.scope) !== 'tabs') return;
  if (!proxiedTabs.has(tabId)) return;
  const host = hostOf(url);
  if (!host) return;
  let hosts = tabHosts.get(tabId);
  if (!hosts) { hosts = new Set(); tabHosts.set(tabId, hosts); }
  if (hosts.has(host)) return;
  hosts.add(host);
  schedulePacRebuild();
}

/** Coalesce bursts of new hosts into one settings write. */
function schedulePacRebuild() {
  if (pacRebuildTimer) return;
  pacRebuildTimer = setTimeout(async () => {
    pacRebuildTimer = null;
    const st = await getState();
    if (!st.connected || !activeProfile) return;
    if (normalizeScope(activeProfile.scope) !== 'tabs') return;
    try {
      await applyProxy(activeProfile, 'tabs');
      await chrome.storage.local.set({ proxiedTabs: Array.from(proxiedTabs) });
    } catch (e) {
      await chrome.storage.local.set({ lastError: e.message });
    }
  }, 120);
}

chrome.webNavigation.onBeforeNavigate.addListener((d) => {
  if (d.frameId === 0) notePacHost(d.tabId, d.url);
  else notePacHost(d.tabId, d.url);
});
chrome.webNavigation.onCommitted.addListener((d) => notePacHost(d.tabId, d.url));

chrome.webRequest.onBeforeRequest.addListener(
  (d) => { if (d.tabId >= 0) notePacHost(d.tabId, d.url); },
  { urls: ['<all_urls>'] }
);

chrome.tabs.onRemoved.addListener((tabId) => {
  if (proxiedTabs.delete(tabId)) {
    tabHosts.delete(tabId);
    chrome.storage.local.set({ proxiedTabs: Array.from(proxiedTabs) });
    schedulePacRebuild();
  } else {
    tabHosts.delete(tabId);
  }
});

async function setTabProxied(tabId, on) {
  if (!Number.isInteger(tabId) || tabId < 0) throw new Error('Invalid tab id');
  if (on) {
    proxiedTabs.add(tabId);
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab && tab.url) {
        const host = hostOf(tab.url);
        if (host) {
          let hosts = tabHosts.get(tabId);
          if (!hosts) { hosts = new Set(); tabHosts.set(tabId, hosts); }
          hosts.add(host);
        }
      }
    } catch (_) { /* tab may be gone */ }
  } else {
    proxiedTabs.delete(tabId);
    tabHosts.delete(tabId);
  }
  await chrome.storage.local.set({ proxiedTabs: Array.from(proxiedTabs) });
  const st = await getState();
  if (st.connected && activeProfile && normalizeScope(activeProfile.scope) === 'tabs') {
    await applyProxy(activeProfile, 'tabs');
  }
  return { tabId, proxied: proxiedTabs.has(tabId), tabs: Array.from(proxiedTabs) };
}

/**
 * Chrome caches proxy credentials per (proxy host, port, realm) and keeps
 * reusing them for the life of the network session. Calling
 * proxy.settings.set() again with a new username does NOT re-trigger
 * onAuthRequired, so a rotated session id never reaches the gateway and the
 * exit IP stays pinned to the OLD session. (Verified: switching the session
 * country us -> gb left the exit IP in the US.)
 *
 * The reliable fix is to make the gateway see a DIFFERENT proxy origin, so
 * Chrome's cache key (scheme, host, port) misses and it must ask us again.
 * Rotating gateways accept the same credentials on a range of ports, but we
 * cannot assume that — so instead we cycle the proxy through DIRECT, clear
 * every cache Chrome will let an extension clear, and wait out the socket
 * pool's idle teardown before re-applying.
 */
async function flushProxyAuthCache() {
  await new Promise((resolve) => {
    chrome.proxy.settings.set({ value: DIRECT_CONFIG, scope: 'regular' }, () => {
      void chrome.runtime.lastError;
      resolve();
    });
  });
  // Chrome keeps proxy sockets alive in a pool and replays the cached
  // credentials on them. browsingData.remove() drops the HTTP auth cache;
  // the wait lets the pooled sockets actually finish tearing down. 400ms was
  // not enough in practice — a rotation would intermittently keep the old
  // exit IP — so give it a full second.
  try {
    await chrome.browsingData.remove({ since: 0 }, { cache: true, cacheStorage: true });
  } catch (_) { /* permission is optional */ }
  await new Promise((r) => setTimeout(r, 1000));
}

/**
 * Sticky sessions where the gateway supports it: many rotating providers
 * accept the SAME credentials on a block of ports and treat each port as an
 * independent session slot. When a profile declares a port range we hop to the
 * next port on rotation, which changes Chrome's auth-cache key (host:port) and
 * therefore forces a fresh onAuthRequired with the new username.
 */
function nextSessionPort(profile) {
  const lo = Number(profile.portRangeStart) || 0;
  const hi = Number(profile.portRangeEnd) || 0;
  if (!lo || !hi || hi <= lo) return Number(profile.port);
  const cur = Number(profile.port);
  const next = cur >= hi || cur < lo ? lo : cur + 1;
  return next;
}

/** Swap in a brand new sticky session id and re-pin the exit IP. */
async function rotateActiveSession() {
  const st = await getState();
  if (!st.activeId) throw new Error('No active profile');
  const current = await findProfile(st.activeId);
  if (!current) throw new Error('Profile not found');

  const rotated = rotateSession(current);
  rotated.port = nextSessionPort(current);
  const profiles = st.profiles.map((p) => (p.id === rotated.id ? rotated : p));
  await chrome.storage.local.set({ profiles });

  if (st.connected) {
    activeProfile = rotated;
    await flushProxyAuthCache();     // MUST happen before re-applying
    await applyProxy(rotated);
    await chrome.storage.local.set({ geo: null });
    try {
      const geo = await lookupGeo();
      await chrome.storage.local.set({ geo, lastError: null });
      return { profile: rotated, geo };
    } catch (e) {
      await chrome.storage.local.set({ lastError: e.message });
      return { profile: rotated, geo: null, geoError: e.message };
    }
  }
  return { profile: rotated, geo: null };
}

/** TTL watchdog: rotate automatically when the sticky session ages out. */
chrome.alarms.create('session-ttl', { periodInMinutes: 0.5 });
async function checkSessionTtl() {
  if (!activeProfile) return;
  const st = await getState();
  if (!st.connected) return;
  if (!sessionExpired(activeProfile)) return;
  try {
    await rotateActiveSession();
  } catch (e) {
    await chrome.storage.local.set({ lastError: 'Auto-rotate failed: ' + e.message });
  }
}

/* ------------------------------------------------------------- connect flow */

async function connect(profileId) {
  const stored = await findProfile(profileId);
  if (!stored) throw new Error('Profile not found');
  const v = validateProfile(stored);
  if (!v.ok) throw new Error(v.errors.join('; '));

  const control = await levelOfControl();
  if (control === 'controlled_by_other_extensions') {
    throw new Error('Another extension controls the proxy settings. Disable it first.');
  }

  const prev = await getState();

  // A sticky-session profile needs a live session id before the first request,
  // otherwise the gateway hands out a fresh exit IP per connection.
  // NOTE: `profile` must be a NEW binding, not a reassignment of `stored` —
  // assigning to a const throws "Assignment to constant variable" inside the
  // worker, which surfaces as a generic connect failure with no proxy applied.
  let profile = stored;
  if (normalizeSessionFormat(profile.sessionFormat) !== 'none' &&
      (!profile.sessionId || sessionExpired(profile))) {
    profile = rotateSession(profile);
    const profiles = prev.profiles.map((x) => (x.id === profile.id ? profile : x));
    await chrome.storage.local.set({ profiles });
  }

  activeProfile = profile;
  usage = { down: 0, up: 0, requests: 0, startedAt: Date.now() };
  pendingUp.clear();
  usageDirty = false;
  await applyProxy(profile);
  await chrome.storage.local.set({
    connected: true,
    activeId: profile.id,
    lastError: null,
    geo: null,
    usage,
    stats: {
      connects: (prev.stats.connects || 0) + 1,
      lastConnectedAt: Date.now()
    }
  });
  await setBadge(true);

  let geo = null;
  let geoError = null;
  try {
    geo = await lookupGeo();
    await chrome.storage.local.set({ geo });
  } catch (e) {
    geoError = e.message;
    await chrome.storage.local.set({ lastError: geoError });
  }
  return { connected: true, geo, geoError, warnings: v.warnings };
}

async function disconnect() {
  await clearProxy();
  activeProfile = null;
  pendingUp.clear();
  proxiedTabs.clear();
  tabHosts.clear();
  await chrome.storage.local.set({ proxiedTabs: [] });
  const finalUsage = { ...usage };            // freeze the session total
  usage = emptyUsage();
  usageDirty = false;
  await chrome.storage.local.set({
    connected: false, geo: null, lastError: null, usage: finalUsage
  });
  await setBadge(false);
  return { connected: false, usage: finalUsage };
}

/** Geo for the current route (proxy if on, real IP if off). */
async function refreshGeo() {
  const geo = await lookupGeo();
  const st = await getState();
  if (st.connected) await chrome.storage.local.set({ geo, lastError: null });
  return geo;
}

/* -------------------------------------------------------------- proxy auth */

chrome.webRequest.onAuthRequired.addListener(
  (details, callback) => {
    const done = (result) => {
      if (typeof callback === 'function') callback(result || {});
    };
    if (!activeProfile || !isOurProxyChallenge(details, activeProfile)) return done({});
    const creds = authCredentialsFor(activeProfile);
    if (!creds) return done({});
    done({ authCredentials: creds });
  },
  { urls: ['<all_urls>'] },
  ['asyncBlocking']
);

chrome.proxy.onProxyError.addListener((details) => {
  chrome.storage.local.set({
    lastError: `Proxy error: ${details.error}${details.details ? ' — ' + details.details : ''}`
  });
});

/* ------------------------------------------------------------- persistence */

async function saveProfile(input) {
  const st = await getState();
  const existing = st.profiles.find((p) => p.id === input.id) || {};
  const profile = sanitizeProfile(input, existing);
  const v = validateProfile(profile);
  if (!v.ok) throw new Error(v.errors.join('; '));
  const profiles = st.profiles.some((p) => p.id === profile.id)
    ? st.profiles.map((p) => (p.id === profile.id ? profile : p))
    : st.profiles.concat([profile]);
  await chrome.storage.local.set({ profiles, activeId: profile.id });
  if (st.connected && st.activeId === profile.id) {
    // Anything that changes the credentials on the wire needs the cached
    // proxy login dropped, or Chrome keeps replaying the old username and the
    // edit silently has no effect on the exit IP.
    const credsChanged =
      existing.username !== profile.username ||
      existing.password !== profile.password ||
      existing.sessionFormat !== profile.sessionFormat ||
      existing.sessionCountry !== profile.sessionCountry ||
      existing.sessionTemplate !== profile.sessionTemplate ||
      Number(existing.port) !== Number(profile.port) ||
      existing.host !== profile.host;
    activeProfile = profile;
    if (credsChanged) await flushProxyAuthCache();
    await applyProxy(profile);
  }
  return { profile, warnings: v.warnings };
}

async function deleteProfile(id) {
  const st = await getState();
  const profiles = st.profiles.filter((p) => p.id !== id);
  const patch = { profiles };
  if (st.activeId === id) {
    patch.activeId = profiles[0] ? profiles[0].id : null;
    if (st.connected) await disconnect();
  }
  await chrome.storage.local.set(patch);
  return { profiles };
}

async function importProfiles(list) {
  const st = await getState();
  const added = list.map((p) => sanitizeProfile({ ...p, id: makeId() }));
  const valid = added.filter((p) => validateProfile(p).ok);
  const profiles = st.profiles.concat(valid);
  await chrome.storage.local.set({ profiles });
  return { added: valid.length, skipped: added.length - valid.length, profiles };
}

/* ------------------------------------------------------------- message bus */

const HANDLERS = {
  getState: () => getState(),
  connect: (msg) => connect(msg.id),
  disconnect: () => disconnect(),
  refreshGeo: () => refreshGeo(),
  saveProfile: (msg) => saveProfile(msg.profile),
  deleteProfile: (msg) => deleteProfile(msg.id),
  importProfiles: (msg) => importProfiles(msg.profiles || []),
  setActive: async (msg) => {
    await chrome.storage.local.set({ activeId: msg.id });
    return getState();
  },
  levelOfControl: () => levelOfControl(),
  setTabProxied: (msg) => setTabProxied(msg.tabId, !!msg.on),
  getTabState: async (msg) => {
    const st = await getState();
    const profile = await findProfile(st.activeId);
    return {
      tabId: msg.tabId,
      proxied: proxiedTabs.has(msg.tabId),
      proxiedTabs: Array.from(proxiedTabs),
      scope: normalizeScope(profile && profile.scope),
      hosts: proxiedHostList()
    };
  },
  rotateSession: () => rotateActiveSession(),
  sessionInfo: async () => {
    const st = await getState();
    const profile = await findProfile(st.activeId);
    if (!profile) return null;
    return {
      format: normalizeSessionFormat(profile.sessionFormat),
      sessionId: profile.sessionId || '',
      username: buildUsername(profile),
      country: profile.sessionCountry || '',
      ttlMin: Number(profile.sessionTtlMin) || 0,
      startedAt: profile.sessionStartedAt || 0,
      remainingMs: sessionRemainingMs(profile),
      expired: sessionExpired(profile)
    };
  },
  getUsage: async () => {
    await flushUsage(true);
    return usage;
  },
  resetUsage: async () => {
    usage = { down: 0, up: 0, requests: 0, startedAt: activeProfile ? Date.now() : 0 };
    pendingUp.clear();
    await chrome.storage.local.set({ usage });
    return usage;
  }
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const handler = HANDLERS[msg && msg.type];
  if (!handler) {
    sendResponse({ ok: false, error: 'Unknown message: ' + (msg && msg.type) });
    return false;
  }
  Promise.resolve(handler(msg))
    .then((data) => sendResponse({ ok: true, data }))
    .catch((e) => sendResponse({ ok: false, error: e.message || String(e) }));
  return true; // async
});

/* ----------------------------------------------------------- lifecycle sync */

async function rehydrate() {
  const st = await getState();
  if (st.connected && st.activeId) {
    const profile = await findProfile(st.activeId);
    if (profile) {
      activeProfile = profile;
      usage = st.usage && st.usage.startedAt ? st.usage : { ...emptyUsage(), startedAt: Date.now() };
      const saved = (await chrome.storage.local.get('proxiedTabs')).proxiedTabs;
      if (Array.isArray(saved)) {
        // Only keep tab ids that still exist; ids are not stable across restarts.
        const alive = await chrome.tabs.query({});
        const aliveIds = new Set(alive.map((t) => t.id));
        for (const id of saved) if (aliveIds.has(id)) proxiedTabs.add(id);
        for (const t of alive) {
          if (proxiedTabs.has(t.id) && t.url) {
            const h = hostOf(t.url);
            if (h) tabHosts.set(t.id, new Set([h]));
          }
        }
      }
      try {
        await applyProxy(profile);
        await setBadge(true);
        return;
      } catch (e) {
        await chrome.storage.local.set({ lastError: e.message });
      }
    }
  }
  await setBadge(false);
}

chrome.runtime.onStartup.addListener(rehydrate);
chrome.runtime.onInstalled.addListener(rehydrate);
rehydrate();
