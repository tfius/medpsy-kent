// Client for the on-device clinical knowledge base (/api/knowledge → src/knowledge.js):
// retrieved passages from local protocols + interaction monographs, shown to the
// pharmacist alongside a triage conclusion. Reference material only — never auto-acted-on.
import { getAuditEncounter } from "./audit";

export interface KnowledgePassage { doc: string; content: string; score: number }

export async function searchKnowledge(query: string, topK = 3): Promise<KnowledgePassage[]> {
  if (!query.trim()) return [];
  try {
    const r = await fetch("/api/knowledge", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, topK, encounterId: getAuditEncounter() }),
    });
    if (!r.ok) return [];
    return (await r.json()).results || [];
  } catch { return []; }
}

// Human label for a corpus filename: "protocol-chest-pain.md" -> "protocol chest pain".
export const docLabel = (doc: string) => doc.replace(/\.md$/, "").replace(/-/g, " ");
