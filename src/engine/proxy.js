/**
 * Pure proxy logic. No DOM, no chrome.* — runs under plain Node for tests.
 * Imported by the service worker (type: module) and the popup (type=module).
 */

export const SCHEMES = ['http', 'https', 'socks4', 'socks5'];

export const DEFAULT_BYPASS = ['localhost', '127.0.0.1', '[::1]', '<local>'];

/** Schemes Chrome cannot send credentials for (SOCKS auth is unsupported). */
export const NO_AUTH_SCHEMES = ['socks4', 'socks5'];

export function normalizeScheme(raw) {
  if (!raw) return 'http';
  let s = String(raw).toLowerCase().trim().replace(/:\/\/$/, '').replace(/:$/, '');
  if (s === 'socks') s = 'socks5';
  if (s === 'https-proxy' || s === 'ssl') s = 'https';
  return SCHEMES.includes(s) ? s : 'http';
}

/**
 * Accepts the formats people actually paste:
 *   host:port
 *   host:port:user:pass
 *   user:pass@host:port
 *   scheme://host:port
 *   scheme://user:pass@host:port
 *   host port user pass   (whitespace / comma / pipe separated)
 * Returns a profile object, or null when nothing usable was found.
 */
export function parseProxyLine(line) {
  if (typeof line !== 'string') return null;
  let s = line.trim();
  if (!s) return null;

  let scheme = '';
  const schemeMatch = s.match(/^([a-z0-9+.-]+):\/\//i);
  if (schemeMatch) {
    scheme = normalizeScheme(schemeMatch[1]);
    s = s.slice(schemeMatch[0].length);
  }
  s = s.replace(/\/+$/, '');

  let username = '';
  let password = '';

  const at = s.lastIndexOf('@');
  if (at !== -1) {
    const cred = s.slice(0, at);
    s = s.slice(at + 1);
    const ci = cred.indexOf(':');
    if (ci === -1) {
      username = cred;
    } else {
      username = cred.slice(0, ci);
      password = cred.slice(ci + 1);
    }
  }

  // Remaining host part may still be "host:port:user:pass" or space separated.
  const parts = s.split(/[\s,|]+/).filter(Boolean);
  let hostPart = parts.shift() || '';
  if (parts.length >= 1 && /^\d+$/.test(parts[0]) && !hostPart.includes(':')) {
    hostPart = hostPart + ':' + parts.shift();
  }
  if (!username && parts.length >= 1) username = parts.shift();
  if (!password && parts.length >= 1) password = parts.shift();

  let host = '';
  let port = 0;

  const v6 = hostPart.match(/^\[([^\]]+)\](?::(\d+))?$/);
  if (v6) {
    host = v6[1];
    port = v6[2] ? Number(v6[2]) : 0;
  } else {
    const seg = hostPart.split(':');
    host = seg[0] || '';
    if (seg.length >= 2 && /^\d+$/.test(seg[1])) port = Number(seg[1]);
    if (!username && seg.length >= 3) username = seg[2] || '';
    if (!password && seg.length >= 4) password = seg.slice(3).join(':');
  }

  host = host.trim().toLowerCase();
  if (!host) return null;

  return {
    scheme: scheme || 'http',
    host,
    port,
    username: username || '',
    password: password || ''
  };
}

export function isValidHost(host) {
  if (!host || typeof host !== 'string') return false;
  if (/\s/.test(host)) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    return host.split('.').every((o) => Number(o) >= 0 && Number(o) <= 255);
  }
  if (host.includes(':')) return /^[0-9a-f:]+$/i.test(host); // ipv6 literal
  return /^(?=.{1,253}$)([a-z0-9_](([a-z0-9_-]*)[a-z0-9_])?\.)+[a-z]{2,63}$/i.test(host)
    || /^[a-z0-9_-]+$/i.test(host); // bare hostname (intranet)
}

export function isValidPort(port) {
  const n = Number(port);
  return Number.isInteger(n) && n >= 1 && n <= 65535;
}

