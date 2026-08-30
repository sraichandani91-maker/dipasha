import { useState } from "react";
import { api, ApiError } from "../api.js";
import { useAuth } from "../auth/AuthContext.js";
import Logo from "../components/Logo.js";

export default function LoginPage() {
  const { login } = useAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await api.post("/auth/login", { username, password });
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
        <div style={{ display: "flex", justifyContent: "center", marginBottom: 8 }}><Logo size={56} /></div>
        <h1>Dipasha Medical Store</h1>
        <p className="sub" style={{ marginBottom: 2 }}>because we care..</p>
        <p className="sub">Staff console — sign in with your username</p>

        <form onSubmit={submit}>
          <div className="field">
            <label htmlFor="username">Username</label>
            <input id="username" value={username} onChange={(e) => setUsername(e.target.value)} style={{ width: "100%" }} autoFocus autoCapitalize="none" autoCorrect="off" />
          </div>
          <div className="field">
            <label htmlFor="password">Password</label>
            <input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} style={{ width: "100%" }} />
          </div>
          <button className="btn-primary" style={{ width: "100%" }} disabled={busy || !username || !password}>
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>

        {error && <p className="error-text">{error}</p>}
      </div>
    </div>
  );
}

function describeAuthError(err: ApiError): string {
  switch (err.body?.error) {
    case "invalid_credentials":
      return "Incorrect username or password.";
    case "account_suspended":
      return "This account is suspended.";
    default:
      return "Something went wrong. Try again.";
  }
}
