export class Bridge {
  constructor({ url, token, fetchImpl = fetch }) {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1') throw Error('Bridge must use loopback HTTP');
    this.url = parsed.origin; this.token = token; this.fetch = fetchImpl;
  }
  async request(path, data) {
    const response = await this.fetch(this.url + path, {
      method: data === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: data === undefined ? undefined : JSON.stringify(data), signal: AbortSignal.timeout(1500)
    });
    if (!response.ok) throw Error(`Bridge ${response.status}: ${await response.text()}`);
    return response.json();
  }
  state() { return this.request('/state'); }
  observe() { return this.request('/observe'); }
  history() { return this.request('/history'); }
  /** Arms the client-side safety tier. It then runs whether or not this process is responsive. */
  reflex(state, armed) { return this.request('/reflex', { armed, session: state.session, epoch: state.epoch }); }
  /** Read-only frame fetch. Returns the bytes plus the age the client reported for them. */
  async frame() {
    const response = await this.fetch(this.url + '/frame', { headers: { Authorization: `Bearer ${this.token}` }, signal: AbortSignal.timeout(4000) });
    if (response.status === 404 || response.status === 503) throw Error(`No frame available: ${(await response.json()).error ?? response.status}`);
    if (!response.ok) throw Error(`Bridge ${response.status}: ${await response.text()}`);
    const header = name => response.headers.get(`x-windove-${name}`);
    return { bytes: Buffer.from(await response.arrayBuffer()), capturedAt: Number(header('captured-at')), ageMs: Number(header('age-ms')),
      fresh: header('fresh') === 'true', width: Number(header('width')), height: Number(header('height')), session: header('session') };
  }
  /**
   * Cancel whatever the client is doing. `keepSafety` marks a stop the agent issued to cancel its
   * own job: work stops, but the client safety tier stays armed. An operator stop does not pass it.
   */
  stop(options = {}) { return this.request('/stop', options); }
  lease(state) { return this.request('/lease', { session: state.session, epoch: state.epoch }); }
  respawn(state, id) { return this.request('/respawn', { session: state.session, epoch: state.epoch, observedAt: state.observedAt, id }); }
  navigate(goal, state, id) { return this.request('/navigate', { ...goal, session: state.session, epoch: state.epoch, observedAt: state.observedAt, id }); }
  /** The one way in. Every action carries the same identity, freshness, deadline and scope. */
  act(action, state, id, deadlineMs, scope = 'travel', assumes) {
    const { type, ...args } = action;
    return this.request('/act', { type, args, scope, actionId: id, id, deadlineMs,
      ...(assumes && Object.keys(assumes).length ? { assumes } : {}),
      session: state.session, epoch: state.epoch, observedAt: state.observedAt });
  }
}
