import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import * as SecureStore from 'expo-secure-store';
import { getMe, login as loginApi, logout as logoutApi, setAuthTokenGetter } from '@workspace/api-client-react';
import type { AuthUser, LoginResponse } from '@workspace/api-client-react';

const AUTH_TOKEN_KEY = 'wander_auth_token';

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
    setAuthTokenGetter(async () => {
      try {
        return await SecureStore.getItemAsync(AUTH_TOKEN_KEY);
      } catch {
        return null;
      }
    });

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
      try {
        await SecureStore.setItemAsync(AUTH_TOKEN_KEY, response.token);
      } catch {
        // SecureStore unavailable (e.g. web) — bearer auth won't persist,
        // but session cookies will still work.
      }
    }

    setUser(response);
  }, []);

  const logout = useCallback(async () => {
    await logoutApi();
    try {
      await SecureStore.deleteItemAsync(AUTH_TOKEN_KEY);
    } catch {
      // Ignore if SecureStore is unavailable
    }
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
