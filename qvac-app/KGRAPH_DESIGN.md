# `@qvac/kgraph` — a grounded, bi-temporal, federated knowledge graph

**Status:** design — first cut (pending team ratification) · **Substrate:** `@qvac/factstore`
(already built) · **Author:** medpsy-kent team

> One sentence: a **domain-neutral knowledge-graph layer over factstore** that grounds decisions
> **only on crisp, factual, locally-trusted edges resolved to standard vocabularies** — associative
> knowledge is *suggestion-only*, trust is *never* inherited from a peer, and medical is just the
> first pack.

**Design tenets (load-bearing — everything below serves these):**
1. **Sound** — bounded, deterministic traversal; no probabilistic multi-hop inference dressed up as fact.
2. **Grounded** — every answer returns the exact factstore statements (receipts) it stands on.
3. **Factual** — decisions ground only on *factual* edges; *associative* edges may suggest, never conclude.
4. **Locally trusted** — grounding-eligibility is always a local decision; a peer's say-so is only evidence.

---

## 1. Why, and the core bet

We already proved the hard parts. `@qvac/factstore` is a **bi-temporal triple store**
(`subject — predicate — object`, object = literal *or* `{ref}` typed edge) with append-only
hash-chained statements, valid-time + transaction-time, signed export/import bundles, a
multi-writer CRDT merge (`foldView`), pluggable adapters (Memory / NodeFile / Hypercore), graph
reads (`neighbors`, `edgesAmong`), and a trust layer (source-rank conflict resolution,
`confirm/reject`, confirmed-only reads). On top of it, `medlens.js` already runs a **one-domain,
one-predicate graph** (`drug —interacts_with→ drug`) the agent traverses and the mesh grows.

**The bet:** that drug graph is a special case — and crucially, a *safe* one, because
`interacts_with` is a **curated fact**, the traversal is **1-hop**, and promotion is **local**.
The engine is free; what's missing is a thin, domain-neutral layer that **preserves those three
safety properties while generalizing to more node/edge types**. Medical becomes **pack #1**; a
toy pack in the test-suite proves neutrality from day one; a non-medical demo pack (incident-ops)
proves it for humans later.

**What this is NOT:** not a new datastore (factstore is it); not SPARQL/OWL; not "model all of
medicine"; **not multi-hop probabilistic inference** (the dangerous part — see §3 epistemics);
not a comprehensive medical brain — a **targeted safety net** for high-value, can't-miss relations.

---

