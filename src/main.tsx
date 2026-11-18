import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ServerGate } from "./components/auth/ServerGate";
import PhoneApp from "./components/phone/PhoneApp";
import { PhoneLayoutContext, usePhoneLayoutState } from "./app/usePhoneLayout";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { leanListsOn, setLeanLists } from "./api/leanList";
import "./App.css";

// A phone in a browser gets the phone layout; everything else (and the desktop app) the full one. The phone layout
// asks servers for lean lists (leanList.ts); switching to the full layout, whose screens read every detail, loads
// the page again with full lists.
function Root() {
  const layout = usePhoneLayoutState();
  if (leanListsOn() && !layout.phone) window.location.reload();
  setLeanLists(layout.phone);
  return <PhoneLayoutContext.Provider value={layout}>{layout.phone ? <PhoneApp /> : <App />}</PhoneLayoutContext.Provider>;
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <ServerGate>
        <Root />
      </ServerGate>
    </ErrorBoundary>
  </React.StrictMode>,
);
