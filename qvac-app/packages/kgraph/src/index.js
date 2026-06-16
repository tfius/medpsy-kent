// @qvac/kgraph — public API. A domain-neutral, bi-temporal knowledge graph built OVER a
// @qvac/factstore instance (by injection — factstore is not modified). See KGRAPH_DESIGN.md.
export { KnowledgeGraph, createKnowledgeGraph } from "./kgraph.js";
export { createSchema, loadSchema, seedSchema, kindOf } from "./schema.js";
