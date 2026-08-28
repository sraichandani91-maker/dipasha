import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import * as Sentry from "@sentry/react";
import App from "./App.js";
import { AuthProvider } from "./auth/AuthContext.js";
import { initErrorTracking } from "./lib/error-tracking.js";
import "./styles/global.css";

initErrorTracking();

// A blank white screen with no explanation is the worst thing a staff
// member can hit mid-bill — the fallback at least says something broke
// and offers a reload, and (once a real Sentry DSN exists, Section
// 12B.4) reports the crash instead of it only ever being described to
// you secondhand over a phone call.
function CrashFallback() {
  return (
    <div style={{ padding: 32, fontFamily: "sans-serif" }}>
      <h2>Something went wrong.</h2>
      <p>Reloading usually fixes it. If it keeps happening, tell the owner what you were doing when it broke.</p>
      <button onClick={() => window.location.reload()}>Reload</button>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Sentry.ErrorBoundary fallback={<CrashFallback />}>
      <AuthProvider>
        <App />
      </AuthProvider>
    </Sentry.ErrorBoundary>
  </StrictMode>
);
