"""Line parser for the FLY-ALPS USB serial protocol (derived from Mellow's web tool)."""
import re
from typing import Optional, Tuple

PAIR = re.compile(r"^a=(-?\d+),b=(-?\d+)$")
SINGLE = re.compile(r"^([ab])=(-?\d+)$")
VERSION = re.compile(r"version:(\S+)")
THRESHOLD = re.compile(r"SAMPLE_THRESHOLD=(\d+)")


def parse_line(line: str) -> Tuple[str, object]:
    """Return (kind, value).

    kind is one of:
      "sample"    value = (raw, filtered); either may be None (fw 1.0.0 sends a= and b= separately)
      "version"   value = version string
      "threshold" value = int
      "text"      value = the stripped line
    """
    line = line.strip()
    m = PAIR.match(line)
    if m:
        return "sample", (int(m.group(1)), int(m.group(2)))
    m = SINGLE.match(line)
    if m:
        v = int(m.group(2))
        return "sample", (v, None) if m.group(1) == "a" else (None, v)
    m = VERSION.search(line)
    if m:
        return "version", m.group(1)
    m = THRESHOLD.search(line)
    if m:
        return "threshold", int(m.group(1))
    return "text", line


def newline_required(version: Optional[str]) -> bool:
    """Firmware 1.0/1.0.0 expects commands without a trailing newline."""
    return version not in (None, "1.0", "1.0.0")
