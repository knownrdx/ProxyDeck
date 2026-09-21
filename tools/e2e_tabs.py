#!/usr/bin/env python3
"""
ProxyDeck tab-scope + sticky-session E2E, against a REAL Chrome and a REAL
rotating proxy gateway.

Proves, with real network traffic:
  1. sticky session: same session id -> the SAME exit IP across many requests
  2. rotate: a new session id -> a DIFFERENT exit IP
  3. tab scope: a proxied tab exits via the proxy while ANOTHER tab, at the
     same moment, still exits via the real IP
  4. toggling a tab off puts it back on the real IP
  5. the PAC that Chrome is actually running routes exactly those hosts

Run:  bash tools/restart-chrome.sh && CDP_PORT=9335 python tools/e2e_tabs.py
"""
import base64, json, os, sys, time, urllib.request
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ.setdefault("CDP_PORT", "9335")
import cdp

PORT = int(os.environ["CDP_PORT"])
BASE = f"http://127.0.0.1:{PORT}"
ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
SHOTS = os.path.join(ROOT, "screenshots")
os.makedirs(SHOTS, exist_ok=True)

# Sticky sessions only make sense on a rotating gateway; DataImpulse pins the
# exit IP to __sid.<id> in the username.
# Sticky sessions need a real ROTATING gateway. Supply one via the environment;
# nothing is hard-coded:
#   PD_PROXY_HOST=gw.example.com PD_PROXY_PORT=10000 \
#   PD_PROXY_USER=user PD_PROXY_PASS=secret \
#   PD_SESSION_FORMAT=dataimpulse PD_SESSION_COUNTRY=us \
#   PD_PORT_START=10000 PD_PORT_END=10010 python tools/e2e_tabs.py
#
# PD_PORT_START/END matter for gateways that bind a session to a PORT rather
# than to the username: hopping ports on rotation also busts Chrome's proxy
# auth cache, which is keyed on (scheme, host, port) and otherwise keeps
# replaying the old credentials so the exit IP never changes.
PROXY = {
    "name": os.environ.get("PD_PROXY_NAME", "Sticky test proxy"),
    "scheme": os.environ.get("PD_PROXY_SCHEME", "http"),
    "host": os.environ.get("PD_PROXY_HOST", ""),
    "port": os.environ.get("PD_PROXY_PORT", ""),
    "username": os.environ.get("PD_PROXY_USER", ""),
    "password": os.environ.get("PD_PROXY_PASS", ""),
    "sessionFormat": os.environ.get("PD_SESSION_FORMAT", "dataimpulse"),
    "sessionCountry": os.environ.get("PD_SESSION_COUNTRY", "us"),
    "sessionTtlMin": "0",
    "scope": "all",
    "portRangeStart": os.environ.get("PD_PORT_START", ""),
    "portRangeEnd": os.environ.get("PD_PORT_END", ""),
}
if not PROXY["host"] or not PROXY["port"]:
    raise SystemExit(
        "Set PD_PROXY_HOST and PD_PROXY_PORT (plus PD_PROXY_USER / "
        "PD_PROXY_PASS) to a real rotating proxy before running this suite."
    )
ALT_COUNTRY = os.environ.get("PD_ALT_COUNTRY", "gb").lower()

passed, failed = [], []
def check(label, cond, detail=""):
    (passed if cond else failed).append(label)
    print(("  PASS  " if cond else "  FAIL  ") + label + (("  -- " + str(detail)[:300]) if detail else ""))

def targets():
    with urllib.request.urlopen(BASE + "/json/list") as r:
        return json.load(r)

def wait_for(pred, timeout=25, interval=0.5, what="target"):
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            hit = pred()
            if hit:
                return hit
        except Exception:
            pass
        time.sleep(interval)
    raise SystemExit("timeout waiting for " + what)

def coerce(v):
    if isinstance(v, dict) and "__error" in v:
        raise RuntimeError("JS error: " + v["__error"])
    return v

def new_tab(url):
    req = urllib.request.Request(BASE + "/json/new?" + url, method="PUT")
    with urllib.request.urlopen(req) as r:
        return json.load(r)

