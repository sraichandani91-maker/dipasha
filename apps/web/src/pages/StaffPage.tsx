import { useEffect, useState } from "react";
import { api, ApiError, postForm } from "../api.js";

const ROLES = ["owner", "store_manager", "picker_packer", "rider"] as const;
type Role = (typeof ROLES)[number];

interface UserRow {
  id: string;
  username: string | null;
  phone: string | null;
  name: string;
  role: Role;
  status: "active" | "suspended";
}

type Tab = "directory" | "roster" | "activity";

/**
 * Section 10.2 "Staff and roles" — the one module in this build that can
 * mint accounts and change roles, so every write here is owner-only,
 * even actions (like rider onboarding) that are store_manager-writable
 * elsewhere in the API.
 */
export default function StaffPage() {
  const [tab, setTab] = useState<Tab>("directory");
  return (
    <div>
      <h2 style={{ marginTop: 0 }}>Staff &amp; roles</h2>
      <div style={{ display: "flex", gap: 4, marginBottom: 12 }}>
        {([["directory", "Directory"], ["roster", "Roster"], ["activity", "Activity log"]] as Array<[Tab, string]>).map(([key, label]) => (
          <button key={key} className={tab === key ? "btn-primary" : "btn-secondary"} onClick={() => setTab(key)}>{label}</button>
        ))}
      </div>
      {tab === "directory" && <DirectoryTab />}
      {tab === "roster" && <RosterTab />}
      {tab === "activity" && <ActivityTab />}
    </div>
  );
}

function DirectoryTab() {
  const [users, setUsers] = useState<UserRow[]>([]);
  const [showNew, setShowNew] = useState(false);
  const [selected, setSelected] = useState<UserRow | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setUsers(await api.get("/users"));
  }
  useEffect(() => { load(); }, []);

  async function toggleStatus(u: UserRow) {
    setError(null);
    try {
      await api.post(`/users/${u.id}/status`, { status: u.status === "active" ? "suspended" : "active" });
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.body?.error ?? "Could not update status." : "Network error.");
    }
  }

  return (
    <div>
      {error && <p style={{ color: "var(--danger, #c0392b)" }}>{error}</p>}
      <button className="btn-primary" onClick={() => setShowNew(true)}>+ New staff account</button>
      <table className="data-table" style={{ marginTop: 12 }}>
        <thead><tr><th>Name</th><th>Username</th><th>Phone</th><th>Role</th><th>Status</th><th></th></tr></thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.id}>
              <td>{u.name}</td>
              <td>{u.username ?? "—"}</td>
              <td>{u.phone ?? "—"}</td>
              <td>{u.role}</td>
              <td>{u.status}</td>
              <td style={{ display: "flex", gap: 4 }}>
                <button className="btn-secondary" onClick={() => setSelected(u)}>Manage</button>
                <button className="btn-secondary" onClick={() => toggleStatus(u)}>
                  {u.status === "active" ? "Suspend" : "Reactivate"}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {showNew && <NewUserModal onClose={() => setShowNew(false)} onCreated={() => { setShowNew(false); load(); }} />}
      {selected && <ManageUserModal user={selected} onClose={() => setSelected(null)} onChanged={load} />}
    </div>
  );
}

function NewUserModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [role, setRole] = useState<Role>("picker_packer");
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await api.post("/users", { username, password, name, phone: phone || undefined, role, pin: pin || undefined });
      onCreated();
    } catch (err) {
      const code = err instanceof ApiError ? err.body?.error : null;
      setError(
        code === "username_already_in_use" ? "That username is already taken." :
        code === "phone_already_in_use" ? "That phone number is already registered." :
        "Could not create the account."
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.3)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50 }}>
      <div className="card" style={{ width: 420, background: "var(--surface)" }}>
        <h3 style={{ marginTop: 0 }}>New staff account</h3>
        {error && <p style={{ color: "var(--danger, #c0392b)" }}>{error}</p>}
        <div className="field"><label>Name</label><input value={name} onChange={(e) => setName(e.target.value)} /></div>
        <div className="field"><label>Username</label><input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="letters, numbers, _ and . only" autoCapitalize="none" /></div>
        <div className="field"><label>Password</label><input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="At least 6 characters" /></div>
        <div className="field"><label>Phone (optional — used for WhatsApp notifications, not login)</label><input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+91…" /></div>
        <div className="field">
          <label>Role</label>
          <select value={role} onChange={(e) => setRole(e.target.value as Role)}>
            {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </div>
        <div className="field"><label>PIN (optional, 4-8 digits)</label><input value={pin} onChange={(e) => setPin(e.target.value)} /></div>
        <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
          <button className="btn-primary" disabled={busy || !name.trim() || username.length < 3 || password.length < 6} onClick={submit}>Create</button>
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

function ManageUserModal({ user, onClose, onChanged }: { user: UserRow; onClose: () => void; onChanged: () => void }) {
  const [role, setRole] = useState<Role>(user.role);
  const [newPin, setNewPin] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [overrides, setOverrides] = useState<Array<{ permissionKey: Role; note: string | null }>>([]);
  const [overrideKey, setOverrideKey] = useState<Role>("owner");
  const [rider, setRider] = useState<{ vehicleType: string | null; vehicleNumber: string | null; licenseNumber: string | null } | null>(null);
  const [documents, setDocuments] = useState<Array<{ id: string; docType: string; filePath: string }>>([]);
  const [docType, setDocType] = useState("driving_license");
  const [docFile, setDocFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function loadOverrides() {
    setOverrides(await api.get(`/users/${user.id}/permission-overrides`));
  }
  useEffect(() => {
    loadOverrides();
    if (user.role === "rider") {
      api.get("/riders/full").then((riders) => {
        const r = riders.find((x: any) => x.id === user.id);
        if (r) setRider({ vehicleType: r.vehicleType, vehicleNumber: r.vehicleNumber, licenseNumber: r.licenseNumber });
      });
      api.get(`/riders/${user.id}/documents`).then(setDocuments);
    }
  }, [user.id]);

  async function saveRole() {
    setBusy(true);
    setMessage(null);
    try {
      await api.post(`/users/${user.id}/role`, { role });
      setMessage("Role updated.");
      onChanged();
    } catch {
      setMessage("Could not change role.");
    } finally {
      setBusy(false);
    }
  }

  async function resetPin() {
    if (newPin.length < 4) return;
    setBusy(true);
    setMessage(null);
    try {
      await api.post(`/users/${user.id}/reset-pin`, { pin: newPin });
      setMessage("PIN reset.");
      setNewPin("");
    } catch {
      setMessage("Could not reset PIN.");
    } finally {
      setBusy(false);
    }
  }

  async function resetPassword() {
    if (newPassword.length < 6) return;
    setBusy(true);
    setMessage(null);
    try {
      await api.post(`/users/${user.id}/reset-password`, { password: newPassword });
      setMessage("Password reset.");
      setNewPassword("");
    } catch {
      setMessage("Could not reset password.");
    } finally {
      setBusy(false);
    }
  }

  async function grantOverride() {
    setBusy(true);
    try {
      await api.post(`/users/${user.id}/permission-overrides`, { permissionKey: overrideKey });
      loadOverrides();
    } finally {
      setBusy(false);
    }
  }

  async function revokeOverride(key: Role) {
    setBusy(true);
    try {
      await api.delete(`/users/${user.id}/permission-overrides/${key}`);
      loadOverrides();
    } finally {
      setBusy(false);
    }
  }

  async function saveRiderDetails() {
    if (!rider) return;
    setBusy(true);
    try {
      await api.put(`/riders/${user.id}/details`, rider);
      setMessage("Vehicle details saved.");
    } finally {
      setBusy(false);
    }
  }

  async function uploadDoc() {
    if (!docFile) return;
    setBusy(true);
    try {
      const form = new FormData();
      form.set("docType", docType);
      form.set("photo", docFile);
      const updated = await postForm(`/riders/${user.id}/documents`, form);
      setDocuments(updated);
      setDocFile(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.3)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50 }}>
      <div className="card" style={{ width: 520, maxHeight: "90vh", overflowY: "auto", background: "var(--surface)" }}>
        <h3 style={{ marginTop: 0 }}>{user.name} <span style={{ fontWeight: 400, color: "var(--muted)" }}>({user.username ?? "no username"})</span></h3>
        {message && <p>{message}</p>}

        <div className="field">
          <label>Role</label>
          <div style={{ display: "flex", gap: 8 }}>
            <select value={role} onChange={(e) => setRole(e.target.value as Role)}>
              {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
            <button className="btn-secondary" disabled={busy || role === user.role} onClick={saveRole}>Save role</button>
          </div>
        </div>

        <div className="field">
          <label>Reset password</label>
          <div style={{ display: "flex", gap: 8 }}>
            <input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} placeholder="New password (min. 6 characters)" />
            <button className="btn-secondary" disabled={busy || newPassword.length < 6} onClick={resetPassword}>Reset</button>
          </div>
        </div>

        <div className="field">
          <label>Reset PIN</label>
          <div style={{ display: "flex", gap: 8 }}>
            <input value={newPin} onChange={(e) => setNewPin(e.target.value)} placeholder="New 4-8 digit PIN" />
            <button className="btn-secondary" disabled={busy || newPin.length < 4} onClick={resetPin}>Reset</button>
          </div>
        </div>

        <div className="field">
          <label>Permission overrides (above base role)</label>
          {overrides.length === 0 && <p style={{ color: "var(--muted)", margin: "4px 0" }}>No overrides granted.</p>}
          {overrides.map((o) => (
            <div key={o.permissionKey} style={{ display: "flex", justifyContent: "space-between", padding: "2px 0" }}>
              <span>{o.permissionKey}</span>
              <button className="btn-secondary" onClick={() => revokeOverride(o.permissionKey)}>Revoke</button>
            </div>
          ))}
          <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
            <select value={overrideKey} onChange={(e) => setOverrideKey(e.target.value as Role)}>
              {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
            <button className="btn-secondary" disabled={busy} onClick={grantOverride}>Grant</button>
          </div>
        </div>

        {user.role === "rider" && rider && (
          <div className="field">
            <label>Vehicle details</label>
            <input placeholder="Vehicle type (e.g. two-wheeler)" value={rider.vehicleType ?? ""} onChange={(e) => setRider({ ...rider, vehicleType: e.target.value })} style={{ marginBottom: 4 }} />
            <input placeholder="Vehicle number" value={rider.vehicleNumber ?? ""} onChange={(e) => setRider({ ...rider, vehicleNumber: e.target.value })} style={{ marginBottom: 4 }} />
            <input placeholder="License number" value={rider.licenseNumber ?? ""} onChange={(e) => setRider({ ...rider, licenseNumber: e.target.value })} style={{ marginBottom: 4 }} />
            <button className="btn-secondary" disabled={busy} onClick={saveRiderDetails}>Save vehicle details</button>

            <div style={{ marginTop: 12 }}>
              <label>Documents</label>
              {documents.map((d) => <div key={d.id} style={{ fontSize: 13 }}>{d.docType}: {d.filePath}</div>)}
              <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
                <select value={docType} onChange={(e) => setDocType(e.target.value)}>
                  <option value="driving_license">Driving license</option>
                  <option value="vehicle_rc">Vehicle RC</option>
                  <option value="id_proof">ID proof</option>
                  <option value="other">Other</option>
                </select>
                <input type="file" accept="image/*" onChange={(e) => setDocFile(e.target.files?.[0] ?? null)} />
                <button className="btn-secondary" disabled={busy || !docFile} onClick={uploadDoc}>Upload</button>
              </div>
            </div>
          </div>
        )}

        <button className="btn-secondary" style={{ marginTop: 12 }} onClick={onClose}>Close</button>
      </div>
    </div>
  );
}

function RosterTab() {
  const [rows, setRows] = useState<Array<{ userId: string; userName: string; role: string; onlineNow: boolean; lastSeenAt: string | null; hoursThisWeek: number }>>([]);
  useEffect(() => { api.get("/roster").then(setRows); }, []);
  return (
    <div>
      <p style={{ color: "var(--muted)" }}>
        "Online now" means active in the last 15 minutes; "hours this week" is the daily span between first and last recorded
        action, summed over 7 days — an approximation, not a real clock-in/out system (no session tracking exists in this build).
      </p>
      <table className="data-table">
        <thead><tr><th>Name</th><th>Role</th><th>Online now</th><th>Last seen</th><th>Hours this week (approx.)</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.userId}>
              <td>{r.userName}</td>
              <td>{r.role}</td>
              <td>{r.onlineNow ? "🟢 Online" : "—"}</td>
              <td>{r.lastSeenAt ? new Date(r.lastSeenAt).toLocaleString() : "never"}</td>
              <td>{r.hoursThisWeek}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ActivityTab() {
  const [rows, setRows] = useState<Array<{ id: string; userName: string | null; method: string; path: string; statusCode: number; occurredAt: string }>>([]);
  const [users, setUsers] = useState<UserRow[]>([]);
  const [userId, setUserId] = useState("");

  useEffect(() => { api.get("/users").then(setUsers); }, []);
  useEffect(() => {
    api.get(`/activity-log${userId ? `?userId=${userId}` : ""}`).then(setRows);
  }, [userId]);

  return (
    <div>
      <div className="field" style={{ maxWidth: 280 }}>
        <label>Filter by staff member</label>
        <select value={userId} onChange={(e) => setUserId(e.target.value)}>
          <option value="">All staff</option>
          {users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
        </select>
      </div>
      <table className="data-table">
        <thead><tr><th>When</th><th>Staff</th><th>Action</th><th>Result</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>{new Date(r.occurredAt).toLocaleString()}</td>
              <td>{r.userName ?? "—"}</td>
              <td>{r.method} {r.path}</td>
              <td>{r.statusCode}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
