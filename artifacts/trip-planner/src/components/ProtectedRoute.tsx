import { Loader2 } from 'lucide-react';
import { useAuth } from '@/hooks/use-auth';
import { useLocation } from 'wouter';
import { useEffect } from 'react';

export function ProtectedRoute({ children, adminOnly = false }: { children: React.ReactNode, adminOnly?: boolean }) {
  const { isAuthenticated, isLoading, isAdmin } = useAuth();
  const [, setLocation] = useLocation();

  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      setLocation('/login');
    } else if (!isLoading && adminOnly && !isAdmin) {
      setLocation('/trips');
    }
  }, [isLoading, isAuthenticated, isAdmin, adminOnly, setLocation]);

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  if (!isAuthenticated || (adminOnly && !isAdmin)) {
    return null;
  }

  return <>{children}</>;
}
