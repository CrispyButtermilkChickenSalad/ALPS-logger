import http.client
import importlib.util
import json
import socket
import threading
import time
from http.server import ThreadingHTTPServer
from pathlib import Path

spec = importlib.util.spec_from_file_location("bridge", Path(__file__).parent.parent / "bridge" / "alps_klipper_bridge.py")
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)

def fake_klipper(srv, ready):
    srv.listen(1)
    ready.set()
    conn, _ = srv.accept()
    buf = b""
    while bridge.ETX not in buf:
        buf += conn.recv(4096)
    req = json.loads(buf.split(bridge.ETX)[0])
    assert req["method"] == "load_cell/dump_force" and req["params"]["load_cell"] == "load_cell_probe"
    conn.sendall(json.dumps({"id": 1, "result": {"header": ["time", "force (g)", "counts", "tare_counts"]}}).encode() + bridge.ETX)
    t = time.monotonic()
    data = {"params": {"data": [[t, None, 1234, None], [t + 0.002, 1.5, 1240, 1000]], "errors": [0, 0], "overflows": 0}}
    for _ in range(50):
        conn.sendall(json.dumps(data).encode() + bridge.ETX)
        time.sleep(0.1)


def test_bridge_streams_ndjson_with_epoch_times():
    # The bridge's Klipper link is a unix socket; the protocol is identical over loopback TCP, which also runs on Windows.
    ksrv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    ksrv.bind(("127.0.0.1", 0))
    ready = threading.Event()
    threading.Thread(target=fake_klipper, args=(ksrv, ready), daemon=True).start()
    assert ready.wait(5)
    hub = bridge.Hub("fake", connect=lambda: socket.create_connection(ksrv.getsockname()))
    srv = ThreadingHTTPServer(("127.0.0.1", 0), bridge.make_handler(hub))
    srv.daemon_threads = True
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        c = http.client.HTTPConnection("127.0.0.1", srv.server_port, timeout=5)
        c.request("GET", "/stream?cell=load_cell_probe")
        r = c.getresponse()
        assert r.status == 200 and r.getheader("Access-Control-Allow-Origin") == "*"
        line = r.fp.readline()
        while not line.strip():
            line = r.fp.readline()
        m = json.loads(line)
        assert abs(m["now"] - time.time()) < 5
        assert [row[1] for row in m["rows"]] == [1234, 1240]
        assert abs(m["rows"][0][0] - time.time()) < 5
        assert m["rows"][1][2] == 1.5
        c.close()
        c2 = http.client.HTTPConnection("127.0.0.1", srv.server_port, timeout=5)
        c2.request("GET", "/status")
        assert json.loads(c2.getresponse().read())["samples"] >= 2
    finally:
        srv.shutdown()
