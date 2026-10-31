// Optional Klipper integration: polls Moonraker for print state + toolhead Z so sessions follow print jobs.
export class MoonrakerPoller {
  constructor(baseUrl, onUpdate, { apiKey = '', interval = 250, fetchFn = (...a) => fetch(...a) } = {}) {
    this.base = baseUrl.replace(/\/+$/, '');
    this.url = this.base + '/printer/objects/query?print_stats&toolhead&motion_report';
    this.onUpdate = onUpdate;
    this.apiKey = apiKey;
    this.interval = interval;
    this.fetch = fetchFn;
    this.running = false;
  }

  async pollOnce() {
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), 3000);
    try {
      const headers = this.apiKey ? { 'X-Api-Key': this.apiKey } : {};
      const r = await this.fetch(this.url, { headers, signal: ctl.signal });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const st = (await r.json()).result.status;
      const mr = st.motion_report && st.motion_report.live_position;
      const pos = (mr && mr.length >= 3 ? mr : st.toolhead && st.toolhead.position) || [];
      const ps = st.print_stats || {};
      this.onUpdate(ps.state, ps.filename, pos[2] ?? null, true, pos[0] ?? null, pos[1] ?? null);
    } catch {
      this.onUpdate(null, null, null, false);
    } finally {
      clearTimeout(to);
    }
  }

  // Downloads a gcode file from Moonraker's "gcodes" root.
  async fetchGcode(filename) {
    const path = filename.split('/').map(encodeURIComponent).join('/');
    const headers = this.apiKey ? { 'X-Api-Key': this.apiKey } : {};
    const r = await this.fetch(`${this.base}/server/files/gcodes/${path}`, { headers });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.text();
  }

  start() {
    if (this.running) return;
    this.running = true;
    (async () => {
      while (this.running) {
        await this.pollOnce();
        await new Promise((r) => setTimeout(r, this.interval));
      }
    })();
  }

  stop() { this.running = false; }
}

// An https page cannot talk to plain-http Moonraker (mixed content), except on localhost.
export function mixedContentProblem(pageProtocol, url) {
  try {
    const u = new URL(url);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
    return pageProtocol === 'https:' && u.protocol === 'http:' && !local;
  } catch {
    return false;
  }
}
