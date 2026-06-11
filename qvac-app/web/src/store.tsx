// The encounter store — the three linked identities from ARCHITECTURE.md:
// patient (who) · situation (this episode) · outcome (the triage result).
// Minimal in-memory context for the demo (a real build persists + signs these).
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { Triage } from "./lib/triage";
import { audit, getAuditEncounter, newEncounter } from "./lib/audit";

export type Encounter = {
  patient: { id: string; name: string } | null;        // identity (PII anchor)
  consent: { understood: boolean; sharing: string[] } | null;
  situation: { complaint: string; intake: string };     // this episode
  outcome: Triage | null;                                // the result
};

type Store = {
  enc: Encounter;
  set: (patch: Partial<Encounter>) => void;
  setSituation: (patch: Partial<Encounter["situation"]>) => void;
  reset: () => void; // clear the encounter for the next patient (kiosk turnover)
};

const empty: Encounter = {
  patient: null,
  consent: null,
  situation: { complaint: "", intake: "" },
  outcome: null,
};

const Ctx = createContext<Store | null>(null);

export function EncounterProvider({ children }: { children: ReactNode }) {
  const [enc, setEnc] = useState<Encounter>(empty);
  // Ensure an encounter id exists for this patient session (kiosk turnover -> reset()).
  useEffect(() => { if (!getAuditEncounter()) newEncounter(); }, []);
  const store = useMemo<Store>(() => ({
    enc,
    set: (patch) => {
      // Audit the three identities as they're captured (patient/consent/outcome).
      if (patch.patient) audit.patient(patch.patient);
      if (patch.consent) audit.consent(patch.consent as unknown as Record<string, unknown>);
      if (patch.outcome) audit.outcome(patch.outcome as unknown as Record<string, unknown>);
      setEnc((e) => ({ ...e, ...patch }));
    },
    setSituation: (patch) => setEnc((e) => ({ ...e, situation: { ...e.situation, ...patch } })),
    reset: () => { newEncounter(); setEnc({ patient: null, consent: null, situation: { complaint: "", intake: "" }, outcome: null }); },
  }), [enc]);
  return <Ctx.Provider value={store}>{children}</Ctx.Provider>;
}

export function useEncounter(): Store {
  const s = useContext(Ctx);
  if (!s) throw new Error("useEncounter must be used within EncounterProvider");
  return s;
}
