import { useEffect, type ReactNode } from "react";
import { NavLink, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import Triage from "./pages/Triage";
import History from "./pages/History";
import { Identify, Consent, Context, Intake, Route as RoutePage, Validate, Billing } from "./pages/scaffolds";
import { useEncounter, type Encounter } from "./store";
import { usePrefs, useT, LANGS, type Lang, type UiScale } from "./lib/prefs";
import { HelpProvider, HelpButton } from "./lib/ui";

type Step = { path: string; key: string; el: ReactNode; clinician?: boolean };
const STEPS: Step[] = [
  { path: "/", key: "identify", el: <Identify /> },
  { path: "/consent", key: "consent", el: <Consent /> },
  { path: "/context", key: "context", el: <Context /> },
  { path: "/intake", key: "intake", el: <Intake /> },
  { path: "/triage", key: "triage", el: <Triage /> },
  { path: "/history", key: "history", el: <History /> },
  { path: "/route", key: "route", el: <RoutePage /> },
  { path: "/validate", key: "validate", el: <Validate />, clinician: true },
  { path: "/billing", key: "billing", el: <Billing />, clinician: true },
];

// A step is navigable once the data it needs exists — keeps patients out of empty
// or clinician pages, and turns the rail into a real progress indicator.
function reached(enc: Encounter, i: number): boolean {
  switch (i) {
    case 0: return true;
    case 1: return !!enc.patient?.name;
    case 2: return !!enc.consent?.understood;
    case 3:
    case 4: return !!enc.situation.complaint;
    case 5: case 6: case 7: case 8: return !!enc.outcome;
    default: return false;
  }
}

const SCALES: UiScale[] = ["base", "lg", "xl"];

export default function App() {
  const { pathname } = useLocation();
  const nav = useNavigate();
  const { enc, reset } = useEncounter();
  const { lang, setLang, scale, setScale } = usePrefs();
  const T = useT();
  const current = Math.max(0, STEPS.findIndex((s) => s.path === pathname));

  // Move focus to the page heading on navigation (screen-reader orientation).
  useEffect(() => {
    const h = document.querySelector("main h1") as HTMLElement | null;
    if (h) { h.setAttribute("tabindex", "-1"); h.focus(); }
  }, [pathname]);

  function newPatient() {
    reset();
    nav("/");
  }

  return (
    <HelpProvider>
      <div className="app">
        <header className="topbar">
          <div className="brand"><span className="dot" /> MedPsy&nbsp;Triage <small>· local-first · QVAC</small></div>
          <div className="topbar-controls">
            <label className="sr-only" htmlFor="lang">{T("language")}</label>
            <select id="lang" className="lang-select" value={lang}
              onChange={(e) => setLang(e.target.value as Lang)} title={T("language")}>
              {LANGS.map((l) => <option key={l.code} value={l.code}>{l.flag} {l.label}</option>)}
            </select>
            <div className="textsize" role="group" aria-label={T("textSize")} title={T("textSize")}>
              {SCALES.map((s, i) => (
                <button key={s} type="button" className={`ts${scale === s ? " active" : ""}`}
                  aria-pressed={scale === s} aria-label={`${T("textSize")} ${i + 1}`}
                  style={{ fontSize: `${12 + i * 3}px` }} onClick={() => setScale(s)}>A</button>
              ))}
            </div>
            <button type="button" className="btn ghost newpt" onClick={newPatient}>↺ {T("newPatient")}</button>
            <HelpButton />
          </div>
        </header>

        <nav className="rail" aria-label="Progress">
          {STEPS.map((s, i) => {
            const enabled = reached(enc, i) || i === current;
            const done = i < current && reached(enc, i);
            const cls = `step${i === current ? " active" : ""}${done ? " done" : ""}${s.clinician ? " clinician" : ""}${enabled ? "" : " locked"}`;
            const inner = (<><span className="num">{done ? "✓" : i + 1}</span><span className="lbl">{T(`step.${s.key}`)}</span></>);
            return enabled
              ? <NavLink key={s.path} to={s.path} className={cls}>{inner}</NavLink>
              : <span key={s.path} className={cls} aria-disabled="true">{inner}</span>;
          })}
        </nav>

        <p className="trust-bar">🔒 {T("trust")}</p>

        <main className="content">
          <Routes>
            {STEPS.map((s) => <Route key={s.path} path={s.path} element={s.el} />)}
          </Routes>
        </main>
      </div>
    </HelpProvider>
  );
}
