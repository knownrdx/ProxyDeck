import {
  parseProxyLine, normalizeScheme, isValidHost, isValidPort, validateProfile,
  buildProxyConfig, parseBypassList, normalizeGeo, countryFlag, geoLine,
  authCredentialsFor, isOurProxyChallenge, sanitizeProfile, profileLabel, DEFAULT_BYPASS,
  formatBytes, formatDuration, emptyUsage, addUsage, estimateRequestBytes,
  estimateResponseBytes, throughput,
  normalizeScope, hostOf, pacProxyToken, buildPacScript, buildPacConfig,
  buildConfigForScope, normalizeSessionFormat, normalizeCountry, makeSessionId,
  buildUsername, sessionExpired, sessionRemainingMs, rotateSession,
  sessionSidLength, SESSION_FORMATS
} from '../src/engine/proxy.js';

let pass = 0, fail = 0;
const failures = [];
function ok(cond, label) {
  if (cond) { pass++; } else { fail++; failures.push(label); }
}
function eq(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) pass++;
  else { fail++; failures.push(`${label}\n    expected ${e}\n    actual   ${a}`); }
}

/* ---------------------------------------------------------------- parsing */
eq(parseProxyLine('1.2.3.4:8080'), { scheme: 'http', host: '1.2.3.4', port: 8080, username: '', password: '' }, 'host:port');
eq(parseProxyLine('gw.dataimpulse.com:824'), { scheme: 'http', host: 'gw.dataimpulse.com', port: 824, username: '', password: '' }, 'domain:port');
eq(parseProxyLine('1.2.3.4:8080:bob:secret'), { scheme: 'http', host: '1.2.3.4', port: 8080, username: 'bob', password: 'secret' }, 'host:port:user:pass');
eq(parseProxyLine('bob:secret@1.2.3.4:8080'), { scheme: 'http', host: '1.2.3.4', port: 8080, username: 'bob', password: 'secret' }, 'user:pass@host:port');
eq(parseProxyLine('socks5://bob:secret@1.2.3.4:1080'), { scheme: 'socks5', host: '1.2.3.4', port: 1080, username: 'bob', password: 'secret' }, 'scheme://user:pass@host:port');
eq(parseProxyLine('HTTPS://Proxy.Example.COM:3128'), { scheme: 'https', host: 'proxy.example.com', port: 3128, username: '', password: '' }, 'uppercase normalised');
eq(parseProxyLine('1.2.3.4 8080 bob secret'), { scheme: 'http', host: '1.2.3.4', port: 8080, username: 'bob', password: 'secret' }, 'space separated');
eq(parseProxyLine('1.2.3.4,8080,bob,secret'), { scheme: 'http', host: '1.2.3.4', port: 8080, username: 'bob', password: 'secret' }, 'comma separated');
eq(parseProxyLine('http://1.2.3.4:8080/'), { scheme: 'http', host: '1.2.3.4', port: 8080, username: '', password: '' }, 'trailing slash stripped');
eq(parseProxyLine('[2001:db8::1]:8080').host, '2001:db8::1', 'ipv6 host');
eq(parseProxyLine('[2001:db8::1]:8080').port, 8080, 'ipv6 port');
eq(parseProxyLine('user:p@ss:word@1.2.3.4:8080').password, 'p@ss:word', 'password with @ and : survives');
eq(parseProxyLine('socks://1.2.3.4:1080').scheme, 'socks5', 'socks alias -> socks5');
ok(parseProxyLine('') === null, 'empty line -> null');
ok(parseProxyLine('   ') === null, 'whitespace -> null');
ok(parseProxyLine(null) === null, 'null -> null');
ok(parseProxyLine(42) === null, 'number -> null');

/* ---------------------------------------------------------------- schemes */
eq(normalizeScheme('HTTP'), 'http', 'scheme upper');
eq(normalizeScheme('https://'), 'https', 'scheme with ://');
eq(normalizeScheme('ftp'), 'http', 'unknown scheme falls back to http');
eq(normalizeScheme(undefined), 'http', 'undefined scheme -> http');
eq(normalizeScheme('socks4'), 'socks4', 'socks4 kept');