def chrome_tab_id(sw, url_marker):
    """
    /json/new returns a DEVTOOLS TARGET id (a hex string) which is NOT the
    chrome.tabs id. setTabProxied needs the real integer id, so ask the worker
    to look the tab up by a unique marker in its URL.
    """
    expr = ("(async()=>{const ts=await chrome.tabs.query({});"
            "const t=ts.find(x=>(x.url||'').indexOf(" + json.dumps(url_marker) + ")!==-1);"
            "return t?String(t.id):'';})()")
    val = coerce(sw.eval(expr))
    if not val:
        raise SystemExit("could not resolve chrome tab id for " + url_marker)
    return int(val)

def send(ws, msg):
    expr = ("(async()=>{const r=await new Promise(res=>chrome.runtime.sendMessage("
            + json.dumps(msg) + ",res));return JSON.stringify(r);})()")
    return json.loads(coerce(ws.eval(expr)))

def click(ws, selector):
    r = coerce(ws.eval("(()=>{const el=document.querySelector(" + json.dumps(selector)
                       + ");if(!el)return 'missing';el.click();return 'ok';})()"))
    if r != "ok":
        raise RuntimeError("click target missing: " + selector)

def shot(ws, name):
    ws.call("Emulation.setDeviceMetricsOverride", width=380, height=600, deviceScaleFactor=2, mobile=False)
    ws.eval("(()=>{const b=document.querySelector('.body');if(b)b.scrollTop=0;window.scrollTo(0,0);return 1;})()")
    time.sleep(0.5)
    data = ws.call("Page.captureScreenshot", format="png")["data"]
    path = os.path.join(SHOTS, name)
    with open(path, "wb") as f:
        f.write(base64.b64decode(data))
    ws.call("Emulation.clearDeviceMetricsOverride")
    print("  screenshot: " + path)
    return path

# Two DIFFERENT echo hosts. Tab scope is host-based (Chrome exposes no per-tab
# proxy API), so proving isolation requires the control tab to use its own host.
ECHO_A = "https://ipwho.is/"
ECHO_B = "https://api.ipify.org/?format=json"

def ip_of(pg, endpoint=ECHO_A, tries=3):
    """Read the exit IP this tab currently has."""
    sep = "&" if "?" in endpoint else "?"
    for _ in range(tries):
        pg.call("Page.navigate", url=endpoint + sep + "t=" + str(int(time.time() * 1000)))
        for _ in range(25):
            time.sleep(1)
            txt = coerce(pg.eval("document.body ? document.body.innerText : ''")) or ""
            if '"ip"' in txt:
                try:
                    return json.loads(txt)
                except Exception:
                    break
        time.sleep(1)
    raise SystemExit("could not read " + endpoint)

def ip_b(pg):
    return ip_of(pg, ECHO_B)

def proxy_mode(sw):
    cfg = json.loads(coerce(sw.eval(
        "(async()=>{const c=await new Promise(r=>chrome.proxy.settings.get({},r));"
        "return JSON.stringify(c);})()")))
    return cfg.get("value", {})


print("\n=== ProxyDeck tab-scope + sticky-session E2E ===\n")

sw_t = wait_for(lambda: next((t for t in targets() if t.get("type") == "service_worker"
                              and "chrome-extension://" in t.get("url", "")), None),
                what="service worker")
EXT = sw_t["url"].split("chrome-extension://")[1].split("/")[0]
sw = cdp.WS(sw_t["webSocketDebuggerUrl"])
print("  extension id: " + EXT + "\n")

# tab A = the tab we will proxy; tab B = the control tab that must stay direct
tab_a = new_tab("https://example.com/?pdtab=alpha")
pg_a = cdp.WS(tab_a["webSocketDebuggerUrl"]); pg_a.call("Page.enable")
tab_b = new_tab("https://example.com/?pdtab=bravo")
pg_b = cdp.WS(tab_b["webSocketDebuggerUrl"]); pg_b.call("Page.enable")
time.sleep(3)
TAB_A = chrome_tab_id(sw, "pdtab=alpha")
TAB_B = chrome_tab_id(sw, "pdtab=bravo")
print("  chrome tab ids: A=%d  B=%d\n" % (TAB_A, TAB_B))

pop_t = new_tab("chrome-extension://%s/src/popup/popup.html" % EXT)
pop = cdp.WS(pop_t["webSocketDebuggerUrl"])
pop.call("Page.enable"); pop.call("Runtime.enable")
time.sleep(1.5)

