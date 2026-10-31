"""SQLite storage: one row per print session, one row per sample."""
import sqlite3
import threading
import time
from contextlib import contextmanager
from typing import Iterator, List, Optional, Sequence, Tuple

SCHEMA = """
CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    source TEXT NOT NULL,
    started REAL NOT NULL,
    ended REAL,
    n INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS samples (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    t REAL NOT NULL,
    raw INTEGER,
    filt INTEGER,
    z REAL
);
CREATE INDEX IF NOT EXISTS samples_session ON samples(session_id, id);
"""

Row = Tuple[float, Optional[int], Optional[int], Optional[float]]


class Store:
    def __init__(self, path: str):
        self.path = path
        self._write_lock = threading.Lock()
        with self._conn() as c:
            c.execute("PRAGMA journal_mode=WAL")
            c.executescript(SCHEMA)
            # close sessions left open by a crash/power loss
            c.execute(
                "UPDATE sessions SET ended = COALESCE((SELECT MAX(t) FROM samples WHERE session_id = sessions.id), started) "
                "WHERE ended IS NULL"
            )

    @contextmanager
    def _conn(self) -> Iterator[sqlite3.Connection]:
        c = sqlite3.connect(self.path, timeout=10)
        c.execute("PRAGMA foreign_keys=ON")
        try:
            with c:
                yield c
        finally:
            c.close()

    def start_session(self, name: str, source: str) -> int:
        with self._write_lock, self._conn() as c:
            cur = c.execute(
                "INSERT INTO sessions(name, source, started) VALUES (?,?,?)", (name, source, time.time())
            )
            return int(cur.lastrowid)

    def end_session(self, session_id: int) -> None:
        with self._write_lock, self._conn() as c:
            c.execute("UPDATE sessions SET ended=? WHERE id=?", (time.time(), session_id))

    def add_samples(self, session_id: int, rows: Sequence[Row]) -> None:
        if not rows:
            return
        with self._write_lock, self._conn() as c:
            c.executemany(
                "INSERT INTO samples(session_id, t, raw, filt, z) VALUES (?,?,?,?,?)",
                [(session_id, *r) for r in rows],
            )
            c.execute("UPDATE sessions SET n = n + ? WHERE id=?", (len(rows), session_id))

    def list_sessions(self) -> List[dict]:
        with self._conn() as c:
            c.row_factory = sqlite3.Row
            return [dict(r) for r in c.execute("SELECT * FROM sessions ORDER BY id DESC")]

    def get_session(self, session_id: int) -> Optional[dict]:
        with self._conn() as c:
            c.row_factory = sqlite3.Row
            r = c.execute("SELECT * FROM sessions WHERE id=?", (session_id,)).fetchone()
            return dict(r) if r else None

    def delete_session(self, session_id: int) -> None:
        with self._write_lock, self._conn() as c:
            c.execute("DELETE FROM sessions WHERE id=?", (session_id,))

    def iter_samples(self, session_id: int) -> Iterator[Row]:
        c = sqlite3.connect(self.path, timeout=10)
        try:
            yield from c.execute(
                "SELECT t, raw, filt, z FROM samples WHERE session_id=? ORDER BY id", (session_id,)
            )
        finally:
            c.close()

    def downsampled(self, session_id: int, max_points: int) -> List[list]:
        """Bucket the session into <= max_points rows: [t, raw_mean, raw_min, raw_max, filt_mean, z_mean].

        min/max of raw are kept so short spikes survive decimation.
        """
        max_points = max(10, max_points)
        with self._conn() as c:
            first = c.execute("SELECT MIN(id), COUNT(*) FROM samples WHERE session_id=?", (session_id,)).fetchone()
            first_id, count = first
            if not count:
                return []
            stride = max(1, -(-count // max_points))
            rows = c.execute(
                "SELECT AVG(t), AVG(raw), MIN(raw), MAX(raw), AVG(filt), AVG(z) FROM samples "
                "WHERE session_id=? GROUP BY (id - ?) / ? ORDER BY MIN(id)",
                (session_id, first_id, stride),
            ).fetchall()
            return [list(r) for r in rows]
