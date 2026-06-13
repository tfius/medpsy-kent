// Node filesystem adapter — one append-only JSONL file per log under `dir`. Log ids may
// contain ':' and '/' (e.g. "patient:enc-123"), so they're URL-encoded into filenames
// and decoded back for list(). PHI lives here in the kiosk; the dir should be
// access-controlled / encrypted at rest in production (same posture as the audit dir).
import fs from "node:fs";
import path from "node:path";

export class NodeFileAdapter {
  constructor({ dir }) {
    if (!dir) throw new Error("NodeFileAdapter requires { dir }");
    this.dir = dir;
  }
  _file(log) { return path.join(this.dir, encodeURIComponent(log) + ".jsonl"); }
  async append(log, line) {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.appendFileSync(this._file(log), line + "\n");
  }
  async read(log) {
    try { return fs.readFileSync(this._file(log), "utf8").split("\n").filter(Boolean); }
    catch { return []; }
  }
  async list() {
    try { return fs.readdirSync(this.dir).filter((f) => f.endsWith(".jsonl")).map((f) => decodeURIComponent(f.slice(0, -6))); }
    catch { return []; }
  }
}
