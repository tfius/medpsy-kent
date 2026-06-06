import { NavLink, Route, Routes, useLocation } from "react-router-dom";
import Triage from "./pages/Triage";
import { Identify, Consent, Context, Intake, History, Route as RoutePage, Validate, Billing } from "./pages/scaffolds";

const STEPS = [
  { path: "/", label: "Identify", el: <Identify /> },
  { path: "/consent", label: "Consent", el: <Consent /> },
  { path: "/context", label: "Context", el: <Context /> },
  { path: "/intake", label: "Intake", el: <Intake /> },
  { path: "/triage", label: "Triage", el: <Triage /> },
  { path: "/history", label: "History", el: <History /> },
  { path: "/route", label: "Route", el: <RoutePage /> },
  { path: "/validate", label: "Validate", el: <Validate /> },
  { path: "/billing", label: "Bill", el: <Billing /> },
];

export default function App() {
  const { pathname } = useLocation();
  const current = Math.max(0, STEPS.findIndex((s) => s.path === pathname));

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand"><span className="dot" /> MedPsy&nbsp;Triage <small>· local-first · QVAC</small></div>
      </header>

      <nav className="rail" aria-label="Triage steps">
        {STEPS.map((s, i) => (
          <NavLink key={s.path} to={s.path} className={({ isActive }) =>
            `step${isActive ? " active" : ""}${i < current ? " done" : ""}`}>
            <span className="num">{i < current ? "✓" : i + 1}</span>
            <span className="lbl">{s.label}</span>
          </NavLink>
        ))}
      </nav>

      <main className="content">
        <Routes>
          {STEPS.map((s) => <Route key={s.path} path={s.path} element={s.el} />)}
        </Routes>
      </main>
    </div>
  );
}
