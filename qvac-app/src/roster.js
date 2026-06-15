// Signed membership roster — makes the mesh allowlist tamper-evident. A config `members` list
// is just text anyone can edit; a roster is SIGNED by a trusted issuer (a clinic admin's device
// key), so kiosks accept it only if the signature verifies against the one issuer key they trust.
// The roster can then travel (in the shared config, or over the wire) without becoming forgeable.
//
//   admin:  signRoster({ code, members })            -> { v, code, members, issuedAt, issuer, sig }
//   kiosk:  verifyRoster(roster, trustedIssuerPubkey) -> member list | null
import { getIdentity, sign, verify } from "./identity.js";

// Canonical bytes the signature covers — members lowercased + sorted so it's order-independent.
const payload = (r) => `medpsy-roster:v1:${r.code || ""}:${r.issuedAt}:${[...(r.members || [])].map((m) => String(m).toLowerCase()).sort().join(",")}`;

// Build a roster signed by THIS device (the issuer/admin). issuedAt is caller-supplied or now.
export function signRoster({ code = "", members = [], issuedAt = new Date().toISOString() }) {
  const r = { v: 1, code, members: members.map((m) => String(m).trim().toLowerCase()).filter((m) => /^[0-9a-f]{64}$/.test(m)), issuedAt, issuer: getIdentity().publicKey };
  r.sig = sign(payload(r));
  return r;
}

// Verify a roster was signed by `trustedIssuer` (and is internally consistent). Returns the
// member pubkeys (lowercased) on success, or null if untrusted/forged/malformed.
export function verifyRoster(roster, trustedIssuer) {
  if (!roster || typeof roster !== "object" || !roster.issuer || !roster.sig || !Array.isArray(roster.members)) return null;
  if (trustedIssuer && roster.issuer.toLowerCase() !== String(trustedIssuer).toLowerCase()) return null;
  if (!verify(payload(roster), roster.sig, roster.issuer)) return null;
  return roster.members.map((m) => String(m).toLowerCase());
}