/** @returns {{ok:boolean, errors:string[], warnings:string[]}} */
export function validateProfile(profile) {
  const errors = [];
  const warnings = [];
  const p = profile || {};
  if (!isValidHost(p.host)) errors.push('Server address is not valid');
  if (!isValidPort(p.port)) errors.push('Port must be a number between 1 and 65535');
  const scheme = normalizeScheme(p.scheme);
  if (p.username && NO_AUTH_SCHEMES.includes(scheme)) {
    warnings.push('Chrome cannot send username/password to a SOCKS proxy — credentials will be ignored');
  }
  if (p.password && !p.username) warnings.push('Password set without a username');
  return { ok: errors.length === 0, errors, warnings };
}

export function parseBypassList(raw) {
  if (Array.isArray(raw)) raw = raw.join(',');
  if (!raw) return DEFAULT_BYPASS.slice();
  const list = String(raw)
    .split(/[\s,;\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return list.length ? Array.from(new Set(list)) : DEFAULT_BYPASS.slice();
}

/**
 * Build the object for chrome.proxy.settings.set({ value }).
 * Uses fixed_servers so every scheme (incl. socks) is routed through one host.
 */
export function buildProxyConfig(profile, options = {}) {
  const v = validateProfile(profile);
  if (!v.ok) throw new Error(v.errors.join('; '));
  const scheme = normalizeScheme(profile.scheme);
  const bypassList = parseBypassList(options.bypassList ?? profile.bypassList);
  return {
    mode: 'fixed_servers',
    rules: {
      singleProxy: {
        scheme,
        host: String(profile.host).trim(),
        port: Number(profile.port)
      },
      bypassList
    }
  };
}

/* --------------------------------------------- sticky sessions (SSID) */

/**
 * Rotating proxy gateways hold one exit IP per "session id" embedded in the
 * USERNAME. Each provider spells it differently, so a profile stores a base
 * username plus a format, and the real username is assembled at connect time.
 */
export const SESSION_FORMATS = {
  none:        { label: 'None (plain username)', country: '',                session: '',                 sidLen: 8 },
  dataimpulse: { label: 'DataImpulse',           country: '__cr.{cc}',       session: '__sid.{sid}',      sidLen: 8 },
  brightdata:  { label: 'Bright Data',           country: '-country-{cc}',   session: '-session-{sid}',   sidLen: 8 },
  oxylabs:     { label: 'Oxylabs',               country: '-cc-{cc}',        session: '-sessid-{sid}',    sidLen: 10 },
  smartproxy:  { label: 'Smartproxy / Decodo',   country: '-country-{cc}',   session: '-session-{sid}',   sidLen: 10 },
  iproyal:     { label: 'IPRoyal',               country: '_country-{cc}',   session: '_session-{sid}',   sidLen: 8 },
  custom:      { label: 'Custom suffix',         country: '',                session: '',                 sidLen: 8 }
};

export function normalizeSessionFormat(raw) {
  const f = String(raw || 'none').toLowerCase().trim();
  return Object.prototype.hasOwnProperty.call(SESSION_FORMATS, f) ? f : 'none';
}

const SID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** Random lowercase-alnum session id; gateways reject punctuation. */
export function makeSessionId(len = 8, rnd = Math.random) {
  const n = Math.max(4, Math.min(32, Number(len) || 8));
  let out = '';
  for (let i = 0; i < n; i++) out += SID_ALPHABET[Math.floor(rnd() * SID_ALPHABET.length)];
  return out;
}

export function normalizeCountry(raw) {
  const cc = String(raw || '').trim().toLowerCase().replace(/[^a-z]/g, '');
  return /^[a-z]{2}$/.test(cc) ? cc : '';
}

/**
 * The username actually sent to the gateway: base + country part + session
 * part. `custom` uses the profile's own template, where {cc} and {sid} are
 * substituted. Returns the bare username when sessions are off.
 */
export function buildUsername(profile) {
  const p = profile || {};
  const base = String(p.username || '');
  if (!base) return '';
  const fmt = normalizeSessionFormat(p.sessionFormat);
  if (fmt === 'none') return base;

  const cc = normalizeCountry(p.sessionCountry);
  const sid = String(p.sessionId || '');

  if (fmt === 'custom') {
    const tpl = String(p.sessionTemplate || '');
    if (!tpl) return base;
    return base + tpl.replace(/\{cc\}/g, cc).replace(/\{sid\}/g, sid);
  }

  const spec = SESSION_FORMATS[fmt];
  let out = base;
  if (cc && spec.country) out += spec.country.replace('{cc}', cc);
  if (sid && spec.session) out += spec.session.replace('{sid}', sid);
  return out;
}

export function sessionSidLength(format) {
  return SESSION_FORMATS[normalizeSessionFormat(format)].sidLen;
}

/** Has the sticky session outlived its TTL? ttl 0 / missing = never expires. */
export function sessionExpired(profile, now = Date.now()) {
  const p = profile || {};
  const ttl = Number(p.sessionTtlMin) || 0;
  if (ttl <= 0) return false;
  if (!p.sessionStartedAt) return false;
  return now - p.sessionStartedAt >= ttl * 60000;
}

/** Milliseconds until rotation, or null when the session never expires. */
export function sessionRemainingMs(profile, now = Date.now()) {
  const p = profile || {};
  const ttl = Number(p.sessionTtlMin) || 0;
  if (ttl <= 0 || !p.sessionStartedAt) return null;
  return Math.max(0, p.sessionStartedAt + ttl * 60000 - now);
}

/** A fresh sticky session on the same profile (new id, clock restarted). */
export function rotateSession(profile, now = Date.now(), rnd = Math.random) {
  const p = profile || {};
  const fmt = normalizeSessionFormat(p.sessionFormat);
  return {
    ...p,
    sessionFormat: fmt,
    sessionId: fmt === 'none' ? '' : makeSessionId(sessionSidLength(fmt), rnd),
    sessionStartedAt: now
  };
}

/* ------------------------------------------- tab-scoped proxying (PAC) */

export const SCOPES = ['all', 'tabs'];

export function normalizeScope(raw) {
  const s = String(raw || 'all').toLowerCase().trim();
  return SCOPES.includes(s) ? s : 'all';
}

/** "https://WWW.Example.com:443/x" -> "example.com" */
export function hostOf(input) {
  let s = String(input || '').trim().toLowerCase();
  if (!s) return '';
  s = s.replace(/^[a-z0-9+.-]+:\/\//, '');
  s = s.split('/')[0].split('?')[0];
  s = s.replace(/^[^@]*@/, '');
  const v6 = s.match(/^\[([^\]]+)\]/);
  if (v6) return v6[1];
  s = s.split(':')[0];
  return s.replace(/^www\./, '');
}

/** The PAC return value for this profile's protocol. */
export function pacProxyToken(profile) {
  const scheme = normalizeScheme(profile && profile.scheme);
  const hp = `${profile.host}:${Number(profile.port)}`;
  if (scheme === 'socks5') return `SOCKS5 ${hp}; SOCKS ${hp}`;
  if (scheme === 'socks4') return `SOCKS ${hp}`;
  if (scheme === 'https') return `HTTPS ${hp}`;
  return `PROXY ${hp}`;
}

/**
 * Chrome has NO per-tab proxy API, so tab scope is implemented by mapping the
 * hosts currently loaded in proxied tabs into a PAC script. A host opened in a
 * proxied tab goes through the proxy; everything else stays DIRECT.
 *
 * `strict` flips the default: unknown hosts go through the proxy instead of
 * direct. That closes the first-hit gap for a brand-new third-party host in a
 * proxied tab, at the cost of sending other tabs' unknown subresources through
 * the proxy too. Off by default so other tabs really do stay direct.
 */
export function buildPacScript(profile, hosts = [], options = {}) {
  const v = validateProfile(profile);
  if (!v.ok) throw new Error(v.errors.join('; '));

  const token = pacProxyToken(profile);
  const bypass = parseBypassList(options.bypassList ?? profile.bypassList)
    .map((b) => hostOf(b))
    .filter((b) => b && b !== 'local');
  const map = {};
  for (const h of hosts || []) {
    const n = hostOf(h);
    if (n) map[n] = 1;
  }

  return [
    'var P=' + JSON.stringify(token) + ';',
    'var H=' + JSON.stringify(map) + ';',
    'var B=' + JSON.stringify(bypass) + ';',
    'var S=' + (options.strict ? 1 : 0) + ';',
    'function FindProxyForURL(u,host){',
    'var h=(host||"").toLowerCase();',
    'if(h==="localhost"||h==="127.0.0.1"||h==="::1"||h==="[::1]")return "DIRECT";',
    'if(h.indexOf(".")===-1)return "DIRECT";',
    'if(h.substring(0,4)==="www.")h=h.substring(4);',
    'for(var i=0;i<B.length;i++){var b=B[i];',
    'if(h===b)return "DIRECT";',
    'if(h.length>b.length&&h.substring(h.length-b.length-1)==="."+b)return "DIRECT";}',
    'var p=h;',
    'while(p){if(H[p])return P;var d=p.indexOf(".");if(d===-1)break;p=p.substring(d+1);}',
    'return S?P:"DIRECT";}'
  ].join('');
}

export function buildPacConfig(profile, hosts = [], options = {}) {
  return {
    mode: 'pac_script',
    pacScript: { data: buildPacScript(profile, hosts, options), mandatory: true }
  };
}

/** One entry point both modes go through. */
export function buildConfigForScope(profile, scope, hosts = [], options = {}) {
  return normalizeScope(scope) === 'tabs'
    ? buildPacConfig(profile, hosts, options)
    : buildProxyConfig(profile, options);
}

export const DIRECT_CONFIG = { mode: 'direct' };

/**
 * Credentials Chrome should answer an onAuthRequired challenge with.
 * Uses the ASSEMBLED username (base + country + session id) so the gateway
 * pins the exit IP to our sticky session.
 */
export function authCredentialsFor(profile) {
  if (!profile || !profile.username) return null;
  if (NO_AUTH_SCHEMES.includes(normalizeScheme(profile.scheme))) return null;
  return { username: buildUsername(profile), password: profile.password || '' };
}

/** Does this auth challenge belong to our proxy (not a website)? */
export function isOurProxyChallenge(details, profile) {
  if (!details || !details.isProxy) return false;
  if (!profile) return false;
  const host = String(profile.host || '').toLowerCase();
  const chalHost = String(details.challenger?.host || '').toLowerCase();
  if (!chalHost) return true;
  return chalHost === host;
}

export function profileLabel(profile) {
  if (!profile) return 'No proxy';
  const name = (profile.name || '').trim();
  if (name) return name;
  return `${profile.host}:${profile.port}`;
}

export function makeId() {
  return 'p_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

export function sanitizeProfile(input, existing = {}) {
  const p = input || {};
  const scheme = normalizeScheme(p.scheme);
  return {
    id: p.id || existing.id || makeId(),
    name: (p.name || '').toString().slice(0, 40).trim(),
    scheme,
    host: (p.host || '').toString().trim().toLowerCase(),
    port: Number(p.port) || 0,
    username: (p.username || '').toString(),
    password: (p.password || '').toString(),
    bypassList: parseBypassList(p.bypassList),
    scope: normalizeScope(p.scope ?? existing.scope),
    strictTabs: !!(p.strictTabs ?? existing.strictTabs),
    sessionFormat: normalizeSessionFormat(p.sessionFormat ?? existing.sessionFormat),
    sessionTemplate: (p.sessionTemplate ?? existing.sessionTemplate ?? '').toString(),
    sessionCountry: normalizeCountry(p.sessionCountry ?? existing.sessionCountry),
    sessionTtlMin: Math.max(0, Number(p.sessionTtlMin ?? existing.sessionTtlMin) || 0),
    sessionId: (p.sessionId ?? existing.sessionId ?? '').toString(),
    sessionStartedAt: Number(p.sessionStartedAt ?? existing.sessionStartedAt) || 0,
    portRangeStart: Number(p.portRangeStart ?? existing.portRangeStart) || 0,
    portRangeEnd: Number(p.portRangeEnd ?? existing.portRangeEnd) || 0,
    createdAt: existing.createdAt || p.createdAt || Date.now()
  };
}

/** Normalize the several free geo-IP API shapes into one object. */
export function normalizeGeo(raw, source = '') {
  if (!raw || typeof raw !== 'object') return null;
  const pick = (...keys) => {
    for (const k of keys) {
      const val = k.split('.').reduce((o, part) => (o == null ? o : o[part]), raw);
      if (val !== undefined && val !== null && val !== '') return val;
    }
    return '';
  };
  const ip = pick('ip', 'query', 'ipAddress');
  if (!ip) return null;
  const cc = String(pick('country_code', 'countryCode', 'country_code2') || '').toUpperCase();
  return {
    ip: String(ip),
    city: String(pick('city') || ''),
    region: String(pick('region', 'regionName', 'region_name', 'state_prov') || ''),
    country: String(pick('country', 'country_name') || ''),
    countryCode: cc,
    flag: cc ? countryFlag(cc) : '',
    isp: String(pick('connection.isp', 'isp', 'org', 'connection.org', 'asn.name') || ''),
    asn: String(pick('connection.asn', 'as', 'asn.asn') || ''),
    timezone: String(pick('timezone.id', 'timezone', 'time_zone.name') || ''),
    latitude: Number(pick('latitude', 'lat')) || null,
    longitude: Number(pick('longitude', 'lon', 'longitude')) || null,
    postal: String(pick('postal', 'zip', 'postal_code') || ''),
    source
  };
}

export function countryFlag(code) {
  const cc = String(code || '').toUpperCase();
  if (!/^[A-Z]{2}$/.test(cc)) return '';
  return String.fromCodePoint(
    0x1f1e6 + (cc.charCodeAt(0) - 65),
    0x1f1e6 + (cc.charCodeAt(1) - 65)
  );
}

export function geoLine(geo) {
  if (!geo) return '';
  return [geo.city, geo.region, geo.country].filter(Boolean).join(', ');
}

/* ------------------------------------------------------------- usage stats */

/** Human byte size: 0 B, 932 B, 4.7 KB, 1.28 GB. */
export function formatBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  const dp = i === 0 ? 0 : v < 10 ? 2 : v < 100 ? 1 : 0;
  return `${v.toFixed(dp)} ${units[i]}`;
}

/** Elapsed session clock: 0:42, 12:05, 1:03:20. */
export function formatDuration(ms) {
  const total = Math.max(0, Math.floor(Number(ms) / 1000) || 0);
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const pad = (x) => String(x).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export function emptyUsage() {
  return { down: 0, up: 0, requests: 0, startedAt: 0 };
}

/** Bytes a request line + headers cost on the wire (upload estimate). */
export function estimateRequestBytes(details) {
  if (!details) return 0;
  const url = String(details.url || '');
  let n = url.length + 16; // method, version, CRLFs
  const headers = details.requestHeaders;
  if (Array.isArray(headers)) {
    for (const h of headers) n += (h.name || '').length + String(h.value || '').length + 4;
  } else {
    n += 350; // typical browser header block when headers aren't exposed
  }
  if (details.requestBody) n += 512;
  return n;
}

/** Bytes a response cost, preferring the real Content-Length header. */
export function estimateResponseBytes(details) {
  if (!details) return 0;
  let body = null;
  const headers = details.responseHeaders;
  if (Array.isArray(headers)) {
    for (const h of headers) {
      if (String(h.name || '').toLowerCase() === 'content-length') {
        const v = parseInt(h.value, 10);
        if (Number.isFinite(v) && v >= 0) body = v;
        break;
      }
    }
  }
  if (body === null) body = details.fromCache ? 0 : 2048; // chunked/compressed fallback
  let head = 120;
  if (Array.isArray(headers)) {
    head = 40;
    for (const h of headers) head += (h.name || '').length + String(h.value || '').length + 4;
  }
  return body + head;
}

/** Fold one completed request into a usage counter (pure). */
export function addUsage(usage, deltaDown, deltaUp) {
  const u = usage || emptyUsage();
  return {
    down: (u.down || 0) + Math.max(0, deltaDown || 0),
    up: (u.up || 0) + Math.max(0, deltaUp || 0),
    requests: (u.requests || 0) + 1,
    startedAt: u.startedAt || 0
  };
}

/** Average throughput in bytes/sec over the session. */
export function throughput(usage, now = Date.now()) {
  if (!usage || !usage.startedAt) return 0;
  const secs = Math.max(1, (now - usage.startedAt) / 1000);
  return ((usage.down || 0) + (usage.up || 0)) / secs;
}
