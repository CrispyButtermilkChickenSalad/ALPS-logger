import time

from fastapi.testclient import TestClient

from alps_logger.app import create_app
from alps_logger.recorder import Recorder
from alps_logger.sources import SimulatedSource
from alps_logger.storage import Store


def test_api_end_to_end(tmp_path):
    store = Store(str(tmp_path / "t.sqlite3"))
    rec = Recorder(store)
    src = SimulatedSource(rec, rate_hz=200)
    src.start()
    try:
        c = TestClient(create_app(rec, store))
        assert c.get("/").status_code == 200
        sid = c.post("/api/session/start", json={"name": "demo"}).json()["id"]
        assert c.post("/api/session/start", json={}).status_code == 409
        time.sleep(1.5)
        assert c.get("/api/status").json()["session_id"] == sid
        c.post("/api/session/stop")
        assert c.post("/api/threshold", json={"value": 1234}).status_code == 200
        assert c.get("/api/status").json()["threshold"] == 1234

        pts = c.get(f"/api/sessions/{sid}/samples?max_points=100").json()["points"]
        assert 0 < len(pts) <= 100
        csv_text = c.get(f"/api/sessions/{sid}/csv").text.splitlines()
        assert csv_text[0] == "t_s,epoch,raw,filtered,z" and len(csv_text) > 100
        assert c.delete(f"/api/sessions/{sid}").status_code == 200
        assert c.get(f"/api/sessions/{sid}/samples").status_code == 404

        with c.websocket_connect("/ws") as ws:
            assert ws.receive_json()["type"] == "history"
            assert ws.receive_json()["type"] in ("samples", "status")
    finally:
        src.stop()
        rec.close()