direct = ip_of(pg_b)                      # real IP, read on host A
direct_b = ip_b(pg_b)                     # same real IP, read on host B
print("  DIRECT (real IP): %s  (%s)" % (direct["ip"], direct.get("country")))
print("  control echo host agrees: %s\n" % direct_b["ip"])
check("baseline real IP read", bool(direct.get("ip")))
check("both echo services report the same real IP", direct_b["ip"] == direct["ip"],
      "%s vs %s" % (direct_b["ip"], direct["ip"]))

# ------------------------------------------------- 1. sticky session holds one IP
saved = send(pop, {"type": "saveProfile", "profile": PROXY})
check("sticky profile saved", saved.get("ok"), saved.get("error"))
pid = saved["data"]["profile"]["id"]

conn = send(pop, {"type": "connect", "id": pid})
check("connected with sticky session", conn.get("ok"), conn.get("error"))

info = send(pop, {"type": "sessionInfo"})
check("sessionInfo returns a session", info.get("ok") and bool(info["data"].get("sessionId")), info.get("data"))
sess1 = info["data"]
print("\n  session id : %s" % sess1.get("sessionId"))
print("  wire user  : %s\n" % sess1.get("username"))
check("session id embedded in username", sess1.get("sessionId", "x") in sess1.get("username", ""), sess1.get("username"))
check("country embedded in username", "__cr.us" in sess1.get("username", ""), sess1.get("username"))

print("  probing the same session 4 times ...")
ips = []
for i in range(4):
    got = ip_of(pg_a)
    ips.append(got["ip"])
    print("    probe %d: %s  (%s, %s)" % (i + 1, got["ip"], got.get("city"), got.get("country")))
unique = set(ips)
check("sticky session holds ONE exit IP across 4 requests", len(unique) == 1, sorted(unique))
check("sticky IP is not the real IP", ips[0] != direct["ip"], "%s vs %s" % (ips[0], direct["ip"]))
sticky_ip = ips[0]

pop.call("Page.bringToFront"); time.sleep(1.2)
shot(pop, "10-sticky-session.png")

# --------------------------------------------------------- 2. rotate = new IP
rot = send(pop, {"type": "rotateSession"})
check("rotateSession ok", rot.get("ok"), rot.get("error"))
info2 = send(pop, {"type": "sessionInfo"})
sess2 = info2.get("data") or {}
print("\n  rotated to : %s" % sess2.get("sessionId"))
check("rotate produced a NEW session id", sess2.get("sessionId") and sess2["sessionId"] != sess1["sessionId"],
      "%s -> %s" % (sess1.get("sessionId"), sess2.get("sessionId")))

after_rot = ip_of(pg_a)
print("  IP after rotate: %s  (%s)\n" % (after_rot["ip"], after_rot.get("city")))
check("rotate changed the exit IP", after_rot["ip"] != sticky_ip, "%s -> %s" % (sticky_ip, after_rot["ip"]))

# DECISIVE: switch the session country. If the exit COUNTRY changes, Chrome is
# really sending the newly assembled username; if it stays, Chrome is serving
# the proxy credentials from its own auth cache and the rotation never reached
# the gateway.
prof_now = send(pop, {"type": "getState"})["data"]["profiles"][0]
cc_res = send(pop, {"type": "saveProfile", "profile": {**prof_now, "sessionCountry": ALT_COUNTRY}})
check("country switched to " + ALT_COUNTRY, cc_res.get("ok"), cc_res.get("error"))
send(pop, {"type": "rotateSession"})
cc_info = (send(pop, {"type": "sessionInfo"}).get("data") or {})
print("  wire user now: %s" % cc_info.get("username"))
cc_ip = ip_of(pg_a)
print("  IP after country switch: %s  (%s, %s)\n" % (cc_ip["ip"], cc_ip.get("city"), cc_ip.get("country")))
check("new credentials really reach the gateway (country changed)",
      (cc_ip.get("country_code") or "").upper() == ALT_COUNTRY.upper(),
      "expected %s, got %s (%s)" % (ALT_COUNTRY.upper(), cc_ip.get("country_code"), cc_ip.get("ip")))

# put it back to US for the tab tests
back = send(pop, {"type": "getState"})["data"]["profiles"][0]
send(pop, {"type": "saveProfile", "profile": {**back, "sessionCountry": PROXY["sessionCountry"]}})
send(pop, {"type": "rotateSession"})
time.sleep(1)

