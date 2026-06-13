# @qvac/factstore

A holistic, **bi-temporal**, provenanced, tamper-evident fact store. Domain-agnostic on
purpose: it stores triples (`subject — predicate → object`) where the object is a literal
(an *attribute*) or a `{ ref }` (a graph *edge*), each with two time axes:

- **valid time** — `validFrom`/`validTo`: when the fact is true in reality.
- **transaction time** — the chain's `ts`: when the system recorded it.

Facts are **append-only**; they evolve by superseding assertions (`end`/`correct`/`retract`),
never by mutation. Every read returns a **receipt** (the chain-anchored statement hashes it
resolved to), so a decision can be pinned to immutable facts and reproduced "as known at" a
past time. Storage is a pluggable **adapter** (in-memory, Node files, or a future
hypercore/P2P adapter), and the core takes an injected hash function — so it runs in Node,
Bare runtime, or the browser.

This is the agnostic *substrate*. Domain knowledge (vocabulary, validators, views, trust
policy) lives in **lenses** on top — e.g. a medical lens that turns it into a patient record.

## Quick start

```js
import { createFactStore, NodeFileAdapter, makeFactstoreTools } from "@qvac/factstore";

const store = createFactStore({ adapter: new NodeFileAdapter({ dir: "./facts" }) });

// assert a fact (object can be a literal or { ref })
await store.assert("patient:123", {
  subject: "patient:123", predicate: "takes",
  object: { name: "warfarin", dose: "5mg" }, validFrom: "2024-03-01",
  source: "intake", actor: "clinician",
});

// current state + receipt
const { facts, receipt } = await store.fold("patient:123", { subject: "patient:123" });

// agent get/put tools (write-gated): "none" | "propose" | "full"
const tools = makeFactstoreTools(store, { log: "patient:123", allowWrite: "propose" });
```

## API

- `assert(log, {subject, predicate, object, validFrom?, validTo?, source, actor, confidence?, meta?, statementId?})`
- `end(log, statementId, validTo, opts?)` — close a fact's valid interval (a real-world event)
- `correct(log, statementId, {object?, validFrom?, validTo?, ...})` — a system fix (history preserved)
- `retract(log, statementId, opts?)` — asserted in error (excluded, never deleted)
- `fold(log, {subject?, predicate?, validAt?, knownAt?})` → `{ facts, receipt }`
- `timeline(log, {subject?, predicate?})` → ordered history
- `neighbors(log, subject, {predicate?, direction?})` → one-hop edges
- `verify(log)` → chain integrity
- `exportBundle(log)` / `importBundle(bundle)` — signed, shareable (P2P custody handoff)

## Storage adapters

`MemoryAdapter`, `NodeFileAdapter({ dir })`. An adapter is just `append(log, line)`,
`read(log) -> string[]`, `list() -> string[]`. A `HypercoreAdapter` (per-device single-writer
chains + Autobase merge) is the documented path to multi-writer P2P replication.

## What this is NOT

No query language (datalog/SPARQL), no ontology framework, no multi-hop traversal in the
core — consumers repeat `neighbors`. The bounded surface is deliberate. See issue #5.

## Test

```
npm test    # node --test
```
