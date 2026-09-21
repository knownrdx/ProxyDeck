<div align="center">

# 🛡️ ProxyDeck

**A modern Chrome proxy switcher with per-tab routing, sticky sessions and live IP intelligence.**

[English](README.md) · [简体中文](README.zh-CN.md) · [Bahasa Indonesia](README.id.md)

[![Manifest V3](https://img.shields.io/badge/Manifest-V3-4f8cff?style=flat-square)](https://developer.chrome.com/docs/extensions/mv3/intro/)
[![License: MIT](https://img.shields.io/badge/License-MIT-16c47f?style=flat-square)](LICENSE)
[![Tests](https://img.shields.io/badge/tests-175%20unit%20%2B%2085%20e2e-7b5cff?style=flat-square)](#-testing)
[![No dependencies](https://img.shields.io/badge/dependencies-zero-ffb020?style=flat-square)](#-project-layout)

</div>

---

## What it does

Set a proxy once, then flip it on from the toolbar. ProxyDeck shows you exactly **where you are coming out** — IP, city, region, country, ISP, ASN, timezone — and exactly **how much data** the session has used.

Two things set it apart from the usual switcher:

| | |
|---|---|
| 🗂 **Per-tab routing** | Send *one tab* through the proxy while every other tab keeps your real IP. Research in one window, stay logged in normally in the next. |
| 📌 **Sticky sessions** | Rotating gateways hand you a new IP on every request. ProxyDeck pins one exit IP and holds it — for as long as you want, or on a timer you set. |

---

## ✨ Features

### Connection
- **Protocols** — HTTP, HTTPS, SOCKS4, SOCKS5
- **Authentication** — username/password proxies answered automatically
- **Quick paste** — drop in almost any format and the form fills itself:
  ```
  host:port                       user:pass@host:port
  host:port:user:pass             socks5://user:pass@host:port
  ```
- **Multiple servers** — save, edit, switch, delete, export as JSON
- **Bypass list** — hosts that always skip the proxy

### 🗂 Tab scope
Choose **All tabs** or **Selected tabs only**. In tab mode a toggle appears for the current tab; flip it on and only that tab is proxied. Everything else — your email, your dashboards — stays on your real connection.

> Chrome exposes no per-tab proxy API, so ProxyDeck compiles the hosts loaded in your proxied tabs into a PAC script. Routing is therefore **per host**: if two tabs open the same site, both follow the same route.

### 📌 Sticky sessions
Rotating residential gateways encode a session id in the username. ProxyDeck knows the syntax for the major providers and builds the real username for you:

| Provider | Sends as |
|---|---|
| DataImpulse | `user__cr.us__sid.a1b2c3d4` |
| Bright Data | `user-country-us-session-a1b2c3d4` |
| Oxylabs | `user-cc-us-sessid-a1b2c3d4e5` |
| Smartproxy / Decodo | `user-country-us-session-a1b2c3d4e5` |
| IPRoyal | `user_country-us_session-a1b2c3d4` |
| Custom | your own `{cc}` / `{sid}` template |

- Pick a **country** and the gateway gives you an exit there
- Set **hold for N minutes** and ProxyDeck rotates automatically when it expires — leave it at `0` to hold forever
- Hit **Rotate** any time for a fresh IP
- The exact username going to the gateway is always shown, so there is no guesswork

### 📊 Live intelligence
- Exit IP with country flag, city, region, postal code
- ISP / organisation, ASN, timezone, coordinates, lookup latency
- Downloaded / uploaded bytes, session clock, request count, average throughput
- One-click copy of the full location report

---

## 📦 Install

**From source** (recommended while this is unpacked):

1. Download or clone this repository
2. Open `chrome://extensions`
3. Enable **Developer mode** (top right)
4. Click **Load unpacked** and select the project folder

**From a ZIP:**

```bash
node tools/build-zip.js        # creates dist/proxydeck-<version>.zip
```

Then drag the ZIP onto `chrome://extensions`.

---

## 🚀 Quick start

1. Click the ProxyDeck icon → **Add** tab
2. Paste your proxy line into **Quick paste**, press **Parse** — or fill the fields manually
3. *(optional)* Pick your provider under **Sticky session**, set a country and a hold time
4. *(optional)* Set **Proxy scope** to *Selected tabs only*
5. Press **Save & Connect**

The Connect tab now shows your new exit IP and its location. Tap the power button any time to go back to direct browsing.

---

## 🧪 Testing

Everything here is verified against a real browser and a real proxy — no mocks.

```bash
# 175 engine assertions, plain Node, no browser needed
node tests/run-tests.mjs

# launch Chrome for Testing with the extension loaded
bash tools/restart-chrome.sh

# 52 checks: connect, auth, geo, counters, disconnect
CDP_PORT=9335 python tools/e2e.py

# 33 checks: sticky session holds one IP, rotation, tab isolation
CDP_PORT=9335 python tools/e2e_tabs.py
```

The end-to-end suites record your real IP, connect through an actual upstream proxy, and assert that page loads come out somewhere else — then disconnect and assert the IP comes back. Tab isolation is proven by loading two tabs at the same moment and checking they report **different** IPs.

Test the shipped artifact too, not just the working tree:

```bash
node tools/build-zip.js
unzip -o dist/proxydeck-*.zip -d /tmp/proxydeck-ship
EXT_DIR=/tmp/proxydeck-ship bash tools/restart-chrome.sh
CDP_PORT=9335 python tools/e2e.py
```

---

## 📁 Project layout

```
manifest.json                      Manifest V3
src/engine/proxy.js                pure logic — parsing, PAC, sessions, usage math
src/background/service-worker.js   chrome.proxy, auth, geo, byte counters, tab scope
src/popup/                         popup.html · popup.css · popup.js
icons/                             generated PNG icon set
tests/run-tests.mjs                175 assertions, zero dependencies
tools/build-zip.js                 ZIP builder
tools/make-icons.mjs               PNG icon generator
tools/restart-chrome.sh            Chrome for Testing launcher
tools/e2e.py                       connection / geo / usage suite
tools/e2e_tabs.py                  tab scope / sticky session suite
tools/cdp.py                       minimal DevTools Protocol client
```

No build step, no bundler, no `node_modules`. The `engine/` layer is pure functions with no `chrome.*` calls, which is why the whole test suite runs in milliseconds under plain Node.

---

## 🔐 Permissions

| Permission | Why it is needed |
|---|---|
| `proxy` | set and clear the browser proxy |
| `storage` | save your servers and counters |
| `webRequest`, `webRequestAuthProvider` | answer proxy authentication, count bytes |
| `tabs`, `webNavigation` | know which tab a request belongs to, for tab scope |
| `alarms` | flush counters, run the session timer |
| `browsingData` | clear the cached proxy credentials when you rotate |
| `<all_urls>` | proxy and measure requests on any site |

**Your data stays yours.** Nothing is uploaded anywhere. The only outbound call ProxyDeck makes on its own is the IP-location lookup (ipwho.is, falling back to ipapi.co, geojs.io, ip-api.com) — and that call goes *through your proxy*, which is the whole point of it.

---

## ⚠️ Known limits

- **Byte counts are estimates.** They ride on `chrome.webRequest`, the only wire-level signal an MV3 extension gets. Real `Content-Length` is used when servers send one; chunked and compressed responses are approximated.
- **Tab scope is host-based.** Chrome has no per-tab proxy API. The same site open in two tabs follows the same route.
- **SOCKS proxies cannot use authentication.** Chrome does not support it; the UI warns you when you try.
- **Rotation depends on the gateway.** Providers that pin a session to a port need a port range configured; providers that pin to the username work out of the box.

---

## 🤝 Contributing

This is open source under MIT — fork it, modify it, ship it, sell it. Pull requests are welcome.

Before you open one:

```bash
node tests/run-tests.mjs     # must stay green
```

If you touch routing, session handling or the counters, please add assertions in `tests/run-tests.mjs` and, where it needs a real browser, in `tools/e2e_tabs.py`.

---

## 📄 License

[MIT](LICENSE) — do whatever you want with it, just keep the copyright notice.

---

## 👤 Author

**Ariful Islam** — [@knownrdx](https://github.com/knownrdx)

If ProxyDeck is useful to you, a ⭐ on the repository means a lot.
