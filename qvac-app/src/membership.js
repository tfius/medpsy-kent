// Mesh membership predicates — the single source of truth for "is this peer allowed" and "does
// this jury vote count". Extracted from server.js so the SAME logic the server enforces is what
// the tests validate (scripts/kiosk_matrix.mjs), instead of a reimplementation that could drift.

// Is `pub` a trusted member? Open mesh (meshMembers null/empty-not-enforced) → everyone; otherwise
// only this device (myPub) or an allowlisted pubkey (case-insensitive). `meshMembers` is read live
// by the caller (server keeps it in a mutable binding and re-derives via this pure fn).
export const memberOf = (meshMembers, myPub, pub) =>
  !meshMembers || pub === myPub || meshMembers.has(String(pub || "").toLowerCase());

// A peer jury vote counts only if it is cryptographically SIGNED and from a member — so a
// member's promoted edges federate only on votes from trusted, verified kiosks.
export const isCountableVote = (vote, isMember) =>
  !!(vote && vote.signatureOk && isMember(vote.peer?.publicKey));
