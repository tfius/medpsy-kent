// Node hash + id helpers. Kept separate (and out of the core) so chainlog.js / store.js
// stay platform-agnostic — a Bare/browser entry would supply its own sha256 + id.
import crypto from "node:crypto";

export const sha256hex = (s) => crypto.createHash("sha256").update(s).digest("hex");
export const randomId = (prefix = "id") => `${prefix}-${crypto.randomBytes(6).toString("hex")}`;
