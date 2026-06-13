// In-memory storage adapter — for tests, ephemeral sessions, and the browser.
// An adapter is just: append(log, line), read(log) -> lines[], list() -> log ids.
export class MemoryAdapter {
  constructor() { this.logs = new Map(); }
  async append(log, line) {
    if (!this.logs.has(log)) this.logs.set(log, []);
    this.logs.get(log).push(line);
  }
  async read(log) { return (this.logs.get(log) || []).slice(); }
  async list() { return [...this.logs.keys()]; }
}
