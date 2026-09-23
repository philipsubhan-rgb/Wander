import { AppShell } from '@/components/AppShell';
import { ProtectedRoute } from '@/components/ProtectedRoute';
import { Switch, Route, Redirect } from 'wouter';
import Login from '@/pages/login';
import ForgotPassword from '@/pages/forgot-password';
import ResetPassword from '@/pages/reset-password';
import TripsDashboard from '@/pages/trips';
import AdminUsers from '@/pages/admin-users';
import TripDetail from '@/pages/trip-detail';
import TripGuide from '@/pages/trip-guide';
import SettingsPage from '@/pages/settings';

export default function Routes() {
  return (
    <Switch>
      <Route path="/login" component={Login} />
      <Route path="/forgot-password" component={ForgotPassword} />
      <Route path="/reset-password" component={ResetPassword} />
      
      <Route path="/">
        <Redirect to="/trips" />
      </Route>

      <Route path="/trips">
        <ProtectedRoute>
          <AppShell>
            <TripsDashboard />
          </AppShell>
        </ProtectedRoute>
      </Route>

      <Route path="/trips/:id/guide">
        <ProtectedRoute>
          <TripGuide />
        </ProtectedRoute>
      </Route>

      <Route path="/trips/:id">
        <ProtectedRoute>
          <AppShell>
            <TripDetail />
          </AppShell>
        </ProtectedRoute>
      </Route>
      
      <Route path="/trips/:id/edit">
        <ProtectedRoute>
          <AppShell>
            <TripDetail editMode />
          </AppShell>
        </ProtectedRoute>
      </Route>

      <Route path="/admin/users">
        <ProtectedRoute adminOnly>
          <AppShell>
            <AdminUsers />
          </AppShell>
        </ProtectedRoute>
      </Route>

      <Route path="/settings">
        <ProtectedRoute>
          <SettingsPage />
        </ProtectedRoute>
      </Route>

      <Route>
        <div className="min-h-screen flex items-center justify-center">
          <div className="text-center">
            <h1 className="text-4xl font-serif font-bold mb-4">404</h1>
            <p className="text-muted-foreground mb-6">Page not found</p>
            <a href="/" className="text-primary hover:underline">Return home</a>
          </div>
        </div>
      </Route>
    </Switch>
  );
}
