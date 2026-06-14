// Client for OKF (Open Knowledge Format) interchange of the on-device KNOWLEDGE layer —
// the factstore kb:* logs (e.g. kb:medical, the authored drug-interaction graph). OKF is a
// directory of markdown concept docs with untyped links; it is the portable format for
// sharing reference knowledge with Google's OKF ecosystem (visualizer/catalog/other agents).
//
// Lossy by design: the factstore's TYPED edges (interacts_with) flatten to OKF's UNTYPED
// links and import back as `links_to`. The lossless, authoritative export is the SIGNED
// factstore bundle (/api/facts/:log/export) — OKF is interchange, not the record of truth.

export type OkfFiles = Record<string, string>;
export interface Fact {
  subject: string; predicate: string; object: unknown;
  source: string; confidence?: number; meta?: Record<string, unknown>;
}

const j = async (url: string, init?: RequestInit) => {
  const r = await fetch(url, init);
  return r.ok ? r.json() : null;
};

// All knowledge logs (kb:*) — patient:* logs are PHI and never offered for OKF.
export async function listKnowledgeLogs(): Promise<string[]> {
  const d = await j("/api/facts");
  return ((d?.logs as string[]) || []).filter((l) => l.startsWith("kb:")).sort();
}

export async function getFacts(log: string): Promise<Fact[]> {
  const d = await j(`/api/facts/${encodeURIComponent(log)}`);
  return (d?.facts as Fact[]) || [];
}

export interface OkfExport { log: string; dir: string; count: number; files: OkfFiles }
export const exportKnowledgeOKF = (log: string): Promise<OkfExport | null> =>
  j(`/api/facts/${encodeURIComponent(log)}/okf`);

export const importKnowledgeOKF = (log: string, files: OkfFiles): Promise<{ imported: number } | null> =>
  j(`/api/facts/${encodeURIComponent(log)}/okf-import`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ files }),
  });

// Lossy OKF VIEW of an audit encounter (NOT the audit record — the signed bundle is).
export interface OkfEncounter { encounterId: string; authoritative: false; files: OkfFiles }
export const getEncounterOKF = (id: string): Promise<OkfEncounter | null> =>
  j(`/api/audit/${encodeURIComponent(id)}/okf`);

// Read a picked directory of .md files into an OKF bundle, stripping the wrapper folder
// the browser prepends to webkitRelativePath (so "kb-medical/drug/x.md" -> "drug/x.md").
export async function filesToOkfBundle(fileList: FileList | File[]): Promise<OkfFiles> {
  const files: OkfFiles = {};
  for (const f of Array.from(fileList)) {
    if (!f.name.endsWith(".md")) continue;
    const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
    const stripped = rel.includes("/") ? rel.split("/").slice(1).join("/") : rel;
    files[stripped || f.name] = await f.text();
  }
  return files;
}

// Trigger a browser download of an OKF bundle as a single JSON (the kiosk also wrote the
// real .md directory server-side; this is the grab-from-browser convenience).
export function downloadOkfBundle(name: string, files: OkfFiles): void {
  const blob = new Blob([JSON.stringify({ files }, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href = url; a.download = `${name}.okf.json`; a.click();
  URL.revokeObjectURL(url);
}
