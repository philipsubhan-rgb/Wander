import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import * as SecureStore from 'expo-secure-store';
import { getMe, login as loginApi, logout as logoutApi, setAuthTokenGetter } from '@workspace/api-client-react';
import type { AuthUser, LoginResponse } from '@workspace/api-client-react';

const AUTH_TOKEN_KEY = 'wander_auth_token';

// ── Token storage helpers ─────────────────────────────────────────────────────
// SecureStore works only in native builds. On web (mobile browsers, Expo web
// preview) it throws, so we fall back to localStorage which persists across
// page refreshes and works in every browser.

async function storeToken(token: string): Promise<void> {
  try {
    await SecureStore.setItemAsync(AUTH_TOKEN_KEY, token);
  } catch {
    try { localStorage.setItem(AUTH_TOKEN_KEY, token); } catch { /* ignore */ }
  }
}

async function retrieveToken(): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(AUTH_TOKEN_KEY);
  } catch {
    try { return localStorage.getItem(AUTH_TOKEN_KEY); } catch { return null; }
  }
}

async function removeToken(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(AUTH_TOKEN_KEY);
  } catch {
    try { localStorage.removeItem(AUTH_TOKEN_KEY); } catch { /* ignore */ }
  }
}

interface AuthContextType {
  user: AuthUser | null;
  isLoading: boolean;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const queryClient = useQueryClient();

  useEffect(() => {
    // Register the token getter so every API call attaches the bearer token
    // when available. This is a no-op in browsers where the token getter
    // returns null (session cookies handle auth there instead).
    setAuthTokenGetter(retrieveToken);

    // Restore the session from the stored token (native) or cookie (web)
    getMe()
      .then(setUser)
      .catch(() => setUser(null))
      .finally(() => setIsLoading(false));

    return () => {
      // Clear the getter on unmount to avoid leaks in tests / HMR cycles
      setAuthTokenGetter(null);
    };
  }, []);

  const login = useCallback(async (username: string, password: string) => {
    const response: LoginResponse = await loginApi({ username, password });

    if (response.token) {
      await storeToken(response.token);
    }

    setUser(response);
  }, []);

  const logout = useCallback(async () => {
    await logoutApi();
    await removeToken();
    setUser(null);
    queryClient.clear();
  }, [queryClient]);

  return (
    <AuthContext.Provider value={{ user, isLoading, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
