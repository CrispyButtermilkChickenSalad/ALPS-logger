"""Central state: live ring buffer, print/session lifecycle, and sample persistence."""
import threading
import time
from collections import deque
from typing import Callable, Deque, List, Optional, Tuple

from .storage import Store

ACTIVE_STATES = {"printing"}
END_STATES = {"complete", "cancelled", "error", "standby"}
FLUSH_INTERVAL = 1.0


class Recorder:
    def __init__(self, store: Store):
        self.store = store
        self._lock = threading.RLock()
        self.live: Deque[Tuple[int, float, Optional[int], Optional[int], Optional[float]]] = deque(maxlen=60000)
        self._seq = 0
        self._pending: List[tuple] = []
        self._last_flush = time.time()
        self.session_id: Optional[int] = None
        self.session_auto = False
        self.session_name: Optional[str] = None
        self.print_state = "unknown"
        self.filename: Optional[str] = None
        self.z: Optional[float] = None
        self.moonraker_ok: Optional[bool] = None
        self.connected = False
        self.device_error: Optional[str] = None
        self.version: Optional[str] = None
        self.threshold: Optional[int] = None
        self.messages: Deque[str] = deque(maxlen=200)
        self._rate_window: Deque[float] = deque(maxlen=500)
        self.send_command: Callable[[str], None] = lambda cmd: (_ for _ in ()).throw(
            RuntimeError("no device source configured")
        )

    # ---- device callbacks -------------------------------------------------
    def on_sample(self, raw: Optional[int], filt: Optional[int]) -> None:
        t = time.time()
        with self._lock:
            self._seq += 1
            self.live.append((self._seq, t, raw, filt, self.z))
            self._rate_window.append(t)
            if self.session_id is not None:
                self._pending.append((t, raw, filt, self.z))
                if t - self._last_flush >= FLUSH_INTERVAL:
                    self._flush_locked()

    def on_message(self, text: str) -> None:
        with self._lock:
            self.messages.append(text)

    def on_device(self, connected: bool, error: Optional[str] = None, version: Optional[str] = None) -> None:
        with self._lock:
            self.connected = connected
            self.device_error = error
            if version is not None:
                self.version = version
            if not connected:
                self._rate_window.clear()

    def on_threshold(self, value: int) -> None:
        with self._lock:
            self.threshold = value

    # ---- moonraker callback ----------------------------------------------
    def on_print_update(self, state: Optional[str], filename: Optional[str], z: Optional[float], ok: bool) -> None:
        with self._lock:
            self.moonraker_ok = ok
            if not ok:
                return
            self.z = z
            self.filename = filename or None
            prev, self.print_state = self.print_state, state or "unknown"
            if self.print_state in ACTIVE_STATES and self.session_id is None:
                self._start_locked(self.filename or "print", "moonraker", auto=True)
            elif self.print_state in END_STATES and self.session_id is not None and self.session_auto:
                self._stop_locked()

    # ---- sessions ---------------------------------------------------------
    def start_session(self, name: Optional[str] = None) -> int:
        with self._lock:
            if self.session_id is not None:
                raise RuntimeError("a session is already recording")
            return self._start_locked(name or time.strftime("manual %Y-%m-%d %H:%M:%S"), "manual", auto=False)

    def stop_session(self) -> None:
        with self._lock:
            if self.session_id is None:
                raise RuntimeError("no session is recording")
            self._stop_locked()

    def _start_locked(self, name: str, source: str, auto: bool) -> int:
        self.session_id = self.store.start_session(name, source)
        self.session_name = name
        self.session_auto = auto
        self._last_flush = time.time()
        return self.session_id

    def _stop_locked(self) -> None:
        self._flush_locked()
        if self.session_id is not None:
            self.store.end_session(self.session_id)
        self.session_id = None
        self.session_name = None
        self.session_auto = False

    def _flush_locked(self) -> None:
        if self.session_id is not None and self._pending:
            self.store.add_samples(self.session_id, self._pending)
        self._pending = []
        self._last_flush = time.time()

    def close(self) -> None:
        with self._lock:
            if self.session_id is not None:
                self._stop_locked()

    # ---- queries ----------------------------------------------------------
    def since(self, seq: int) -> list:
        with self._lock:
            return [s for s in self.live if s[0] > seq]

    def latest_seq(self) -> int:
        with self._lock:
            return self._seq

    def status(self) -> dict:
        with self._lock:
            now = time.time()
            recent = [t for t in self._rate_window if now - t <= 2.0]
            rate = (len(recent) - 1) / (recent[-1] - recent[0]) if len(recent) > 2 and recent[-1] > recent[0] else 0.0
            return {
                "connected": self.connected,
                "device_error": self.device_error,
                "version": self.version,
                "threshold": self.threshold,
                "rate_hz": round(rate, 1),
                "session_id": self.session_id,
                "session_name": self.session_name,
                "session_auto": self.session_auto,
                "print_state": self.print_state,
                "filename": self.filename,
                "z": self.z,
                "moonraker_ok": self.moonraker_ok,
                "messages": list(self.messages)[-30:],
            }
