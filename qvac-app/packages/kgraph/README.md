# @qvac/kgraph

A **domain-neutral, bi-temporal knowledge graph** built **over** [`@qvac/factstore`](../factstore)
— by *injection*, so factstore is never modified. Medical is just a pack. See the full design in
[`../../KGRAPH_DESIGN.md`](../../KGRAPH_DESIGN.md).

**Tenets:** sound · grounded · factual · locally-trusted.

```js
import { createKnowledgeGraph } from "@qvac/kgraph";
import { createFactStore } from "@qvac/factstore";

const kg = createKnowledgeGraph(createFactStore(), { pack: myPack }); // pack = { ontology, log }

await kg.assertNode("thing:a", { attrs: { label: "Alpha" } });
await kg.assertEdge({ from: "thing:a", predicate: "related_to", to: "thing:b" }); // one direction
await kg.neighbors("thing:b");                  // → reaches a (symmetry derived at read)
await kg.expand("thing:a", { depth: 2, predicates: ["related_to"] });
await kg.paths("thing:a", "thing:d", { maxHops: 2 });        // bounded → confidence-ranked → top-k
await kg.ground({ id: "rel", from: "x", via: ["related_to"] }, { x: "thing:a" }); // factual only
```

## What it adds over factstore
- **Schema-as-data + edge epistemics** — predicates are declared `factual` (may *ground* a
  decision) or `associative` (may only *suggest*). `ground()` refuses associative predicates.
- **Typed, bounded traversal** — `expand` / `paths` over a **materialized adjacency index**
  (cold-started from one `foldView`, kept in lockstep on `assertEdge`). Hard depth/hop caps.
- **Read-time invariants** — symmetry/inverse are derived when reading (the CRDT merges
  statements, not graph invariants), so an edge is written once.
- **Forward-compatible validation** — an unknown predicate (e.g. from a mesh peer on a newer
  pack) is flagged `unschema'd`, never dropped; recipes only traverse declared predicates.
- **Grounded answers** — every result carries factstore **receipts** (statement hashes).

## Build-over, don't-modify
kgraph takes a factstore instance and uses only its public API
(`assert`/`fold`/`foldView`/`neighbors`). It does **not** import or change factstore. Domain
**packs** live app-side (so kgraph stays free of domain vocabulary); the test-suite uses a generic
*toy* pack to prove neutrality with no app present.

`npm test` — `node --test` (the tests import factstore by relative path; no install needed).
