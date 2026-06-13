import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FactStore } from "../src/index.js";
import { sha256hex } from "../src/hash.js";
import { HypercoreAdapter } from "../src/adapters/hypercore.js";

// Proves the hypercore-backed storage works end-to-end (single-writer durability +
// chain verify + multi-writer foldView merge). Real cross-device replication over
// hyperswarm is the remaining step and isn't exercised here.
test("FactStore over HypercoreAdapter: assert/fold/verify + multi-writer foldView merge", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "factstore-hc-"));
  const adapter = new HypercoreAdapter({ storage: dir });
  const store = new FactStore({ adapter, hash: sha256hex, now: () => "2026-01-01T00:00:00.000Z", newId: () => "x" });
  try {
    // Device A and Device B write to their own append-only hypercores.
    await store.assert("patient:7@A", { statementId: "m1", subject: "patient:7", predicate: "takes", object: { name: "warfarin" }, validFrom: "2024-01-01" });
    await store.assert("patient:7@B", { statementId: "c1", subject: "patient:7", predicate: "diagnosed", object: { name: "hypertension" }, validFrom: "2023-01-01" });

    // Round-trip through hypercore storage: each sub-log verifies.
    assert.ok((await store.verify("patient:7@A")).ok, "device-A chain verifies from hypercore");
    assert.ok((await store.verify("patient:7@B")).ok, "device-B chain verifies from hypercore");
    assert.deepEqual((await adapter.list()).filter((l) => l.startsWith("patient:7")).sort(), ["patient:7@A", "patient:7@B"]);

    // The merged view over both device cores sees both facts (the CRDT merge).
    const view = await store.foldView("patient:7", { subject: "patient:7", validAt: "2026-06-01" });
    assert.equal(view.facts.length, 2);
    assert.deepEqual(view.facts.map((f) => f.predicate).sort(), ["diagnosed", "takes"]);
  } finally {
    await adapter.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
