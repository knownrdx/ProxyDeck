#!/usr/bin/env python3
"""
ProxyDeck end-to-end test against a REAL Chrome with a REAL upstream proxy.

Proves, with real network traffic:
  1. the extension loads with no manifest/runtime errors
  2. the popup FORM (real typing + real click) saves a profile and connects
  3. chrome.proxy is actually set to fixed_servers with our host/port
  4. proxy auth (onAuthRequired) answers the upstream 407 challenge
  5. a normal page load is routed through the proxy (IP changes vs direct)
  6. geo lookup returns ip/city/region/country/ISP/ASN/timezone in the UI
  7. disconnect restores direct browsing (IP returns to the real one)

NOTE: chrome.runtime.sendMessage sent FROM the service worker is not delivered
to that same worker's onMessage listener. All messaging must originate from an
extension PAGE (the popup) — that is also the real user path.

Run:  bash tools/restart-chrome.sh && CDP_PORT=9335 python tools/e2e.py
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

# Supply a real upstream proxy through the environment; nothing is hard-coded.
#   PD_PROXY_HOST=gw.example.com PD_PROXY_PORT=824 \
#   PD_PROXY_USER=user PD_PROXY_PASS=secret python tools/e2e.py
PROXY = {
    "name": os.environ.get("PD_PROXY_NAME", "Test proxy"),
    "scheme": os.environ.get("PD_PROXY_SCHEME", "http"),
    "host": os.environ.get("PD_PROXY_HOST", ""),
    "port": os.environ.get("PD_PROXY_PORT", ""),
    "username": os.environ.get("PD_PROXY_USER", ""),
    "password": os.environ.get("PD_PROXY_PASS", ""),
}
if not PROXY["host"] or not PROXY["port"]:
    raise SystemExit(
        "Set PD_PROXY_HOST and PD_PROXY_PORT (and optionally PD_PROXY_USER / "
        "PD_PROXY_PASS) to a real upstream proxy before running this suite."
    )

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
    """Chrome 111+ requires PUT for /json/new."""
    req = urllib.request.Request(BASE + "/json/new?" + url, method="PUT")
    with urllib.request.urlopen(req) as r:
        return json.load(r)

def send(ws, msg):
    """chrome.runtime.sendMessage from an extension PAGE context."""
    expr = ("(async()=>{const r=await new Promise(res=>chrome.runtime.sendMessage("
            + json.dumps(msg) + ",res));return JSON.stringify(r);})()")
    return json.loads(coerce(ws.eval(expr)))

def click(ws, selector):
    r = coerce(ws.eval("(()=>{const el=document.querySelector(" + json.dumps(selector)
                       + ");if(!el)return 'missing';el.click();return 'ok';})()"))
    if r != "ok":
        raise RuntimeError("click target missing: " + selector)

def type_into(ws, selector, value):
    """Set value + fire real input/change events, like a human typing."""
    expr = ("(()=>{const el=document.querySelector(" + json.dumps(selector) + ");"
            "if(!el)return 'missing';el.focus();el.value=" + json.dumps(str(value)) + ";"
            "el.dispatchEvent(new Event('input',{bubbles:true}));"
            "el.dispatchEvent(new Event('change',{bubbles:true}));return el.value;})()")
    return coerce(ws.eval(expr))

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

def proxy_settings(sw):
    return json.loads(coerce(sw.eval(
        "(async()=>{const c=await new Promise(r=>chrome.proxy.settings.get({},r));"
        "return JSON.stringify(c);})()")))

def fetch_ip(pg, tag=""):
    pg.call("Page.navigate", url="https://ipwho.is/?t=" + str(int(time.time() * 1000)))
    for _ in range(30):
        time.sleep(1)
        txt = coerce(pg.eval("document.body ? document.body.innerText : ''")) or ""
        if '"ip"' in txt:
            try:
                return json.loads(txt)
            except Exception:
                pass
    raise SystemExit("could not read ipwho.is " + tag)


print("\n=== ProxyDeck E2E (real Chrome, real proxy) ===\n")

# ------------------------------------------------------------- 1. extension loads
sw_t = wait_for(lambda: next((t for t in targets() if t.get("type") == "service_worker"
                              and "chrome-extension://" in t.get("url", "")), None),
                what="service worker")
EXT = sw_t["url"].split("chrome-extension://")[1].split("/")[0]
print("  extension id: " + EXT + "\n")
sw = cdp.WS(sw_t["webSocketDebuggerUrl"])
check("service worker alive with proxy permission", coerce(sw.eval("typeof chrome.proxy")) == "object")

page_t = wait_for(lambda: next((t for t in targets() if t["type"] == "page"), None), what="a page")
pg = cdp.WS(page_t["webSocketDebuggerUrl"])
pg.call("Page.enable")
pg.call("Page.navigate", url="chrome://extensions/")
time.sleep(2.5)
walk = """(()=>{const out=[];const walk=(root,d)=>{if(!root||d>8)return;
for(const el of root.querySelectorAll('*')){if(el.tagName==='EXTENSIONS-ITEM'&&el.data)
out.push({name:el.data.name,state:el.data.state,
manifestErrors:(el.data.manifestErrors||[]).length,
runtimeErrors:(el.data.runtimeErrors||[]).map(e=>e.message||'').slice(0,3)});
if(el.shadowRoot)walk(el.shadowRoot,d+1);}};walk(document,0);return JSON.stringify(out);})()"""
items = json.loads(coerce(pg.eval(walk)) or "[]")
mine = next((i for i in items if "ProxyDeck" in i["name"]), None)
check("extension enabled", bool(mine) and mine["state"] == "ENABLED", mine)
check("no manifest errors", bool(mine) and mine["manifestErrors"] == 0, mine and mine.get("manifestErrors"))
check("no runtime errors", bool(mine) and not mine["runtimeErrors"], mine and mine.get("runtimeErrors"))

# ----------------------------------------------------------- 2. baseline direct
direct = fetch_ip(pg, "baseline")
print("\n  DIRECT  : %s  (%s, %s)\n" % (direct["ip"], direct.get("city"), direct.get("country")))
check("baseline direct IP fetched", bool(direct.get("ip")))

# ------------------------------------------------- 3. popup form: type + click
pop_t = new_tab("chrome-extension://%s/src/popup/popup.html" % EXT)
pop = cdp.WS(pop_t["webSocketDebuggerUrl"])
pop.call("Page.enable"); pop.call("Runtime.enable")
time.sleep(1.5)
check("popup opened on Add tab when empty",
      coerce(pop.eval("document.getElementById('panel-add').classList.contains('active')")) is True)

shot(pop, "01-empty-add.png")

# quick-paste parser through the real UI
type_into(pop, "#quickInput", "socks5://bob:secret@1.2.3.4:1080")
click(pop, "#quickBtn")
time.sleep(0.5)
parsed = json.loads(coerce(pop.eval("""JSON.stringify({
 host:document.getElementById('fHost').value,
 port:document.getElementById('fPort').value,
 user:document.getElementById('fUser').value,
 pass:document.getElementById('fPass').value,
 scheme:(document.querySelector('.seg-item.active')||{}).dataset.scheme})""")))
check("quick paste fills the form", parsed == {"host": "1.2.3.4", "port": "1080", "user": "bob",
                                               "pass": "secret", "scheme": "socks5"}, parsed)
click(pop, "#resetBtn")
time.sleep(0.3)

# real proxy via the real form
type_into(pop, "#fName", PROXY["name"])
click(pop, ".seg-item[data-scheme='http']")
type_into(pop, "#fHost", PROXY["host"])
type_into(pop, "#fPort", PROXY["port"])
type_into(pop, "#fUser", PROXY["username"])
type_into(pop, "#fPass", PROXY["password"])
shot(pop, "02-form-filled.png")

click(pop, "#saveBtn")
print("\n  connecting through the real proxy ...")
geo = None
for _ in range(40):
    time.sleep(1)
    st = send(pop, {"type": "getState"})
    if st.get("ok") and st["data"].get("connected") and st["data"].get("geo"):
        geo = st["data"]["geo"]
        break
    if st.get("ok") and st["data"].get("lastError"):
        break
state = send(pop, {"type": "getState"})["data"]
check("connected after form submit", state.get("connected") is True, state.get("lastError"))
check("geo resolved", bool(geo), state.get("lastError"))
if geo:
    print("\n  PROXY   : %s  (%s, %s, %s)" % (geo["ip"], geo.get("city"), geo.get("region"), geo.get("country")))
    print("  ISP     : %s | ASN %s | TZ %s | %s ms via %s\n"
          % (geo.get("isp"), geo.get("asn"), geo.get("timezone"), geo.get("latencyMs"), geo.get("source")))
check("proxy IP differs from direct IP", bool(geo) and geo["ip"] != direct["ip"],
      "%s -> %s" % (direct["ip"], geo and geo.get("ip")))

# --------------------------------------------- 4. chrome's own proxy settings
cfg = proxy_settings(sw)
val = cfg.get("value", {})
sp = val.get("rules", {}).get("singleProxy", {})
check("chrome.proxy mode = fixed_servers", val.get("mode") == "fixed_servers", val.get("mode"))
check("chrome.proxy host matches", sp.get("host") == PROXY["host"], sp)
check("chrome.proxy port matches", sp.get("port") == int(PROXY["port"]), sp)
check("chrome.proxy scheme matches", sp.get("scheme") == "http", sp)
check("bypass list applied", "localhost" in (val.get("rules", {}).get("bypassList") or []),
      val.get("rules", {}).get("bypassList"))
check("extension controls the proxy", cfg.get("levelOfControl") == "controlled_by_this_extension",
      cfg.get("levelOfControl"))

# ----------------------------------- 5. a real page load exits via the proxy
through = fetch_ip(pg, "through proxy")
print("  PAGE VIA PROXY: %s  (%s, %s)\n" % (through.get("ip"), through.get("city"), through.get("country")))
check("real page load exits via proxy (IP changed)", through.get("ip") != direct.get("ip"),
      "%s -> %s" % (direct.get("ip"), through.get("ip")))
check("proxy auth accepted, no 407 wall", bool(through.get("ip")), through)

# ----------------------------------------------------- 6. popup shows the geo
pop.call("Page.bringToFront")
time.sleep(1.2)
ui = json.loads(coerce(pop.eval("""JSON.stringify({
  status:document.getElementById('statusLine').textContent,
  power:document.getElementById('powerLabel').textContent,
  on:document.getElementById('powerBtn').classList.contains('on'),
  ip:document.getElementById('geoIp').textContent,
  place:document.getElementById('geoPlace').textContent,
  city:document.getElementById('gCity').textContent,
  region:document.getElementById('gRegion').textContent,
  country:document.getElementById('gCountry').textContent,
  postal:document.getElementById('gPostal').textContent,
  isp:document.getElementById('gIsp').textContent,
  asn:document.getElementById('gAsn').textContent,
  tz:document.getElementById('gTz').textContent,
  coord:document.getElementById('gCoord').textContent,
  pill:document.getElementById('geoPill').textContent,
  flag:(document.getElementById('geoFlag').querySelector('img')||{}).src||document.getElementById('geoFlag').textContent,
  server:document.getElementById('acHost').textContent,
  scheme:document.getElementById('acScheme').textContent
})""")))
print("  popup: " + json.dumps(ui, ensure_ascii=False)[:420] + "\n")
blank = ("", "-", "\u2014")
check("popup header says Connected", ui["on"] and "Connected" in ui["status"], ui["status"])
check("popup IP == proxy IP", ui["ip"] == (geo or {}).get("ip"), ui["ip"])
check("popup city shown", ui["city"] not in blank, ui["city"])
check("popup region shown", ui["region"] not in blank, ui["region"])
check("popup country shown", ui["country"] not in blank, ui["country"])
check("popup ISP shown", ui["isp"] not in blank, ui["isp"])
check("popup ASN shown", ui["asn"] not in blank, ui["asn"])
check("popup timezone shown", ui["tz"] not in blank, ui["tz"])
check("popup coords shown", ui["coord"] not in blank, ui["coord"])
check("popup country flag rendered", "flagcdn.com" in ui["flag"] or (ui["flag"] not in blank and ui["flag"] != "\U0001F310"), ui["flag"])
check("popup pill = proxy ip", ui["pill"].strip().lower() == "proxy ip", ui["pill"])
check("popup shows server host", PROXY["host"] in ui["server"], ui["server"])
check("popup shows protocol badge", ui["scheme"] == "HTTP", ui["scheme"])
shot(pop, "03-connected.png")

# ------------------------------------------------- 6b. data usage counters
print("  generating traffic to exercise the byte counters ...")
for _ in range(3):
    pg.call("Page.navigate", url="https://example.com/?t=" + str(int(time.time() * 1000)))
    time.sleep(2.5)
pg.call("Page.navigate", url="https://ipwho.is/?t=" + str(int(time.time() * 1000)))
time.sleep(3)

pop.call("Page.bringToFront")
time.sleep(2.0)
usage = send(pop, {"type": "getUsage"})
check("getUsage responds", usage.get("ok"), usage.get("error"))
u = usage.get("data") or {}
print("  usage: down=%s up=%s requests=%s startedAt=%s\n" % (u.get("down"), u.get("up"), u.get("requests"), bool(u.get("startedAt"))))
check("requests were counted", (u.get("requests") or 0) > 0, u.get("requests"))
check("download bytes counted", (u.get("down") or 0) > 0, u.get("down"))
check("upload bytes counted", (u.get("up") or 0) > 0, u.get("up"))
check("session clock started", bool(u.get("startedAt")), u.get("startedAt"))

time.sleep(1.5)
stats = json.loads(coerce(pop.eval("""JSON.stringify({
  down:document.getElementById('sDown').textContent,
  up:document.getElementById('sUp').textContent,
  time:document.getElementById('sTime').textContent,
  req:document.getElementById('sReq').textContent,
  rate:document.getElementById('sRate').textContent,
  live:document.getElementById('statsCard').classList.contains('live')})""")))
print("  stats UI: " + json.dumps(stats) + "\n")
check("UI shows non-zero download", stats["down"] != "0 B", stats["down"])
check("UI shows non-zero upload", stats["up"] != "0 B", stats["up"])
check("UI shows request count", stats["req"] not in ("0", ""), stats["req"])
check("UI session clock running", stats["time"] != "0:00", stats["time"])
check("UI shows avg throughput", "/s avg" in stats["rate"], stats["rate"])
check("stats card marked live", stats["live"] is True)

before = (u.get("down") or 0)
time.sleep(1)
pg.call("Page.navigate", url="https://example.com/?more=" + str(int(time.time() * 1000)))
time.sleep(3)
pop.call("Page.bringToFront")
time.sleep(1.5)
u2 = (send(pop, {"type": "getUsage"}).get("data") or {})
check("counters keep increasing with more traffic", (u2.get("down") or 0) > before,
      "%s -> %s" % (before, u2.get("down")))

reset = send(pop, {"type": "resetUsage"})
check("resetUsage zeroes the counters",
      reset.get("ok") and (reset["data"]["down"] == 0) and (reset["data"]["requests"] == 0), reset.get("data"))

shot(pop, "03b-usage.png")

click(pop, "[data-tab='servers']")
time.sleep(0.6)
srv = coerce(pop.eval("document.querySelectorAll('.srv').length"))
check("server saved in the list", srv >= 1, srv)
check("server row marked connected",
      coerce(pop.eval("!!document.querySelector('.srv.connected')")) is True)
shot(pop, "04-servers.png")
click(pop, "[data-tab='add']")
time.sleep(0.5); shot(pop, "05-add.png")
click(pop, "[data-tab='connect']")
time.sleep(0.4)

# ------------------------------------------- 7. disconnect restores direct net
click(pop, "#powerBtn")
for _ in range(20):
    time.sleep(0.8)
    st = send(pop, {"type": "getState"})
    if st.get("ok") and not st["data"].get("connected"):
        break
check("disconnected", send(pop, {"type": "getState"})["data"].get("connected") is False)
cfg2 = proxy_settings(sw)
check("chrome.proxy back to direct", cfg2.get("value", {}).get("mode") in ("direct", "system"),
      cfg2.get("value", {}).get("mode"))

after = fetch_ip(pg, "after disconnect")
print("  AFTER DISCONNECT: %s  (%s)\n" % (after.get("ip"), after.get("country")))
check("browsing restored to real IP", after.get("ip") == direct.get("ip"),
      "%s vs %s" % (after.get("ip"), direct.get("ip")))
pop.call("Page.bringToFront")
time.sleep(1.0)
ui2 = json.loads(coerce(pop.eval("""JSON.stringify({
 on:document.getElementById('powerBtn').classList.contains('on'),
 status:document.getElementById('statusLine').textContent})""")))
check("popup reflects disconnect", (not ui2["on"]) and "Disconnected" in ui2["status"], ui2)
shot(pop, "06-disconnected.png")

# --------------------------------------------------------- 8. input validation
bad = send(pop, {"type": "saveProfile", "profile": {"scheme": "http", "host": "not a host", "port": 8080}})
check("invalid host rejected", not bad.get("ok"), bad.get("error"))
badport = send(pop, {"type": "saveProfile", "profile": {"scheme": "http", "host": "1.2.3.4", "port": 99999}})
check("invalid port rejected", not badport.get("ok"), badport.get("error"))

print("\n=== %d passed, %d failed ===" % (len(passed), len(failed)))
if failed:
    for f in failed:
        print("  FAILED: " + f)
    sys.exit(1)