/* -------------------------------------------------------------- validation */
ok(isValidHost('1.2.3.4'), 'ipv4 valid');
ok(!isValidHost('999.1.1.1'), 'octet > 255 rejected');
ok(isValidHost('gw.dataimpulse.com'), 'domain valid');
ok(!isValidHost('has space.com'), 'space rejected');
ok(!isValidHost(''), 'empty host rejected');
ok(isValidPort(1) && isValidPort(65535), 'port bounds ok');
ok(!isValidPort(0) && !isValidPort(65536) && !isValidPort('abc'), 'bad ports rejected');

const good = { scheme: 'http', host: '1.2.3.4', port: 8080, username: 'a', password: 'b' };
ok(validateProfile(good).ok, 'good profile validates');
ok(!validateProfile({ host: 'x y', port: 80 }).ok, 'bad host fails validation');
ok(!validateProfile({ host: '1.2.3.4', port: 0 }).ok, 'bad port fails validation');
ok(validateProfile({ scheme: 'socks5', host: '1.2.3.4', port: 1080, username: 'a' }).warnings.length === 1, 'socks+auth warns');
ok(validateProfile({ scheme: 'http', host: '1.2.3.4', port: 80, password: 'x' }).warnings.length === 1, 'password without user warns');

/* ------------------------------------------------------------ chrome config */
eq(buildProxyConfig(good).mode, 'fixed_servers', 'mode fixed_servers');
eq(buildProxyConfig(good).rules.singleProxy, { scheme: 'http', host: '1.2.3.4', port: 8080 }, 'singleProxy shape');
eq(buildProxyConfig(good).rules.bypassList, DEFAULT_BYPASS, 'default bypass applied');
eq(buildProxyConfig(good, { bypassList: 'a.com, b.com' }).rules.bypassList, ['a.com', 'b.com'], 'custom bypass parsed');
ok(buildProxyConfig({ ...good, port: '8080' }).rules.singleProxy.port === 8080, 'string port coerced to number');
let threw = false;
try { buildProxyConfig({ host: '', port: 1 }); } catch (_) { threw = true; }
ok(threw, 'invalid profile throws');
eq(parseBypassList(''), DEFAULT_BYPASS, 'empty bypass -> defaults');
eq(parseBypassList('x.com\ny.com  z.com'), ['x.com', 'y.com', 'z.com'], 'bypass multi-separator');
eq(parseBypassList('a.com,a.com'), ['a.com'], 'bypass dedupes');

/* -------------------------------------------------------------------- auth */
eq(authCredentialsFor(good), { username: 'a', password: 'b' }, 'http creds returned');
ok(authCredentialsFor({ scheme: 'socks5', host: 'h', port: 1, username: 'a', password: 'b' }) === null, 'socks creds suppressed');
ok(authCredentialsFor({ scheme: 'http', host: 'h', port: 1 }) === null, 'no username -> no creds');
ok(isOurProxyChallenge({ isProxy: true, challenger: { host: '1.2.3.4' } }, good), 'our proxy challenge matched');
ok(!isOurProxyChallenge({ isProxy: false, challenger: { host: '1.2.3.4' } }, good), 'site auth ignored');
ok(!isOurProxyChallenge({ isProxy: true, challenger: { host: 'evil.com' } }, good), 'other proxy host ignored');
ok(!isOurProxyChallenge({ isProxy: true }, null), 'no profile -> no creds');

