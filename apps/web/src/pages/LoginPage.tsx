import { useState } from "react";
import { api, ApiError } from "../api.js";
import { useAuth } from "../auth/AuthContext.js";

export default function LoginPage() {
  const { login } = useAuth();
  const [phone, setPhone] = useState("+91");
  const [step, setStep] = useState<"phone" | "code">("phone");
  const [code, setCode] = useState("");
  const [devCode, setDevCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function requestOtp(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await api.post("/auth/otp/request", { phone });
      setDevCode(res.devCode ?? null);
      setStep("code");
    } catch (err) {
      setError(err instanceof ApiError ? describeAuthError(err) : "Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  async function verifyOtp(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await api.post("/auth/otp/verify", { phone, code });
      await login(res.accessToken, res.refreshToken);
    } catch (err) {
      setError(err instanceof ApiError ? describeAuthError(err) : "Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-shell">
      <div className="login-card">
        <h1>Dipasha Medical Store</h1>
        <p className="sub">Staff console — sign in with your phone</p>

        {step === "phone" ? (
          <form onSubmit={requestOtp}>
            <div className="field">
              <label htmlFor="phone">Phone number</label>
              <input id="phone" value={phone} onChange={(e) => setPhone(e.target.value)} style={{ width: "100%" }} autoFocus />
            </div>
            <button className="btn-primary" style={{ width: "100%" }} disabled={busy}>
              {busy ? "Sending…" : "Send code"}
            </button>
          </form>
        ) : (
          <form onSubmit={verifyOtp}>
            <div className="field">
              <label htmlFor="code">6-digit code sent to {phone}</label>
              <input id="code" value={code} onChange={(e) => setCode(e.target.value)} maxLength={6} style={{ width: "100%" }} autoFocus />
            </div>
            {devCode && (
              <p className="hint-text">
                Dev mode — no real SMS/WhatsApp provider is wired up yet, so here's the code: <strong>{devCode}</strong>
              </p>
            )}
            <button className="btn-primary" style={{ width: "100%" }} disabled={busy}>
              {busy ? "Verifying…" : "Sign in"}
            </button>
            <button type="button" className="btn-secondary" style={{ width: "100%", marginTop: 8 }} onClick={() => setStep("phone")}>
              Use a different number
            </button>
          </form>
        )}

        {error && <p className="error-text">{error}</p>}
      </div>
    </div>
  );
}

function describeAuthError(err: ApiError): string {
  switch (err.body?.error) {
    case "no_account_for_phone":
      return "No staff account found for that phone number.";
    case "account_suspended":
      return "This account is suspended.";
    case "incorrect_code":
      return "That code isn't right.";
    case "no_active_otp_or_too_many_attempts":
      return "That code has expired or too many attempts were made — request a new one.";
    default:
      return "Something went wrong. Try again.";
  }
}
