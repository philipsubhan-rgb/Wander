import React from 'react';
import { Link, useLocation } from 'wouter';
import { useAuth } from '@/hooks/use-auth';
import { Compass, Map, Users, LogOut, Loader2, PlaneTakeoff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface AppShellProps {
  children: React.ReactNode;
}

export function AppShell({ children }: AppShellProps) {
  const { user, isAdmin, logout } = useAuth();
  const [location] = useLocation();

  if (!user) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    );
  }

  const navItems = [
    { name: 'Trips', href: '/trips', icon: Compass },
    ...(isAdmin ? [{ name: 'Travelers', href: '/admin/users', icon: Users }] : []),
  ];

  return (
    <div className="min-h-screen bg-background flex flex-col md:flex-row">
      {/* Mobile Header */}
      <div className="md:hidden flex items-center justify-between p-4 border-b bg-card">
        <div className="flex items-center gap-2 text-primary">
          <PlaneTakeoff className="h-6 w-6" />
          <span className="font-serif font-bold text-lg">Wander</span>
        </div>
        <div className="flex items-center gap-4">
          <Button variant="ghost" size="icon" onClick={logout} title="Log out">
            <LogOut className="h-5 w-5" />
          </Button>
        </div>
      </div>

      {/* Desktop Sidebar */}
      <aside className="hidden md:flex flex-col w-64 border-r bg-card h-screen sticky top-0">
        <div className="p-6 flex items-center gap-3 text-primary">
          <PlaneTakeoff className="h-8 w-8" />
          <span className="font-serif font-bold text-2xl tracking-tight">Wander</span>
        </div>
        
        <nav className="flex-1 px-4 py-6 space-y-2">
          {navItems.map((item) => {
            const active = location.startsWith(item.href) && (item.href !== '/trips' || location === '/trips' || location.startsWith('/trips/'));
            // Wait, better active logic:
            const isActive = location === item.href || (location.startsWith(item.href + '/') && item.href !== '/');
            return (
              <Link key={item.name} href={item.href} className={cn(
                "flex items-center gap-3 px-3 py-2.5 rounded-md transition-colors duration-200 group text-sm font-medium",
                isActive 
                  ? "bg-primary/10 text-primary" 
                  : "text-muted-foreground hover:bg-secondary hover:text-secondary-foreground"
              )}>
                <item.icon className={cn("h-5 w-5", isActive ? "text-primary" : "text-muted-foreground group-hover:text-secondary-foreground")} />
                {item.name}
              </Link>
            );
          })}
        </nav>

        <div className="p-4 border-t mt-auto">
          <div className="flex items-center gap-3 mb-4 px-2">
            <div className="h-8 w-8 rounded-full bg-primary/20 flex items-center justify-center text-primary font-bold text-sm">
              {user.name.charAt(0).toUpperCase()}
            </div>
            <div className="flex flex-col overflow-hidden">
              <span className="text-sm font-medium truncate">{user.name}</span>
              <span className="text-xs text-muted-foreground capitalize">{user.role}</span>
            </div>
          </div>
          <Button variant="ghost" className="w-full justify-start text-muted-foreground hover:text-foreground" onClick={logout}>
            <LogOut className="h-4 w-4 mr-2" />
            Log out
          </Button>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 w-full overflow-y-auto bg-background/50">
        {children}
      </main>
      
      {/* Mobile Bottom Nav */}
      <div className="md:hidden fixed bottom-0 left-0 right-0 border-t bg-card flex items-center justify-around p-2 pb-safe z-50">
        {navItems.map((item) => {
          const isActive = location === item.href || (location.startsWith(item.href + '/') && item.href !== '/');
          return (
            <Link key={item.name} href={item.href} className={cn(
              "flex flex-col items-center gap-1 p-2 min-w-[64px]",
              isActive ? "text-primary" : "text-muted-foreground"
            )}>
              <item.icon className="h-5 w-5" />
              <span className="text-[10px] font-medium">{item.name}</span>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