/* --------------------------------------------------------------------- geo */
const ipwho = normalizeGeo({
  ip: '102.89.1.1', city: 'Lagos', region: 'Lagos', country: 'Nigeria', country_code: 'NG',
  connection: { isp: 'MTN Nigeria', asn: 29465 }, timezone: { id: 'Africa/Lagos' }, latitude: 6.5, longitude: 3.3
}, 'ipwho.is');
eq(ipwho.city, 'Lagos', 'ipwho city');
eq(ipwho.isp, 'MTN Nigeria', 'ipwho nested isp');
eq(ipwho.timezone, 'Africa/Lagos', 'ipwho nested timezone');
eq(ipwho.countryCode, 'NG', 'ipwho country code');
eq(ipwho.flag, '🇳🇬', 'flag emoji from code');

const ipapi = normalizeGeo({ query: '8.8.8.8', city: 'Ashburn', regionName: 'Virginia', country: 'United States', countryCode: 'us', isp: 'Google LLC', timezone: 'America/New_York', lat: 39, lon: -77 }, 'ip-api.com');
eq(ipapi.ip, '8.8.8.8', 'ip-api query -> ip');
eq(ipapi.region, 'Virginia', 'ip-api regionName -> region');
eq(ipapi.countryCode, 'US', 'lowercase country code upcased');
ok(normalizeGeo({ city: 'Nowhere' }) === null, 'payload without ip -> null');
ok(normalizeGeo(null) === null, 'null geo -> null');
eq(countryFlag('bd'), '🇧🇩', 'lowercase cc flag');
eq(countryFlag('XYZ'), '', 'bad cc -> empty flag');
eq(geoLine(ipwho), 'Lagos, Lagos, Nigeria', 'geo line join');
eq(geoLine(normalizeGeo({ ip: '1.1.1.1', country: 'Australia' })), 'Australia', 'geo line skips blanks');

/* ---------------------------------------------------------------- profiles */
const s1 = sanitizeProfile({ host: ' 1.2.3.4 ', port: '8080', scheme: 'SOCKS5' });
eq(s1.host, '1.2.3.4', 'sanitize trims host');
eq(s1.port, 8080, 'sanitize numbers port');
eq(s1.scheme, 'socks5', 'sanitize normalises scheme');
ok(typeof s1.id === 'string' && s1.id.length > 3, 'sanitize assigns id');
eq(sanitizeProfile({ id: 'keep', host: 'a.com', port: 1 }, { id: 'keep', createdAt: 5 }).createdAt, 5, 'createdAt preserved');
eq(profileLabel({ name: 'US Res', host: 'a', port: 1 }), 'US Res', 'label uses name');
eq(profileLabel({ name: '  ', host: 'a.com', port: 80 }), 'a.com:80', 'label falls back to host:port');
eq(profileLabel(null), 'No proxy', 'null label');

/* ------------------------------------------------------------ usage stats */
eq(formatBytes(0), '0 B', 'zero bytes');
eq(formatBytes(-5), '0 B', 'negative bytes clamped');
eq(formatBytes(NaN), '0 B', 'NaN bytes');
eq(formatBytes(932), '932 B', 'bytes no decimals');
eq(formatBytes(1024), '1.00 KB', 'exact KB');
eq(formatBytes(1536), '1.50 KB', 'KB two decimals under 10');
eq(formatBytes(52428800), '50.0 MB', 'MB one decimal under 100');
eq(formatBytes(1024 * 1024 * 1024 * 1.28), '1.28 GB', 'GB');
eq(formatBytes(1024 ** 5), '1024 TB', 'caps at TB');

eq(formatDuration(0), '0:00', 'zero duration');
eq(formatDuration(42000), '0:42', 'seconds');
eq(formatDuration(725000), '12:05', 'minutes:seconds');
eq(formatDuration(3800000), '1:03:20', 'hours:minutes:seconds');
eq(formatDuration(-100), '0:00', 'negative duration clamped');

eq(emptyUsage(), { down: 0, up: 0, requests: 0, startedAt: 0 }, 'empty usage shape');
eq(addUsage(emptyUsage(), 100, 50), { down: 100, up: 50, requests: 1, startedAt: 0 }, 'first request counted');
eq(addUsage({ down: 10, up: 5, requests: 2, startedAt: 7 }, 90, 15),
   { down: 100, up: 20, requests: 3, startedAt: 7 }, 'usage accumulates, startedAt kept');
