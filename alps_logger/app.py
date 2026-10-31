"""FastAPI app: REST + websocket + static UI."""
import asyncio
import csv
import io
import os
from typing import Optional

from fastapi import FastAPI, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel

from .recorder import Recorder
from .storage import Store

STATIC = os.path.join(os.path.dirname(__file__), "static")


class StartBody(BaseModel):
    name: Optional[str] = None


class ThresholdBody(BaseModel):
    value: int


def create_app(recorder: Recorder, store: Store) -> FastAPI:
    app = FastAPI(title="ALPS logger")

    @app.get("/")
    def index():
        return FileResponse(os.path.join(STATIC, "index.html"))

    @app.get("/api/status")
    def status():
        return recorder.status()

    @app.post("/api/session/start")
    def start(body: StartBody):
        try:
            return {"id": recorder.start_session(body.name)}
        except RuntimeError as e:
            raise HTTPException(409, str(e))

    @app.post("/api/session/stop")
    def stop():
        try:
            recorder.stop_session()
        except RuntimeError as e:
            raise HTTPException(409, str(e))
        return {"ok": True}

    @app.get("/api/sessions")
    def sessions():
        return store.list_sessions()

    @app.get("/api/sessions/{sid}/samples")
    def samples(sid: int, max_points: int = Query(4000, ge=10, le=50000)):
        if not store.get_session(sid):
            raise HTTPException(404, "no such session")
        # columns: t, raw_mean, raw_min, raw_max, filt_mean, z_mean
        return {"session": store.get_session(sid), "points": store.downsampled(sid, max_points)}

    @app.get("/api/sessions/{sid}/csv")
    def csv_export(sid: int):
        s = store.get_session(sid)
        if not s:
            raise HTTPException(404, "no such session")

        def gen():
            buf = io.StringIO()
            w = csv.writer(buf)
            w.writerow(["t_s", "epoch", "raw", "filtered", "z"])
            yield buf.getvalue()
            for t, raw, filt, z in store.iter_samples(sid):
                buf.seek(0)
                buf.truncate()
                w.writerow([f"{t - s['started']:.4f}", f"{t:.4f}", "" if raw is None else raw,
                            "" if filt is None else filt, "" if z is None else z])
                yield buf.getvalue()

        safe = "".join(ch if ch.isalnum() or ch in "-_." else "_" for ch in s["name"])
        return StreamingResponse(
            gen(), media_type="text/csv", headers={"Content-Disposition": f'attachment; filename="alps_{sid}_{safe}.csv"'}
        )

    @app.delete("/api/sessions/{sid}")
    def delete(sid: int):
        if recorder.session_id == sid:
            raise HTTPException(409, "session is recording")
        store.delete_session(sid)
        return {"ok": True}

    @app.post("/api/threshold/read")
    def read_threshold():
        try:
            recorder.send_command("rt")
        except Exception as e:  # noqa: BLE001
            raise HTTPException(503, str(e))
        return {"ok": True}

    @app.post("/api/threshold")
    def set_threshold(body: ThresholdBody):
        if body.value < 0:
            raise HTTPException(422, "threshold must be >= 0")
        try:
            recorder.send_command(f"set {body.value}")
            recorder.send_command("rt")
        except Exception as e:  # noqa: BLE001
            raise HTTPException(503, str(e))
        return {"ok": True}

    @app.websocket("/ws")
    async def ws(sock: WebSocket):
        await sock.accept()
        # replay the last ~30 s so the chart isn't empty on connect
        history = recorder.since(0)[-3000:]
        last = history[-1][0] if history else recorder.latest_seq()
        try:
            await sock.send_json({"type": "history", "data": [list(r[1:]) for r in history]})
            ticks = 0
            while True:
                await asyncio.sleep(0.1)
                rows = recorder.since(last)
                if rows:
                    last = rows[-1][0]
                    await sock.send_json({"type": "samples", "data": [list(r[1:]) for r in rows]})
                ticks += 1
                if ticks % 10 == 0:
                    await sock.send_json({"type": "status", "data": recorder.status()})
        except (WebSocketDisconnect, RuntimeError):
            return

    return app
