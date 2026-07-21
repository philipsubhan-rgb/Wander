import { useGetMe, useLogout } from '@workspace/api-client-react';
import { useLocation } from 'wouter';
import { useCallback } from 'react';

export function useAuth() {
  const { data: user, isLoading, error } = useGetMe({
    query: {
      retry: false,
    }
  });
  
  const logoutMutation = useLogout();
  const [, setLocation] = useLocation();

  const logout = useCallback(() => {
    logoutMutation.mutate(undefined, {
      onSuccess: () => {
        setLocation('/login');
        window.location.reload();
      }
    });
  }, [logoutMutation, setLocation]);

  return {
    user,
    isLoading,
    error,
    isAuthenticated: !!user,
    isAdmin: (user?.role as string) === 'super_admin',
    logout
  };
}