eq(addUsage(emptyUsage(), -50, -10), { down: 0, up: 0, requests: 1, startedAt: 0 }, 'negative deltas clamped');
eq(addUsage(null, 5, 5).requests, 1, 'null usage tolerated');

eq(estimateResponseBytes({ responseHeaders: [{ name: 'Content-Length', value: '4096' }] }), 4096 + 40 + 'Content-Length'.length + 4 + 4, 'content-length used');
eq(estimateResponseBytes({ responseHeaders: [{ name: 'content-length', value: '100' }] }) > 100, true, 'lowercase header matched');
eq(estimateResponseBytes({ fromCache: true, responseHeaders: [] }), 40, 'cached response body is 0');
ok(estimateResponseBytes({ responseHeaders: [{ name: 'Transfer-Encoding', value: 'chunked' }] }) > 2000, 'chunked falls back to estimate');
ok(estimateResponseBytes(null) === 0, 'null response -> 0');
ok(estimateRequestBytes({ url: 'https://example.com/a' }) > 300, 'request without headers estimates a header block');
ok(estimateRequestBytes({ url: 'https://example.com/a', requestHeaders: [{ name: 'Host', value: 'example.com' }] }) < 100, 'request with real headers is exact-ish');
ok(estimateRequestBytes(null) === 0, 'null request -> 0');

eq(throughput({ down: 1000, up: 0, startedAt: Date.now() - 10000 }) > 90, true, 'throughput ~100 B/s');
eq(throughput(emptyUsage()), 0, 'no startedAt -> no throughput');
eq(throughput(null), 0, 'null usage -> 0 throughput');

/* ---------------------------------------------------- sticky sessions */
eq(normalizeSessionFormat('DataImpulse'), 'dataimpulse', 'format lowercased');
eq(normalizeSessionFormat('nonsense'), 'none', 'unknown format -> none');
eq(normalizeSessionFormat(undefined), 'none', 'undefined format -> none');
ok(Object.keys(SESSION_FORMATS).length >= 6, 'several providers supported');

eq(normalizeCountry('US'), 'us', 'country lowercased');
eq(normalizeCountry(' bd '), 'bd', 'country trimmed');
eq(normalizeCountry('usa'), '', 'three letters rejected');
eq(normalizeCountry(''), '', 'empty country');

const seq = (() => { let i = 0; const vals = [0, 0.5, 0.99, 0.2, 0.7, 0.1, 0.4, 0.8]; return () => vals[i++ % vals.length]; })();
const sid = makeSessionId(8, seq);
eq(sid.length, 8, 'session id length honoured');
ok(/^[a-z0-9]+$/.test(sid), 'session id is lowercase alnum only');
eq(makeSessionId(2).length, 4, 'session id min length 4');
eq(makeSessionId(999).length, 32, 'session id max length 32');
ok(makeSessionId() !== makeSessionId(), 'session ids differ');

const di = { username: 'user123', sessionFormat: 'dataimpulse', sessionCountry: 'us', sessionId: 'abc12345' };
eq(buildUsername(di), 'user123__cr.us__sid.abc12345', 'dataimpulse username assembled');
eq(buildUsername({ ...di, sessionCountry: '' }), 'user123__sid.abc12345', 'no country -> only session part');
eq(buildUsername({ ...di, sessionId: '' }), 'user123__cr.us', 'no sid -> only country part');
eq(buildUsername({ ...di, sessionFormat: 'none' }), 'user123', 'format none -> bare username');
eq(buildUsername({ ...di, sessionFormat: 'brightdata' }), 'user123-country-us-session-abc12345', 'brightdata format');
eq(buildUsername({ ...di, sessionFormat: 'oxylabs' }), 'user123-cc-us-sessid-abc12345', 'oxylabs format');
eq(buildUsername({ ...di, sessionFormat: 'smartproxy' }), 'user123-country-us-session-abc12345', 'smartproxy format');
eq(buildUsername({ ...di, sessionFormat: 'iproyal' }), 'user123_country-us_session-abc12345', 'iproyal format');
eq(buildUsername({ ...di, sessionFormat: 'custom', sessionTemplate: '-zone-{cc}-sess-{sid}' }),
   'user123-zone-us-sess-abc12345', 'custom template substituted');
