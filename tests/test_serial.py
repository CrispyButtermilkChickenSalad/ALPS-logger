import threading
import time

import serial

from alps_logger.recorder import Recorder
from alps_logger.sources import SerialSource
from alps_logger.storage import Store


class FakeAlps:
    """Mimics the ALPS text protocol; legacy=True behaves like fw 1.0.0 (no newline, separate a=/b= lines)."""

    instances = []

    def __init__(self, port, baud, timeout=0.1, write_timeout=None, legacy=False):
        self.legacy = type(self).legacy
        self.rx = b""
        self.out = bytearray()
        self.streaming = False
        self.closed = False
        self.written = []
        self.lock = threading.Lock()
        self.threshold = 8000
        type(self).instances.append(self)

    legacy = False

    @property
    def in_waiting(self):
        return len(self.out)

    def reset_input_buffer(self):
        with self.lock:
            self.out.clear()

    def write(self, data):
        self.written.append(data)
        cmds = [data.strip()] if not self.legacy else [data]
        for c in cmds:
            if c == b"version" and not self.legacy:
                self._emit(b"version:2.0.0\n")
            elif c == b"rt":
                self._emit(b"SAMPLE_THRESHOLD=%d\n" % self.threshold)
            elif c == b"v":
                self.streaming = True
            elif c == b"uv":
                self.streaming = False

    def _emit(self, b):
        with self.lock:
            self.out += b

    def read(self, n=1):
        time.sleep(0.01)
        if self.streaming:
            self._emit(b"a=100,b=90\na=101,b=91\n" if not self.legacy else b"a=100\nb=90\n")
        with self.lock:
            data, self.out = bytes(self.out[:n]), self.out[n:]
        return data

    def close(self):
        self.closed = True


def run_source(tmp_path, monkeypatch, legacy):
    FakeAlps.legacy = legacy
    FakeAlps.instances.clear()
    monkeypatch.setattr(serial, "Serial", FakeAlps)
    store = Store(str(tmp_path / "t.sqlite3"))
    rec = Recorder(store)
    src = SerialSource(rec, "FAKE")
    src.start()
    deadline = time.time() + 5
    while time.time() < deadline and rec.latest_seq() < 4:
        time.sleep(0.05)
    return rec, src


def test_modern_firmware_handshake(tmp_path, monkeypatch):
    rec, src = run_source(tmp_path, monkeypatch, legacy=False)
    try:
        assert rec.version == "2.0.0" and rec.connected
        assert rec.threshold == 8000
        assert rec.live[0][2:4] == (100, 90)
        assert b"v\n" in FakeAlps.instances[0].written
    finally:
        src.stop()
        src.join(3)
    assert FakeAlps.instances[0].closed


def test_legacy_firmware_has_no_newlines_and_split_lines(tmp_path, monkeypatch):
    rec, src = run_source(tmp_path, monkeypatch, legacy=True)
    try:
        assert rec.version == "1.0"
        assert b"v" in FakeAlps.instances[0].written
        assert (100, None) in [r[2:4] for r in rec.live]
        assert (None, 90) in [r[2:4] for r in rec.live]
    finally:
        src.stop()
        src.join(3)
