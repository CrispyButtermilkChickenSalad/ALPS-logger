#!/usr/bin/env python3
"""ALPS-logger bridge: streams Klipper's raw load-cell samples to the ALPS-logger web app.

Moonraker cannot forward Klipper's bulk "load_cell/dump_force" stream, so this small script (standard library only)
connects to Klipper's API socket on the host, subscribes to that stream and serves it over HTTP:

    GET /stream?cell=load_cell_probe   newline-delimited JSON, ~10 lines/s:
                                       {"now": <host epoch>, "rows": [[epoch, counts, grams|null], ...], "errors": n}
    GET /status                        small JSON health check

It only *reads*: it does not send G-code, tare, or change any Klipper setting. Run it on the Klipper host:

    python3 alps_klipper_bridge.py [--socket ~/printer_data/comms/klippy.sock] [--port 7126]

Klipper must have been started with an API socket (-a), which Moonraker already requires.
"""
import argparse
import json
import os
import queue
import socket
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

ETX = b"\x03"


class Hub:
    """Keeps one Klipper subscription per load cell and fans batches out to HTTP clients."""

    def __init__(self, sock_path, connect=None):
        self.sock_path = sock_path
        self.connect = connect or self._connect_unix
        self.lock = threading.Lock()
        self.clients = {}  # cell -> set(queue)
        self.workers = {}
        self.last_error = None
        self.samples = 0

    def subscribe(self, cell):
        q = queue.Queue(maxsize=200)
        with self.lock:
            self.clients.setdefault(cell, set()).add(q)
            if cell not in self.workers:
                t = threading.Thread(target=self._run, args=(cell,), daemon=True)
                self.workers[cell] = t
                t.start()
        return q

    def unsubscribe(self, cell, q):
        with self.lock:
            self.clients.get(cell, set()).discard(q)

    def _publish(self, cell, msg):
        line = (json.dumps(msg, separators=(",", ":")) + "\n").encode()
        with self.lock:
            targets = list(self.clients.get(cell, ()))
        for q in targets:
            try:
                q.put_nowait(line)
            except queue.Full:
                pass  # slow client: drop rather than stall the stream

    def _run(self, cell):
        while True:
            try:
                self._stream(cell)
            except Exception as e:  # reconnect forever; Klipper restarts are normal
                self.last_error = str(e)
                self._publish(cell, {"error": self.last_error})
            time.sleep(2)

    def _connect_unix(self):
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.connect(self.sock_path)
        return s

    def _stream(self, cell):
        s = self.connect()
        req = {"id": 1, "method": "load_cell/dump_force", "params": {"load_cell": cell, "response_template": {}}}
        s.sendall(json.dumps(req).encode() + ETX)
        buf = b""
        offset = None
        while True:
            chunk = s.recv(65536)
            if not chunk:
                raise ConnectionError("Klipper closed the API socket")
            buf += chunk
            *msgs, buf = buf.split(ETX)
            for raw in msgs:
                if not raw.strip():
                    continue
                m = json.loads(raw)
                if m.get("id") == 1 and "error" in m:
                    raise RuntimeError("Klipper: " + str(m["error"].get("message", m["error"])))
                p = m.get("params")
                if not p or "data" not in p:
                    continue
                now = time.time()
                if not p["data"]:
                    continue
                # Sample times are on Klipper's own clock; anchor it to arrival time with a smoothed offset.
                est = now - p["data"][-1][0]
                offset = est if offset is None or abs(est - offset) > 1.0 else offset + 0.02 * (est - offset)
                rows = [[round(t + offset, 6), counts, grams] for t, grams, counts, _tare in p["data"]]
                self.samples += len(rows)
                errs = p.get("errors")
                self._publish(cell, {"now": now, "rows": rows, "errors": sum(errs) if isinstance(errs, list) else errs})


def make_handler(hub):
    class H(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def _cors(self):
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Private-Network", "true")

        def do_OPTIONS(self):
            self.send_response(204)
            self._cors()
            self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "*")
            self.send_header("Content-Length", "0")
            self.end_headers()

        def do_GET(self):
            u = urlparse(self.path)
            if u.path == "/status":
                body = json.dumps({"ok": True, "samples": hub.samples, "last_error": hub.last_error}).encode()
                self.send_response(200)
                self._cors()
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            elif u.path == "/stream":
                cell = parse_qs(u.query).get("cell", ["load_cell_probe"])[0]
                q = hub.subscribe(cell)
                self.send_response(200)
                self._cors()
                self.send_header("Content-Type", "application/x-ndjson")
                self.send_header("Cache-Control", "no-store")
                self.send_header("Connection", "close")
                self.end_headers()
                try:
                    while True:
                        try:
                            self.wfile.write(q.get(timeout=5))
                        except queue.Empty:
                            self.wfile.write(b"\n")  # keep-alive; also detects a closed client
                        self.wfile.flush()
                except (BrokenPipeError, ConnectionResetError, OSError):
                    pass
                finally:
                    hub.unsubscribe(cell, q)
                self.close_connection = True
            else:
                self.send_error(404)

        def log_message(self, *a):
            pass

    return H


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--socket", default="~/printer_data/comms/klippy.sock", help="Klipper API socket")
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--port", type=int, default=7126)
    a = ap.parse_args()
    hub = Hub(os.path.expanduser(a.socket))
    srv = ThreadingHTTPServer((a.host, a.port), make_handler(hub))
    srv.daemon_threads = True
    print(f"ALPS bridge on http://{a.host}:{a.port}  (Klipper socket {hub.sock_path})")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