eq(buildUsername({ ...di, sessionFormat: 'custom', sessionTemplate: '' }), 'user123', 'empty custom template -> base');
eq(buildUsername({ username: '' }), '', 'no username -> empty');
eq(buildUsername(null), '', 'null profile -> empty username');

eq(sessionSidLength('oxylabs'), 10, 'oxylabs uses longer sid');
eq(sessionSidLength('dataimpulse'), 8, 'dataimpulse sid length');

const now = 1_700_000_000_000;
ok(!sessionExpired({ sessionTtlMin: 0, sessionStartedAt: now - 99999999 }, now), 'ttl 0 never expires');
ok(!sessionExpired({ sessionTtlMin: 10, sessionStartedAt: 0 }, now), 'no start time -> not expired');
ok(!sessionExpired({ sessionTtlMin: 10, sessionStartedAt: now - 9 * 60000 }, now), 'inside ttl');
ok(sessionExpired({ sessionTtlMin: 10, sessionStartedAt: now - 10 * 60000 }, now), 'exactly at ttl expires');
ok(sessionExpired({ sessionTtlMin: 10, sessionStartedAt: now - 60 * 60000 }, now), 'well past ttl');
ok(sessionRemainingMs({ sessionTtlMin: 0 }, now) === null, 'ttl 0 -> null remaining');
eq(sessionRemainingMs({ sessionTtlMin: 10, sessionStartedAt: now - 4 * 60000 }, now), 6 * 60000, 'remaining ms');
eq(sessionRemainingMs({ sessionTtlMin: 10, sessionStartedAt: now - 99 * 60000 }, now), 0, 'remaining never negative');

const rot = rotateSession({ username: 'u', sessionFormat: 'dataimpulse', sessionId: 'old', sessionStartedAt: 1 }, now, seq);
ok(rot.sessionId !== 'old' && rot.sessionId.length === 8, 'rotate makes a new id');
eq(rot.sessionStartedAt, now, 'rotate restarts the clock');
eq(rot.username, 'u', 'rotate keeps the base username');
eq(rotateSession({ sessionFormat: 'none' }, now).sessionId, '', 'rotate on format none leaves id empty');

// the wire username is what auth must send
eq(authCredentialsFor({ scheme: 'http', host: 'h', port: 1, password: 'p', ...di }).username,
   'user123__cr.us__sid.abc12345', 'auth sends the session username');

/* ------------------------------------------------- tab scope / PAC */
eq(normalizeScope('TABS'), 'tabs', 'scope lowercased');
eq(normalizeScope('bogus'), 'all', 'unknown scope -> all');
eq(normalizeScope(undefined), 'all', 'default scope is all');

eq(hostOf('https://WWW.Example.com:443/a/b?q=1'), 'example.com', 'host normalised');
eq(hostOf('http://user:pw@site.org/x'), 'site.org', 'credentials stripped from host');
eq(hostOf('sub.example.com'), 'sub.example.com', 'subdomain kept');
eq(hostOf('[2001:db8::1]:8080'), '2001:db8::1', 'ipv6 host');
eq(hostOf(''), '', 'empty host');
eq(hostOf(null), '', 'null host');

