"""Sample sources: the real ALPS over USB serial, and a simulator for testing without hardware."""
import math
import random
import threading
import time

from .parser import newline_required, parse_line


class _BaseSource(threading.Thread):
    def __init__(self, recorder):
        super().__init__(daemon=True)
        self.rec = recorder
        self._halt = threading.Event()
        recorder.send_command = self.send_command

    def stop(self) -> None:
        self._halt.set()

    def send_command(self, cmd: str) -> None:
        raise NotImplementedError


def find_port(spec: str) -> str:
    if spec != "auto":
        return spec
    from serial.tools import list_ports

    ports = list(list_ports.comports())
    if len(ports) == 1:
        return ports[0].device
    names = ", ".join(f"{p.device} ({p.description})" for p in ports) or "none found"
    raise RuntimeError(f"--port auto needs exactly one serial port; found: {names}")


class SerialSource(_BaseSource):
    def __init__(self, recorder, port: str, baud: int = 115200):
        super().__init__(recorder)
        self.port_spec = port
        self.baud = baud
        self._ser = None
        self._write_lock = threading.Lock()
        self._newline = True

    def send_command(self, cmd: str) -> None:
        if self._ser is None:
            raise RuntimeError("device not connected")
        with self._write_lock:
            self._ser.write((cmd + ("\n" if self._newline else "")).encode())
        self.rec.on_message("> " + cmd)

    def run(self) -> None:
        while not self._halt.is_set():
            try:
                self._connect_and_read()
            except Exception as e:  # noqa: BLE001 - keep retrying on any device error
                self.rec.on_device(False, str(e))
            finally:
                self._ser = None
            self._halt.wait(2.0)

    def _connect_and_read(self) -> None:
        import serial

        port = find_port(self.port_spec)
        ser = serial.Serial(port, self.baud, timeout=0.1, write_timeout=2)
        self._ser = ser
        try:
            # stop any stream left running, then detect firmware version (same handshake as the web tool)
            ser.write(b"uv\n")
            time.sleep(0.3)
            ser.reset_input_buffer()
            ser.write(b"version\n")
            deadline = time.time() + 1.0
            text = ""
            while time.time() < deadline and "version:" not in text:
                text += ser.read(256).decode(errors="replace")
            kind, version = parse_line(next((ln for ln in text.splitlines() if "version:" in ln), ""))
            version = version if kind == "version" else "1.0"
            self._newline = newline_required(version)
            self.rec.on_device(True, None, version)
            self.send_command("rt")
            self.send_command("v")

            buf = ""
            while not self._halt.is_set():
                data = ser.read(ser.in_waiting or 1)
                if not data:
                    continue
                buf += data.decode(errors="replace")
                *lines, buf = buf.split("\n")
                for ln in lines:
                    self._handle(ln)
        finally:
            try:
                ser.write(b"uv\n" if self._newline else b"uv")
            except Exception:  # noqa: BLE001
                pass
            ser.close()
            self.rec.on_device(False, self.rec.device_error)

    def _handle(self, line: str) -> None:
        kind, value = parse_line(line)
        if kind == "sample":
            self.rec.on_sample(*value)
        elif kind == "threshold":
            self.rec.on_threshold(value)
            self.rec.on_message(line.strip())
        elif kind == "text" and value:
            self.rec.on_message(str(value))


class SimulatedSource(_BaseSource):
    """Produces a plausible pressure trace with periodic 'touches' so the UI can be tried without hardware."""

    def __init__(self, recorder, rate_hz: float = 100.0):
        super().__init__(recorder)
        self.rate = rate_hz
        self.threshold = 8000

    def send_command(self, cmd: str) -> None:
        parts = cmd.split()
        if parts[0] == "set" and len(parts) == 2:
            self.threshold = int(parts[1])
        if parts[0] in ("rt", "set"):
            self.rec.on_threshold(self.threshold)
            self.rec.on_message(f"SAMPLE_THRESHOLD={self.threshold}")
        self.rec.on_message("> " + cmd)

    def run(self) -> None:
        self.rec.on_device(True, None, "sim-2.0.0")
        self.rec.on_threshold(self.threshold)
        filt = 0.0
        t0 = time.time()
        period = 1.0 / self.rate
        nxt = t0
        while not self._halt.is_set():
            t = time.time() - t0
            touch = 12000 * max(0.0, math.sin(t * 0.8)) ** 6
            raw = int(touch + random.gauss(0, 150))
            filt += 0.2 * (raw - filt)
            self.rec.on_sample(raw, int(filt))
            nxt += period
            self._halt.wait(max(0.0, nxt - time.time()))