## 2. Layered architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│ Bindings    agent tools (auto from recipes) · /api/kg/* · graph UI    │
├─────────────────────────────────────────────────────────────────────┤
│ Domain packs   medical · incident-ops · …                             │
│   each: { ontology, seed(store), recipes, resolve }                   │
├─────────────────────────────────────────────────────────────────────┤
│ @qvac/kgraph (NEW)  — built OVER factstore's public API; factstore UNTOUCHED │
│   schema-as-data + epistemics · validated assertNode/assertEdge       │
│   expand · bounded paths · materialized adjacency index               │
│   recipe runner (factual-grounding rule) · provenance/confirmed-only  │
│   federation POLICY (promotion is local) · standard-vocab + OKF map   │
├─────────────────────────────────────────────────────────────────────┤
│ @qvac/factstore — the SUBSTRATE (frozen, proven; NOT modified)        │
│   bi-temporal signed statements · adapters · CRDT merge · receipts    │
│   assert · fold · foldView · neighbors · edgesAmong · bundles · OKF    │
└─────────────────────────────────────────────────────────────────────┘
```

**The neutrality invariant:** the core contains **zero domain vocabulary** — all medical-ness
lives in the (app-side) domain packs. **Boundary choice — build-over, don't-modify:** factstore
stays the frozen, proven substrate; `@qvac/kgraph` is a **separate package built on factstore's
public read/write API** (`assert`/`fold`/`foldView`/`neighbors`/`edgesAmong`). Everything new —
schema, epistemics, `expand`/`paths`, the materialized adjacency index, recipes, federation policy
— lives in kgraph. (kgraph takes a factstore instance by injection; it doesn't even hard-depend on
the package.) Rationale: don't regress a tested, possibly-shared substrate for a benefit only we'd
use; move the index *down* into factstore later only if a second consumer needs traversal.

---

## 3. Data model

A **node** is a typed subject; an **edge** is a typed `{ref}` statement; an **attribute** is a
literal statement on a node. All three are factstore statements → all three are bi-temporal,
signed, federatable.

| Concept | factstore encoding |
|---|---|
| Node id | `"<kind>:<canonicalKey>"`; prefer a **standard vocabulary** as the key (`rxcui:855332`, `icd:I21.9`) over a slug |
| Node kind | id prefix (stable, immutable) **and** a queryable `kind` attribute |
| Attribute | `assert(log, { subject:node, predicate:"label", object:"Warfarin" })` |
| Edge | `assert(log, { subject:from, predicate, object:{ref:to}, meta:{ epistemics, source, confidence, … } })` |
| Schema | stored **as facts** in `kg:schema@<pack>` → versioned, bi-temporal, federatable |

**Edge epistemics — the most important field (safety).** Every predicate is declared as one of:
- **`factual`** — deterministic, curated relations a decision may *ground* on: `interacts_with`,
  `contraindicated_in`, `codes_as`, `allergic_to`, `depends_on` (incident-ops).
- **`associative`** — probabilistic/contextual priors that may only *suggest*, never conclude:
  `indicates`/`presents_with` (symptom→condition). A symptom maps to many conditions; traversing
  these as if factual manufactures false confidence. **Recipes may not ground on associative edges**
  — they surface them as "consider…" to the clinician/LLM, which still reasons.

**Ontology meta-model** (itself data — it time-travels + merges like everything else):

```ts
type Predicate = {
  name: string;
  epistemics: "factual" | "associative";   // §6: only factual edges ground decisions
  valueType: "ref" | "literal";
  domain?: string[]; range?: string[];       // authoring-hygiene constraints, NOT truth gates
  symmetric?: boolean; inverseOf?: string; cardinality?: "one" | "many";
  // semantics are FROZEN + append-only: to change a predicate's meaning, add `indicates_v2` —
  // never redefine, or edges asserted under the old meaning get silently misread.
};
```

**Rules that fall out of the substrate:**
- **Identity is immutable** — a node's `kind` is part of its id; reclassifying = a *new* node + a
  `maps_to` edge. (First `:` splits; `canonicalKey` carries no `:`.)
- **Invariants are derived at READ time, not enforced at write.** The CRDT merges *statements*, not
  *graph invariants* — independent writers can half-write a symmetric pair or conflict on
  `cardinality:one`. So the layer re-derives symmetry/inverse closure and resolves cardinality
  (source-ranked) **when reading**; it never trusts them as stored.
- **Forward-compatible validation** — an unknown kind/predicate (e.g. from a peer on a newer pack)
  is **accepted and flagged `unschema'd`, never dropped** (else a mesh upgrade silently loses
  edges); recipes only ever traverse *known, declared* predicates.
- **Patient/instance subgraphs** (`patient:<encounterId>`) are separate, **local-only logs** —
  never federated. Only the de-identified concept graph travels.

---

## 4. Core API (generic, on-device, bounded)

```ts
const kg = createKnowledgeGraph(store, { pack: medicalPack });

kg.kinds(); kg.predicates(); kg.schemaFor(predicate);          // introspect (from schema-as-data)
await kg.assertNode(id, { kind, attrs });
await kg.assertEdge({ from, predicate, to, meta });            // symmetry/inverse derived at read

// reads — every call takes an optional bi-temporal slice { validAt, knownAt }
kg.getNode(id, slice?);
kg.neighbors(id, { predicates?, kinds?, dir?, minConfidence?, slice? });
kg.expand(id, { depth<=N, predicates?, kinds?, slice? });
kg.paths(from, to, { maxHops<=N, predicates?, minConfidence?, topK?, slice? }); // BFS → confidence-rank → top-k
kg.ground(recipeId, params, slice?);                           // → { answer, paths, receipts } (factual edges only)
```

- **No generic `match([{s,p,o}…])` in v1** — it's a baby SPARQL and an attractive nuisance. The
  *only* sanctioned query surfaces are **recipes** (reviewed) + `expand`/`paths`. Ad-hoc patterns
  aren't reviewed, so they don't ground decisions.
- **Performance:** never `fold` per hop. **kgraph** builds a **materialized adjacency index** over
  factstore's reads — cold-started from one `foldView` and kept in lockstep because every edge
  write goes through `kgraph.assertEdge` → traversal is O(neighbors). The hot index is the *current*
  graph; the rarer **as-of** (`knownAt`) audit-replay query bypasses the index and folds-with-slice.
  Two tiers. (factstore is not modified to support this.)
- **`paths`** = bounded BFS within a tiny `maxHops` (2–3) above a `minConfidence` floor, ranked by
  aggregate edge confidence, top-k. (Confidence-weighted shortest-path deferred until corpora grow.)
- **Recipe inputs are bound/factual**, never free LLM extraction (see §5).
- **`ground()` pins one `knownAt`** across all edges in all returned paths, so a replay is coherent.

---

## 5. Recipes — grounding vs. suggestion (the holism payoff)

A **recipe** is a declarative, named query template → auto-exposed as an agent tool **and** an
HTTP endpoint. Declarative-first so it's **serializable → federatable, auditable, UI-renderable**.

