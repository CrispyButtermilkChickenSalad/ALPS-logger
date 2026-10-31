"""Polls Moonraker for print state and toolhead Z so sessions follow print jobs."""
import json
import threading
import urllib.request
from typing import Callable, Optional


class MoonrakerPoller(threading.Thread):
    def __init__(self, base_url: str, on_update: Callable, api_key: Optional[str] = None, interval: float = 0.5):
        super().__init__(daemon=True)
        self.url = base_url.rstrip("/") + "/printer/objects/query?print_stats&toolhead"
        self.on_update = on_update
        self.api_key = api_key
        self.interval = interval
        self._halt = threading.Event()

    def stop(self) -> None:
        self._halt.set()

    def poll_once(self) -> None:
        req = urllib.request.Request(self.url)
        if self.api_key:
            req.add_header("X-Api-Key", self.api_key)
        try:
            with urllib.request.urlopen(req, timeout=3) as resp:
                status = json.load(resp)["result"]["status"]
            pos = status.get("toolhead", {}).get("position") or [None] * 3
            stats = status.get("print_stats", {})
            self.on_update(stats.get("state"), stats.get("filename"), pos[2], True)
        except Exception:  # noqa: BLE001 - Moonraker may be down/restarting
            self.on_update(None, None, None, False)

    def run(self) -> None:
        while not self._halt.is_set():
            self.poll_once()
            self._halt.wait(self.interval)