# and the NEW session is itself sticky
after_rot = ip_of(pg_a)
again = ip_of(pg_a)
check("new session is sticky too", again["ip"] == after_rot["ip"], "%s vs %s" % (after_rot["ip"], again["ip"]))

# --------------------------------------------- 3. tab scope: A proxied, B direct
prof = send(pop, {"type": "getState"})["data"]["profiles"][0]
res = send(pop, {"type": "saveProfile", "profile": {**prof, "scope": "tabs"}})
check("switched profile to tab scope", res.get("ok"), res.get("error"))

on = send(pop, {"type": "setTabProxied", "tabId": TAB_A, "on": True})
check("tab A marked proxied", on.get("ok") and on["data"]["proxied"] is True, on.get("data"))

val = proxy_mode(sw)
check("chrome switched to pac_script mode", val.get("mode") == "pac_script", val.get("mode"))
pac = (val.get("pacScript") or {}).get("data", "")
check("PAC contains FindProxyForURL", "FindProxyForURL" in pac)
check("PAC lists the proxy host", PROXY["host"] in pac, pac[:120])

print("\n  loading BOTH tabs at the same time (different hosts) ...")
a_ip = ip_of(pg_a)          # proxied tab, host A
b_ip = ip_b(pg_b)           # control tab, host B
print("    tab A (proxied) : %s  (%s)" % (a_ip["ip"], a_ip.get("country")))
print("    tab B (control) : %s  (%s)\n" % (b_ip["ip"], b_ip.get("country")))
check("proxied tab exits via the proxy", a_ip["ip"] != direct["ip"], "%s vs real %s" % (a_ip["ip"], direct["ip"]))
check("OTHER tab still uses the real IP", b_ip["ip"] == direct["ip"], "%s vs real %s" % (b_ip["ip"], direct["ip"]))
check("the two tabs have DIFFERENT IPs at the same time", a_ip["ip"] != b_ip["ip"],
      "%s vs %s" % (a_ip["ip"], b_ip["ip"]))

pop.call("Page.bringToFront"); time.sleep(1.2)
ui = json.loads(coerce(pop.eval("""JSON.stringify({
  scopeActive:(document.querySelector('#scopeSeg .scope-item.active')||{}).dataset.scope,
  toggleVisible:!document.getElementById('tabToggle').hidden,
  switchOn:document.getElementById('tabSwitch').getAttribute('aria-checked'),
  hint:document.getElementById('scopeHint').textContent,
  sessVisible:!document.getElementById('sessionCard').hidden,
  sessId:document.getElementById('sessId').textContent,
  sessUser:document.getElementById('sessUser').textContent})""")))
print("  popup: " + json.dumps(ui)[:320] + "\n")
check("popup shows tab scope selected", ui["scopeActive"] == "tabs", ui["scopeActive"])
check("popup shows the per-tab switch", ui["toggleVisible"] is True)
check("popup session card visible", ui["sessVisible"] is True)
live_sess = (send(pop, {"type": "sessionInfo"}).get("data") or {}).get("sessionId")
check("popup shows the live session id", ui["sessId"] == live_sess,
      "popup=%s worker=%s" % (ui["sessId"], live_sess))
check("popup shows the assembled wire username", "__sid." in ui["sessUser"], ui["sessUser"])
shot(pop, "11-tab-scope.png")

# ------------------------------------------- 4. toggling the tab off = real IP
off = send(pop, {"type": "setTabProxied", "tabId": TAB_A, "on": False})
check("tab A un-proxied", off.get("ok") and off["data"]["proxied"] is False, off.get("data"))
time.sleep(1)
a_off = ip_of(pg_a)
print("  tab A after switching off: %s\n" % a_off["ip"])
check("un-proxied tab returns to the real IP", a_off["ip"] == direct["ip"],
      "%s vs %s" % (a_off["ip"], direct["ip"]))

# ------------------------------------------------------------- 5. cleanup
d = send(pop, {"type": "disconnect"})
check("disconnect ok", d.get("ok"), d.get("error"))
check("proxy back to direct", proxy_mode(sw).get("mode") in ("direct", "system"), proxy_mode(sw).get("mode"))
final = ip_of(pg_a)
check("browsing fully restored", final["ip"] == direct["ip"], "%s vs %s" % (final["ip"], direct["ip"]))

print("\n=== %d passed, %d failed ===" % (len(passed), len(failed)))
if failed:
    for f in failed:
        print("  FAILED: " + f)
    sys.exit(1)
