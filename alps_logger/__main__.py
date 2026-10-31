import argparse
import os
import sys

import uvicorn

from .app import create_app
from .moonraker import MoonrakerPoller
from .recorder import Recorder
from .sources import SerialSource, SimulatedSource
from .storage import Store


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="alps_logger", description="Web logger for the Mellow FLY-ALPS pressure module")
    ap.add_argument("--port", help="ALPS serial port (COM5, /dev/ttyACM0, or 'auto' if only one port exists)")
    ap.add_argument("--simulate", action="store_true", help="use a simulated device instead of serial")
    ap.add_argument("--baud", type=int, default=115200)
    ap.add_argument("--moonraker", help="Moonraker URL, e.g. http://localhost:7125 (enables per-print sessions)")
    ap.add_argument("--moonraker-api-key", default=os.environ.get("MOONRAKER_API_KEY"))
    ap.add_argument("--db", default="alps_logs.sqlite3", help="SQLite database path")
    ap.add_argument("--host", default="127.0.0.1", help="web UI bind address (use 0.0.0.0 for LAN)")
    ap.add_argument("--web-port", type=int, default=8085)
    args = ap.parse_args(argv)

    if not args.simulate and not args.port:
        ap.error("--port is required (or use --simulate)")

    store = Store(args.db)
    rec = Recorder(store)
    source = SimulatedSource(rec) if args.simulate else SerialSource(rec, args.port, args.baud)
    source.start()
    poller = None
    if args.moonraker:
        poller = MoonrakerPoller(args.moonraker, rec.on_print_update, args.moonraker_api_key)
        poller.start()

    server = uvicorn.Server(uvicorn.Config(create_app(rec, store), host=args.host, port=args.web_port, log_level="info"))
    try:
        server.run()
    finally:
        source.stop()
        if poller:
            poller.stop()
        rec.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
