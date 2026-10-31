import time

from alps_logger.parser import newline_required, parse_line
from alps_logger.recorder import Recorder
from alps_logger.storage import Store


def test_parse_pair_and_single():
    assert parse_line("a=123,b=-4") == ("sample", (123, -4))
    assert parse_line("a=5") == ("sample", (5, None))
    assert parse_line("b=6") == ("sample", (None, 6))
    assert parse_line("version:2.0.1") == ("version", "2.0.1")
    assert parse_line("SAMPLE_THRESHOLD=8000") == ("threshold", 8000)
    assert parse_line("hello") == ("text", "hello")


def test_newline_rules():
    assert not newline_required("1.0")
    assert not newline_required("1.0.0")
    assert newline_required("1.0.5")


def make(tmp_path):
    store = Store(str(tmp_path / "t.sqlite3"))
    return store, Recorder(store)


def test_print_lifecycle_creates_one_session(tmp_path):
    store, rec = make(tmp_path)
    rec.on_print_update("standby", None, 0.0, True)
    assert rec.session_id is None
    rec.on_print_update("printing", "benchy.gcode", 0.2, True)
    sid = rec.session_id
    assert sid is not None
    for i in range(5):
        rec.on_sample(100 + i, 90 + i)
    rec.on_print_update("printing", "benchy.gcode", 0.4, True)
    assert rec.session_id == sid
    rec.on_print_update("paused", "benchy.gcode", 0.4, True)
    assert rec.session_id == sid
    rec.on_print_update("complete", "benchy.gcode", 10.0, True)
    assert rec.session_id is None
    s = store.get_session(sid)
    assert s["n"] == 5 and s["ended"] is not None and s["name"] == "benchy.gcode"
    assert len(list(store.iter_samples(sid))) == 5


def test_manual_session_not_stopped_by_moonraker(tmp_path):
    store, rec = make(tmp_path)
    sid = rec.start_session("manual")
    rec.on_print_update("complete", None, 0.0, True)
    assert rec.session_id == sid
    rec.stop_session()
    assert rec.session_id is None


def test_moonraker_outage_keeps_session(tmp_path):
    store, rec = make(tmp_path)
    rec.on_print_update("printing", "a.gcode", 1.0, True)
    sid = rec.session_id
    rec.on_print_update(None, None, None, False)
    assert rec.session_id == sid


def test_downsample_keeps_spike(tmp_path):
    store = Store(str(tmp_path / "t.sqlite3"))
    sid = store.start_session("x", "manual")
    now = time.time()
    rows = [(now + i * 0.01, 10 if i != 777 else 9999, 10, None) for i in range(5000)]
    store.add_samples(sid, rows)
    pts = store.downsampled(sid, 500)
    assert len(pts) <= 500
    assert max(p[3] for p in pts) == 9999
    assert store.downsampled(sid, 10**6)[0][1] == 10


def test_crash_recovery_closes_open_sessions(tmp_path):
    store = Store(str(tmp_path / "t.sqlite3"))
    sid = store.start_session("x", "manual")
    store.add_samples(sid, [(time.time(), 1, 1, None)])
    reopened = Store(str(tmp_path / "t.sqlite3"))
    assert reopened.get_session(sid)["ended"] is not None
