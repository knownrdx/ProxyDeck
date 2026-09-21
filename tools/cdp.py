#!/usr/bin/env python3
"""Minimal CDP driver over the raw devtools websocket (no deps beyond websocket-client fallback)."""
import json, sys, urllib.request, socket, base64, struct, os, time

PORT = int(os.environ.get("CDP_PORT", "9333"))

def targets():
    with urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json/list") as r:
        return json.load(r)

class WS:
    def __init__(self, url):
        # ws://127.0.0.1:PORT/devtools/page/XXX
        assert url.startswith("ws://")
        rest = url[5:]
        hostport, path = rest.split("/", 1)
        path = "/" + path
        host, port = hostport.split(":")
        self.s = socket.create_connection((host, int(port)), timeout=30)
        key = base64.b64encode(os.urandom(16)).decode()
        req = (f"GET {path} HTTP/1.1\r\nHost: {hostport}\r\nUpgrade: websocket\r\n"
               f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\n"
               f"Sec-WebSocket-Version: 13\r\n\r\n")
        self.s.sendall(req.encode())
        buf = b""
        while b"\r\n\r\n" not in buf:
            buf += self.s.recv(4096)
        self.buf = buf.split(b"\r\n\r\n", 1)[1]
        self.id = 0

    def _send_frame(self, payload):
        data = payload.encode()
        header = bytearray([0x81])
        mask = os.urandom(4)
        n = len(data)
        if n < 126:
            header.append(0x80 | n)
        elif n < 65536:
            header.append(0x80 | 126); header += struct.pack(">H", n)
        else:
            header.append(0x80 | 127); header += struct.pack(">Q", n)
        header += mask
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(data))
        self.s.sendall(bytes(header) + masked)

    def _recv_exact(self, n):
        while len(self.buf) < n:
            chunk = self.s.recv(65536)
            if not chunk:
                raise IOError("socket closed")
            self.buf += chunk
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def _recv_frame(self):
        b0, b1 = self._recv_exact(2)
        ln = b1 & 0x7F
        if ln == 126:
            ln = struct.unpack(">H", self._recv_exact(2))[0]
        elif ln == 127:
            ln = struct.unpack(">Q", self._recv_exact(8))[0]
        masked = b1 & 0x80
        mask = self._recv_exact(4) if masked else None
        data = self._recv_exact(ln)
        if mask:
            data = bytes(b ^ mask[i % 4] for i, b in enumerate(data))
        return data.decode("utf8", "replace")

    def call(self, method, **params):
        self.id += 1
        mid = self.id
        self._send_frame(json.dumps({"id": mid, "method": method, "params": params}))
        deadline = time.time() + 30
        while time.time() < deadline:
            msg = json.loads(self._recv_frame())
            if msg.get("id") == mid:
                if "error" in msg:
                    raise RuntimeError(method + ": " + json.dumps(msg["error"]))
                return msg.get("result", {})
        raise TimeoutError(method)

    def eval(self, expr, await_promise=True, context_id=None):
        params = dict(expression=expr, returnByValue=True,
                      awaitPromise=await_promise, userGesture=True)
        if context_id is not None:
            params["contextId"] = context_id
        r = self.call("Runtime.evaluate", **params)
        res = r.get("result", {})
        if r.get("exceptionDetails"):
            return {"__error": json.dumps(r["exceptionDetails"])[:500]}
        return res.get("value")

    def contexts(self, timeout=3.0):
        """Collect Runtime.executionContextCreated events (main + isolated worlds)."""
        self.call("Runtime.enable")
        found = []
        deadline = time.time() + timeout
        self.s.settimeout(0.6)
        while time.time() < deadline:
            try:
                msg = json.loads(self._recv_frame())
            except (socket.timeout, TimeoutError, OSError):
                continue
            if msg.get("method") == "Runtime.executionContextCreated":
                c = msg["params"]["context"]
                found.append({"id": c["id"], "name": c.get("name", ""),
                              "origin": c.get("origin", "")})
        self.s.settimeout(30)
        return found

    def isolated_eval(self, expr, world_hint="TypeRight", await_promise=True):
        """Evaluate inside the extension's isolated content-script world."""
        frame = self.call("Page.getFrameTree")["frameTree"]["frame"]["id"]
        wid = self.call("Page.createIsolatedWorld", frameId=frame,
                        worldName="cdp-probe", grantUniveralAccess=True)
        return self.eval(expr, await_promise=await_promise,
                         context_id=wid["executionContextId"])

    def close(self):
        try: self.s.close()
        except Exception: pass


def page(url_contains="test-page"):
    for t in targets():
        if t["type"] == "page" and url_contains in t["url"]:
            return WS(t["webSocketDebuggerUrl"])
    raise SystemExit("page not found: " + url_contains)


if __name__ == "__main__":
    for t in targets():
        print(t["type"], "|", t["title"][:40], "|", t["url"][:100])
