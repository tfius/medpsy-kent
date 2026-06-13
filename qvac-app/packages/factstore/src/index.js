// Node entry point — wires the platform-agnostic core to Node defaults (sha256 + ids)
// and re-exports the public API. A Bare/browser build would provide its own hash/id.
import { FactStore } from "./store.js";
import { MemoryAdapter } from "./adapters/memory.js";
import { NodeFileAdapter } from "./adapters/node-file.js";
import { makeFactstoreTools } from "./tools.js";
import { sha256hex, randomId } from "./hash.js";

export { FactStore, MemoryAdapter, NodeFileAdapter, makeFactstoreTools, sha256hex };

// Convenience constructor with Node defaults. Pass { adapter } (defaults to in-memory),
// and optionally { signer, verify } to make exported bundles ed25519-signed/verifiable.
export function createFactStore(opts = {}) {
  return new FactStore({
    adapter: opts.adapter || new MemoryAdapter(),
    hash: sha256hex,
    now: () => new Date().toISOString(),
    newId: () => randomId("stmt"),
    ...opts,
  });
}
