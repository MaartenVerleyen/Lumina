import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ServerGate } from "./components/auth/ServerGate";
import PhoneApp from "./components/phone/PhoneApp";
import { PhoneLayoutContext, usePhoneLayoutState } from "./app/usePhoneLayout";
import "./App.css";

// A phone in a browser gets the phone layout; everything else (and the desktop app) the full one
function Root() {
  const layout = usePhoneLayoutState();
  return <PhoneLayoutContext.Provider value={layout}>{layout.phone ? <PhoneApp /> : <App />}</PhoneLayoutContext.Provider>;
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ServerGate>
      <Root />
    </ServerGate>
  </React.StrictMode>,
);
