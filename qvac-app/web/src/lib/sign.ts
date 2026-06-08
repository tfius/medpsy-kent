// Tamper-evident "signing" for the outcome record (the three-identity model).
// Demo uses a SHA-256 content hash (verifiable/immutable); production would use an
// ECDSA signature with the device/clinician key — same idea, real provenance.
export async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function newId(prefix: string): string {
  const rnd = (crypto.randomUUID?.() || Math.random().toString(16).slice(2)).replace(/-/g, "").slice(0, 8);
  return `${prefix}-${rnd.toUpperCase()}`;
}
