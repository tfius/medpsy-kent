import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import { EncounterProvider } from "./store";
import { PrefsProvider } from "./lib/prefs";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <PrefsProvider>
        <EncounterProvider>
          <App />
        </EncounterProvider>
      </PrefsProvider>
    </BrowserRouter>
  </React.StrictMode>,
);
