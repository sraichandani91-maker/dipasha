import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { api, clearTokens, getTokens, setTokens } from "../api.js";

export interface CurrentUser {
  id: string;
  name: string;
  role: "owner" | "store_manager" | "picker_packer" | "rider";
  actualRole: string;
  impersonating: boolean;
  permissionOverrides: string[];
}

interface AuthState {
  user: CurrentUser | null;
  loading: boolean;
  login: (accessToken: string, refreshToken: string) => Promise<void>;
  logout: () => void;
  impersonate: (role: string) => Promise<void>;
  refreshMe: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [loading, setLoading] = useState(true);

  const refreshMe = useCallback(async () => {
    const { accessToken } = getTokens();
    if (!accessToken) {
      setUser(null);
      setLoading(false);
      return;
    }
    try {
      const me = await api.get("/auth/me");
      setUser(me);
    } catch {
      clearTokens();
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refreshMe();
  }, [refreshMe]);

  const login = useCallback(async (accessToken: string, refreshToken: string) => {
    setTokens(accessToken, refreshToken);
    await refreshMe();
  }, [refreshMe]);

  const logout = useCallback(() => {
    clearTokens();
    setUser(null);
  }, []);

  const impersonate = useCallback(async (role: string) => {
    const { accessToken } = await api.post("/auth/impersonate", { role });
    setTokens(accessToken);
    await refreshMe();
  }, [refreshMe]);

  return (
    <AuthContext.Provider value={{ user, loading, login, logout, impersonate, refreshMe }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
