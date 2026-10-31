# ALPS logger

Self-hosted web logger for the **Mellow FLY-ALPS pressure module**. It reads the module's raw/filtered ADC stream over its
USB-C serial port, shows it live in a browser, and records it to SQLite — automatically one session per print job when
Moonraker is available.

Works on **Raspberry Pi / Linux (next to Klipper + Moonraker)** and **Windows** (bench testing, or logging a remote
printer's print state).

> The serial protocol was reverse-engineered from Mellow's official web configuration tool
> (<https://mellow.klipper.cn/en/docs/ToolsDoc/fly-alps-tool>). It is not an officially documented protocol and may change with firmware.

## Protocol summary

115200 baud, text, newline-terminated (firmware 1.0 / 1.0.0 expects commands **without** a trailing newline; the logger detects this).

| Command | Meaning |
|---|---|
| `version` | replies `version:X.Y.Z` |
| `v` / `uv` | start / stop the data stream |
| `rt` | read threshold → `SAMPLE_THRESHOLD=<n>` |
| `set <n>` | set trigger threshold |

Stream lines: `a=<raw>,b=<filtered>` (fw 1.0.0 sends `a=` and `b=` on separate lines; the missing value is stored as NULL).
The logger never sends `flyboot` (bootloader).

## Features

- Live chart (raw, filtered, trigger threshold, toolhead Z when Moonraker is configured)
- Per-print sessions: starts on `print_stats.state == printing`, stops on complete / cancelled / error / standby
  (paused keeps recording; Moonraker outages don't end a session)
- Manual start/stop recording for bench work
- Recorded prints list, zoomable chart (min/max preserved when decimating), CSV download, delete
- Read/set the trigger threshold from the UI
- Auto-reconnect if the USB device is unplugged
- Simulator mode (`--simulate`) to try the UI with no hardware

## Install

Python 3.9+ required.

### Windows
```powershell
git clone <this repo> ; cd alps-logger
py -m venv .venv
.\.venv\Scripts\pip install -r requirements.txt
.\.venv\Scripts\python -m alps_logger --port COM5
```
Find the port in Device Manager → Ports. Open <http://127.0.0.1:8085>.

To follow prints on a remote Klipper machine, add `--moonraker http://<pi-ip>:7125` (the Pi's `moonraker.conf` must trust your PC in
`[authorization] trusted_clients`). The ALPS stays plugged into the PC in that case.

### Raspberry Pi / Linux (alongside Klipper)
```bash
git clone <this repo> ~/alps-logger && cd ~/alps-logger
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
sudo usermod -aG dialout $USER            # re-login afterwards
ls /dev/serial/by-id/                     # find the ALPS device
.venv/bin/python -m alps_logger --port /dev/serial/by-id/<your-alps> \
    --moonraker http://localhost:7125 --host 0.0.0.0
```
Run it as a service: edit `deploy/alps-logger.service` (user, paths, serial id), then
```bash
sudo cp deploy/alps-logger.service /etc/systemd/system/
sudo systemctl enable --now alps-logger
```
UI: `http://<pi-ip>:8085`.

## Options

| Flag | Default | |
|---|---|---|
| `--port` | – | serial port, or `auto` if exactly one serial port exists |
| `--simulate` | off | fake device |
| `--moonraker URL` | off | enables per-print sessions + Z logging |
| `--moonraker-api-key` / `MOONRAKER_API_KEY` | – | only if Moonraker requires a key |
| `--db` | `alps_logs.sqlite3` | database path |
| `--host` / `--web-port` | `127.0.0.1` / `8085` | UI bind address |

## Notes & limits

- Only **one program** can hold the serial port: close Mellow's web tool (and any terminal) while the logger runs. Klipper does not use this port.
- Timestamps are taken when lines arrive on the host, so USB buffering adds jitter of a few ms; the *order* and *rate* of samples are exact.
- **No authentication.** Anyone who can reach the UI can change the threshold or delete logs. Keep it on a trusted LAN or put it behind a reverse proxy with auth.
- Storage grows with sample rate × print time; the UI decimates for display but the database/CSV keep every sample.

## HTTP API

`GET /api/status`, `POST /api/session/start|stop`, `GET /api/sessions`, `GET /api/sessions/{id}/samples?max_points=`,
`GET /api/sessions/{id}/csv`, `DELETE /api/sessions/{id}`, `POST /api/threshold {"value": n}`, `POST /api/threshold/read`, WebSocket `/ws`.

## Development

```bash
pip install -r requirements-dev.txt
python -m pytest
python -m alps_logger --simulate
```
