"""Gate-verification spike: stand-in for the Agent Family rule service (Matrix side).

In-memory state only. Decides sends / membership changes for the Synapse module and
serves attachments after asking Synapse whether the caller may see the event.
Throwaway code for the base-selection gate. Not product code.
"""
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HS = os.environ.get("HS_URL", "http://127.0.0.1:8008")
AS_TOKEN = os.environ.get("AS_TOKEN", "")
PORT = int(os.environ.get("RULES_PORT", "9100"))

frozen = set()      # room ids
approved = set()    # (room id, user id) allowed to be invited / to join
mode = {"v": "ok"}  # ok | hang | 500
log = []


def decide(p):
    kind = p.get("kind")
    if kind == "send":
        return p["room"] not in frozen
    if kind == "member":
        if p.get("membership") in ("invite", "join"):
            return (p["room"], p["target"]) in approved
        return False  # kicks / bans by ordinary members are never allowed
    if kind == "state":
        return p["room"] not in frozen and p.get("type") in ("m.room.name", "m.room.topic")
    return False


def hs_get(path, token):
    req = urllib.request.Request(HS + path, headers={"Authorization": "Bearer " + token})
    return urllib.request.urlopen(req, timeout=10)


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        n = int(self.headers.get("content-length") or 0)
        return json.loads(self.rfile.read(n) or b"{}")

    def do_POST(self):
        if self.path == "/check":
            p = self._body()
            if mode["v"] == "hang":
                time.sleep(30)
            if mode["v"] == "500":
                log.append({**p, "allow": "500"})
                return self._json(500, {"error": "simulated failure"})
            ok = decide(p)
            log.append({**p, "allow": ok})
            return self._json(200, {"allow": ok})
        if self.path == "/admin/freeze":
            p = self._body()
            (frozen.add if p.get("frozen", True) else frozen.discard)(p["room"])
            return self._json(200, {"frozen": sorted(frozen)})
        if self.path == "/admin/approve":
            p = self._body()
            approved.add((p["room"], p["user"]))
            return self._json(200, {"ok": True})
        if self.path == "/admin/mode":
            mode["v"] = self._body()["mode"]
            return self._json(200, mode)
        self._json(404, {})

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        if u.path == "/admin/log":
            return self._json(200, log[-200:])
        if u.path == "/af/media":
            return self.media(urllib.parse.parse_qs(u.query))
        self._json(404, {})

    def media(self, q):
        """Serve an attachment only if Synapse lets the caller read the event that carries it."""
        auth = self.headers.get("Authorization", "")
        if not auth.startswith("Bearer "):
            return self._json(401, {"error": "missing token"})
        room, event = q.get("room", [""])[0], q.get("event", [""])[0]
        try:
            path = "/_matrix/client/v3/rooms/%s/event/%s" % (urllib.parse.quote(room), urllib.parse.quote(event))
            with hs_get(path, auth[7:]) as r:  # asked with the CALLER's token
                ev = json.loads(r.read())
        except urllib.error.HTTPError as e:
            return self._json(403, {"error": "event not visible to caller", "hs_status": e.code})
        mxc = (ev.get("content") or {}).get("url", "")
        if not mxc.startswith("mxc://"):
            return self._json(404, {"error": "event has no attachment"})
        server, media_id = mxc[6:].split("/", 1)
        with hs_get("/_matrix/client/v1/media/download/%s/%s" % (server, media_id), AS_TOKEN) as r:
            data = r.read()
            self.send_response(200)
            self.send_header("content-type", r.headers.get("content-type", "application/octet-stream"))
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()
