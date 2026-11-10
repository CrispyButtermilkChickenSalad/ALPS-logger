# ALPS logger

Self-hosted web logger for the **Mellow FLY-ALPS pressure module**. It reads the module's raw/filtered ADC stream over its
USB-C serial port, shows it live in a browser, and records it to SQLite — automatically one session per print job when
Moonraker is available.

Works on **Raspberry Pi / Linux (next to Klipper + Moonraker)** and **Windows** (bench testing, or logging a remote
printer's print state).

> The serial protocol was reverse-engineered from Mellow's official web configuration tool
> (<https://mellow.klipper.cn/en/docs/ToolsDoc/fly-alps-tool>). It is not an officially documented protocol and may change with firmware.

## Web app (GitHub Pages) – no install

**https://crispybuttermilkchickensalad.github.io/ALPS-logger/**

A static, client-side app (source in `docs/`): Web Serial reads the ALPS over USB-C, data is stored in your browser (IndexedDB),
sessions can be viewed and exported as CSV. Nothing is uploaded.

- Needs a Chromium browser (Chrome/Edge desktop). Close Mellow's web tool first – only one program can hold the port.
- Keep the tab open while recording (optional "keep screen awake").
- **Optional Moonraker/Klipper:** enter the Moonraker URL to auto-start/stop a recording per print and log toolhead Z.
  Moonraker must list the page origin in `[authorization] cors_domains`. An https page cannot call a plain `http://` Moonraker
  (mixed content) unless you run the page from `http://localhost` (`python -m http.server --directory docs`),
  serve Moonraker over https, or allow insecure content for the site.
- **Long prints:** the *Capture for long prints* panel keeps a per-bucket summary trace (min/mean/max/noise) and per-layer statistics, and
  in the default mode only keeps full-rate samples around events. Event triggers (noise band, absolute deviation, slope, layer change,
  manual marker) can each be toggled. Summary-trace, layer and event data export as `.summary.csv`, `.layers.csv`, `.events.csv`.
- **Most recent session** and **Saved sessions in folder** sections: the folder list shows CSVs auto-saved to your chosen folder
  (View / Import into browser / open in G-code tab). The G-code and PA tabs can pick sessions from the browser or the folder.
  Folder CSVs hold counts only, and the Moonraker file name isn't stored in them.
- Try it without hardware using the **Simulator** button.
- Tests: `npm test`.

For unattended, always-on logging next to the printer, use the Python service below.

## Two data sources

The web app's **Source** selector (Record tab) picks where samples come from:

1. **Direct USB** (default): Web Serial to the ALPS over USB-C, using Mellow's stock firmware.
2. **Klipper via Moonraker**: for an ALPS flashed as a standalone Klipper MCU (see [autopa ALPS.md](https://github.com/G0BL1N/autopa/blob/main/docs/ALPS.md)). Nothing on Klipper is changed; the app only reads.
   - **Moonraker only (~5 Hz, calibrated)**: polls Klipper's `load_cell_probe` status. Klipper only reports force once the cell is calibrated (`LOAD_CELL_CALIBRATE`) and tared, and the value is a ~0.5 s mean, so this suits the summary/overview rather than fast PA analysis. Counts are reconstructed as `tare_counts + grams × counts_per_gram`.
   - **Full rate via bridge**: Moonraker cannot forward Klipper's bulk sample stream, so run `bridge/alps_klipper_bridge.py` on the Klipper host: `python3 alps_klipper_bridge.py` (stdlib only, Python 3.9+; for always-on use copy `bridge/alps-bridge.service` to `/etc/systemd/system/`, adjust the user/paths, then `sudo systemctl enable --now alps-bridge`). The app streams ~488 SPS raw counts from `http://<host>:7126`.

Print state and toolhead position still come from Moonraker, so the G-code sync works as with USB. Notes: Klipper's counts may be scaled differently from Mellow's USB "raw", so recalibrate per source; "filtered" equals raw for Klipper sources; an https page can't reach `http://` Moonraker or the bridge (run the app from `http://localhost`, or allow insecure content); Moonraker must list the page origin in `[authorization] cors_domains`.

## G-code preview & calibration (web app only)

- **G-code preview tab**: pick a recorded session and a G-code file (upload, or fetch from Moonraker). The toolpath is shown in 3D, each segment coloured by the ALPS counts logged while it was printed (mean / max / min / peak deviation, filtered or raw; layer slider; auto colour range).
- **Sync**: *Auto-fit from positions* matches changing X/Y/Z positions logged from Moonraker to the path. *Fit session start/end* instead maps the recording boundaries to the beginning and end of the estimated G-code timeline; no positions are needed. This is only an approximation: heating, homing, pauses, acceleration and pre/post-recording can shift intermediate moves. Use the manual offset/scale controls to refine it. Event-only recordings use summary buckets when available; gaps remain grey, and short moves are blurred. Raw summary extrema are bucket extrema, whereas filtered extrema are extrema of bucket means.
- **Path cursor**: the white marker and direction describe an estimated commanded XYZ segment, not a measured pose, force direction, tool geometry or actual tilt. Timing and interpolation are approximate. Rotary axes and G-code comments do not establish an executed nozzle orientation.
- **Calibration tab**: capture a tare and known-mass points to get counts/gram (least-squares), choose g/N/kg, or compute a theoretical estimate for a bridge load cell on the ADS131M02. Default is raw counts, since Mellow does not publish the ALPS sensor, gain or sensitivity. Guidance follows Klipper's [load cell docs](https://www.klipper3d.org/Load_Cell.html) and the TI datasheet. Settings are stored in the browser.

### Direction, tilt and interpretation

The ALPS gives one scalar measurement, not a 3D force vector. In a locally linear approximation the reading can respond to several force and moment components at once; a single value cannot uniquely recover them. Nozzle contact, friction and drag, acceleration, lever arms, mounting compliance, hysteresis, temperature and gravity can all alter the signal when travel direction or toolhead angle changes. A sign reversal is not by itself proof of a reversed extrusion force. Tilting changes the relationship between the bed, nozzle and sensing structure; even a known angle is insufficient for a correction without a validated mechanical model and independent measurements.

A known-mass fit describes the tested load direction, contact point, orientation and temperature; applying its g/N scale to another direction does not make the result a measured force in that direction. For characterization, repeat unloaded baselines and safe known loads at documented contact points in opposing directions and at each physically verified angle, including loading/unloading repeats and temperature, with an independent reference. Compare repeatability, drift and cross-sensitivity before building any directional calibration or compensation. Do not overload the hardware or use the preview to command a printer.
- **PA test tab**: generates a pressure-advance test G-code (in-air sweep, or lines on the bed for contact) and analyses a recording of it. Bursts are detected from the signal itself (no clock sync needed), per-K step-response metrics are computed, and K is estimated where the signed edge error crosses zero. Inspired by [KAPAT](https://github.com/vzagranichnyy/KAPAT) and [PrusaPATuner](https://github.com/CNCKitchen/PrusaPATuner). Experimental: untested on real extrusion hardware. See the wiki page *Pressure-Advance-Testing*.

## Python service (headless option)

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
- Recorded prints list, zoomable chart (min/max preserved when decimating), CSV download, delete. CSV `raw`/`filtered` are always ADC counts; if a calibration is applied, `force_raw_<unit>`/`force_filtered_<unit>` columns are appended and a `.meta.json` sidecar records the unit, counts/gram and tare
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