```ts
type Recipe = {
  id: string; mode: "ground" | "suggest";   // ground => factual edges ONLY
  params: Record<string, "node" | "node[]">; // bound/factual inputs, not free text
  steps: TraversalStep[];                     // start · expand/path filters
  project: OutputSpec;                        // shape { answer, paths, receipts }
  rank?: string;                              // OPTIONAL named, allow-listed scorer (NOT inline JS)
  describe: string;
};
```

The escape hatch is a **named, registered** scorer (allow-listable, reviewable) — never arbitrary
inline code — so even a ranking recipe stays an inspectable artifact.

**Medical pack — v1 recipes are all `ground`/factual:**
- `screen_interactions(meds[])` — today's medlens, as a recipe (back-compat).
- `contraindications(drug, patientConditions[])` — `drug —contraindicated_in→ condition` ∩ patient conditions.
- `allergy_conflicts(drug, allergies[])` — `drug —in_class→ class —allergen_of→` ∩ patient allergies.
- **`differential(symptoms)` is DEFERRED** — it traverses *associative* edges; in v1, at most a
  `suggest`-mode recall ("conditions to consider"), never a grounded ICD. Out of the v1 critical path.

**Incident-ops pack (neutrality demo) — factual:**
- `blast_radius(service)` — `service —depends_on*→ services` (bounded transitive closure, cycles).
- `owners(service)` — `service —owned_by→ team —on_call→ person`.

Same engine, same primitives, same receipts — only data differs. Inputs come from the **patient
record (factual) or a bound candidate** — the model never feeds a hallucinated id (medlens already
enforces bound-subject authority).

---

## 6. Lifecycle, provenance, safety & entity resolution (non-negotiable)

- **Grounding rule:** only **`factual`** edges that are **`authored`/`imported` or locally
  promoted** ground a decision. Associative edges and un-promoted candidates never do.
- **Entity resolution = resolve to a standard vocabulary; reuse what we have.** Node ids are
  RxNorm (drugs) / ICD-10 (diagnoses) where they exist. Text→code resolution **reuses the existing
  embedding-based ICD lookup** (the resolver we already built) rather than a per-pack synonym map.
  ER is a **safety surface** (the medlens "Coumadin"/"Nurofen 400mg" bug was an ER miss): dosed/
  brand names normalize to the canonical node, or an interaction is a silent false-negative.
- **Source-rank conflict resolution** (EHR > clinician > patient-report > learned), surfacing the
  overridden source, not dropping it (factstore has this).
- **Bi-temporal "as-of"** earns its keep precisely where it matters: **transaction-time** for
  audit-replay ("which edges existed when we decided"), **both axes** on the patient longitudinal
  record ("on warfarin since 2024, stopped March"). A corrected/retracted edge never silently
  rewrites a past decision's provenance.
- **Per-pack eval gate** — a labelled query set (like the ICD 20-case set) measuring
  recall/precision **and** a "no dangerous false-negative" guard. No pack ships without green eval.
- **Pack isolation** — separate logs; a recipe traverses only its pack's namespace.

---

## 7. Federation & interchange — **promotion is local, evidence travels**

The single most important federation rule. A peer's *promoted* edge must **never** auto-ground on
my kiosk — that would make trust transitive and let one sloppy/compromised kiosk poison the mesh
(a fabricated `interacts_with`, or a `retract` that removes a real one).

- **Edges federate as PROPOSALS** carrying provenance + the originating device signature + any vet
  votes. **Each kiosk applies its own grounding policy** to decide eligibility locally: e.g. a
  local clinician confirm, OR *N* independent signed vets from roster members, OR a designated
  **authority key** for curated/imported "authored" sets. Retracts are proposals too.
- Reuse the existing rails (`consult.js` jury + `kb-sync.js` replication, signed + membership-gated)
  — generalize from "drug pairs" to any pack predicate, but **grounding-eligibility stays local.**
- **Privacy (unchanged):** concept↔concept edges are non-PHI and federate; **patient subgraphs
  never leave the device.** Drug names cross the wire; patients do not.
- **Interchange:** OKF (typed→untyped, lossy) + signed factstore bundles (lossless). Per-pack
  mapping to standards: medical → RxNorm/ICD-10/(later)SNOMED; mapping is pack config, not core code.

---

## 8. Relationship to existing code (migration — additive)

