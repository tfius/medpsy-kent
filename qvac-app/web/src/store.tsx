// The encounter store — the three linked identities from ARCHITECTURE.md:
// patient (who) · situation (this episode) · outcome (the triage result).
// Minimal in-memory context for the demo (a real build persists + signs these).
import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import type { Triage } from "./lib/triage";

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
  const store = useMemo<Store>(() => ({
    enc,
    set: (patch) => setEnc((e) => ({ ...e, ...patch })),
    setSituation: (patch) => setEnc((e) => ({ ...e, situation: { ...e.situation, ...patch } })),
  }), [enc]);
  return <Ctx.Provider value={store}>{children}</Ctx.Provider>;
}

export function useEncounter(): Store {
  const s = useContext(Ctx);
  if (!s) throw new Error("useEncounter must be used within EncounterProvider");
  return s;
}