const pacProfile = { scheme: 'http', host: '1.2.3.4', port: 8080 };
eq(pacProxyToken(pacProfile), 'PROXY 1.2.3.4:8080', 'http -> PROXY');
eq(pacProxyToken({ ...pacProfile, scheme: 'https' }), 'HTTPS 1.2.3.4:8080', 'https -> HTTPS');
eq(pacProxyToken({ ...pacProfile, scheme: 'socks5' }), 'SOCKS5 1.2.3.4:8080; SOCKS 1.2.3.4:8080', 'socks5 with fallback');
eq(pacProxyToken({ ...pacProfile, scheme: 'socks4' }), 'SOCKS 1.2.3.4:8080', 'socks4 -> SOCKS');

// run the generated PAC the way Chrome would
function runPac(profile, hosts, opts, host) {
  const src = buildPacScript(profile, hosts, opts);
  // eslint-disable-next-line no-new-func
  const fn = new Function(src + '; return FindProxyForURL;')();
  return fn('http://' + host + '/', host);
}
eq(runPac(pacProfile, ['example.com'], {}, 'example.com'), 'PROXY 1.2.3.4:8080', 'listed host is proxied');
eq(runPac(pacProfile, ['example.com'], {}, 'other.com'), 'DIRECT', 'unlisted host stays DIRECT');
eq(runPac(pacProfile, ['example.com'], {}, 'www.example.com'), 'PROXY 1.2.3.4:8080', 'www prefix matches');
eq(runPac(pacProfile, ['example.com'], {}, 'cdn.example.com'), 'PROXY 1.2.3.4:8080', 'subdomain of listed host proxied');
eq(runPac(pacProfile, ['example.com'], {}, 'notexample.com'), 'DIRECT', 'suffix lookalike NOT proxied');
eq(runPac(pacProfile, ['example.com'], {}, 'localhost'), 'DIRECT', 'localhost direct');
eq(runPac(pacProfile, ['example.com'], {}, '127.0.0.1'), 'DIRECT', 'loopback ip direct');
eq(runPac(pacProfile, [], {}, 'anything.com'), 'DIRECT', 'empty host list proxies nothing');
eq(runPac(pacProfile, [], { strict: true }, 'anything.com'), 'PROXY 1.2.3.4:8080', 'strict mode proxies unknown hosts');
eq(runPac(pacProfile, [], { strict: true }, 'localhost'), 'DIRECT', 'strict still spares localhost');
eq(runPac(pacProfile, ['a.com'], { bypassList: 'skip.com' }, 'skip.com'), 'DIRECT', 'bypass wins over host list');
eq(runPac(pacProfile, ['skip.com'], { bypassList: 'skip.com' }, 'x.skip.com'), 'DIRECT', 'bypass covers subdomains');
eq(runPac({ ...pacProfile, scheme: 'socks5' }, ['a.com'], {}, 'a.com'), 'SOCKS5 1.2.3.4:8080; SOCKS 1.2.3.4:8080', 'socks token used in PAC');
eq(runPac(pacProfile, ['example.com'], {}, 'EXAMPLE.COM'), 'PROXY 1.2.3.4:8080', 'host match is case-insensitive');

eq(buildPacConfig(pacProfile, ['a.com']).mode, 'pac_script', 'pac config mode');
ok(buildPacConfig(pacProfile, ['a.com']).pacScript.mandatory === true, 'pac is mandatory');
ok(buildPacConfig(pacProfile, ['a.com']).pacScript.data.includes('FindProxyForURL'), 'pac carries the function');
eq(buildConfigForScope(pacProfile, 'all', ['a.com']).mode, 'fixed_servers', 'scope all -> fixed_servers');
eq(buildConfigForScope(pacProfile, 'tabs', ['a.com']).mode, 'pac_script', 'scope tabs -> pac_script');
let pacThrew = false;
try { buildPacScript({ host: '', port: 0 }, []); } catch (_) { pacThrew = true; }
ok(pacThrew, 'invalid profile cannot build a PAC');

/* -------------------------------------------------------------------- done */
console.log(`\n  ProxyDeck engine tests: ${pass} passed, ${fail} failed\n`);
if (fail) {
  for (const f of failures) console.log('  FAIL  ' + f);
  process.exit(1);
}