| Today | Becomes |
|---|---|
| `src/medlens.js` (drug interactions) | `packs/medical` — factual recipes + new factual predicates |
| `kb:medical` log | kept **by alias** (no copy-forward — forking the signed chain helps nothing); `kg:schema@medical` alongside |
| `screen_interactions` tool | a recipe-bound tool (same behaviour, back-compat) |
| embedding ICD lookup | **reused as the entity resolver** for `icd:`/`condition:` nodes |
| edge-learning / signals | generic graph-learning over any pack predicate, **promotion local** |
| Knowledge page | a **graph explorer** (nodes/edges/paths, provenance, time-slice) |
| `data/knowledge/*.md` | seed source; plus **import authoritative datasets** (see §10) |

The scripted 9-step triage and current agents keep working; the KG is opt-in grounding, exactly as
medlens is today.

---

## 9. Plan (phased; each shippable + evaluated)

- **Phase 0 — Design ratify (this doc).**
- **Phase 1 — kgraph core (over factstore, factstore untouched).** New `packages/kgraph`:
  schema-as-data (+ epistemics), validated assertNode/assertEdge (read-time symmetry/inverse),
  `expand` + bounded `paths` + a **materialized adjacency index** built on factstore's
  `foldView`/`neighbors`, bi-temporal slicing, confirmed/**factual-only** reads. **Domain-neutrality
  proven by a TOY pack in the kgraph test-suite from day one** (no app, no medical content).
- **Phase 2 — Recipe runner + bindings.** Declarative recipes (ground/suggest) → auto agent tools +
  `/api/kg/*`; audit receipts on every ground.
- **Phase 3 — Medical pack (factual, targeted).** Generalize medlens; add `condition`/`icd`/
  `allergy` nodes + `contraindicated_in`/`codes_as`/`allergic_to` edges; **ER via RxNorm/ICD +
  the embedding resolver**; **bulk-import authoritative interaction/contraindication datasets** as
  `source:imported` (don't hand-type a corpus); recipes (interactions, contraindications,
  allergy_conflicts); eval set; wire into triage + agent. *(differential stays suggest-only/out.)*
- **Phase 4 — Federation + UI.** Edges over the mesh as **proposals**; **local promotion policy**;
  concepts-only privacy; graph-explorer page.
- **Phase 5 — Holism demo (optional / post-hackathon).** The incident-ops pack end-to-end
  (`blast_radius` transitive closure + `owners`) — proves structural, not lexical, neutrality.

---

## 10. Risks, non-goals, design choices

**Risks → mitigations**
- *Soft-edge false confidence* → **edge epistemics**; ground on factual only; associative = suggest; differential deferred.
- *Federated poisoning / transitive trust* → **promotion is local, evidence travels**; signed proposals + local policy.
- *Content cold-start* (hand-typed KG stays too small to fire) → **targeted** high-value relations + **import authoritative datasets** with provenance; comprehensiveness is a non-goal.
- *Entity-resolution misses* (safety) → standard vocabularies as ids + reuse the embedding resolver; dosed/brand normalization tested.
- *Traversal cost on kiosk HW* → materialized adjacency index; hard hop/confidence caps; no fold-per-hop.
- *Query scope creep* → no generic `match` in v1; recipes + expand + paths only.
- *CRDT can't enforce graph invariants* → symmetry/inverse/cardinality derived & resolved at read time.

**Non-goals (v1):** OWL/SPARQL/inference; unbounded transitive closure; multi-hop probabilistic
differential as a *grounded* output; LLM-extracted edges grounding decisions (LLM may *propose* →
must be vetted); comprehensive domain coverage; trust inherited from peers.

**Design choices (this cut — pending ratification):**
1. Node id = stable `kind:` prefix **+** queryable `kind` attribute, preferring **standard-vocab keys**; kind immutable.
2. **Schema-as-data**, seeded from a git-reviewable manifest; **forward-compatible validation** (unknown → flagged, not dropped).
3. **Edge epistemics (`factual`/`associative`)**; only factual edges ground; predicate semantics frozen/append-only.
4. Recipes **declarative-first**, `ground`/`suggest` modes, **bound/factual inputs**, named (not inline) scorer escape hatch.
5. `paths` = bounded **BFS → confidence-rank → top-k**; **no generic `match`** in v1.
6. Graph **invariants derived at read time** (CRDT merges statements, not invariants).
7. **Promotion is local; evidence (signed proposals + votes) travels** — no transitive trust.
8. **Entity resolution via standard vocabularies**, reusing the existing embedding ICD resolver.
9. Migrate `kb:medical` by **alias**. `@qvac/kgraph` is a **separate package built OVER factstore's public API** (factstore frozen/untouched) — traversal + index + policy all in kgraph; domain packs live app-side. (Move the index into factstore later only if a second consumer needs it.)
10. Content: **targeted safety net** seeded from authored + **imported authoritative datasets**, not a hand-built comprehensive graph.
11. Second pack = **incident-ops** (transitive closure + multi-hop) — neutrality proof; demo, doesn't inflate v1.
