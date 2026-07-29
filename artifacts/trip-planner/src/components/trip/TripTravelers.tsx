import {
  useListTripParticipants, useAddTripParticipant, useRemoveTripParticipant,
  getListTripParticipantsQueryKey, getListExpensesQueryKey, getGetExpenseBalanceQueryKey,
} from '@workspace/api-client-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Separator } from '@/components/ui/separator';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Search, UserCheck, AlertCircle, Crown, Shield, Trash2, TriangleAlert, Users, Pencil, Eye, EyeOff } from 'lucide-react';

// ── Types ─────────────────────────────────────────────────────────────────────

type LookupResult = {
  id: number;
  username: string;
  name: string;
  email: string;
  role: string;
  otherTripsCount: number;
};

// ── Add Traveler by Email ─────────────────────────────────────────────────────

function AddTravelerByEmail({
  tripId,
  currentParticipantIds,
}: {
  tripId: number;
  currentParticipantIds: number[];
}) {
  const [email, setEmail] = useState('');
  const [searching, setSearching] = useState(false);
  const [found, setFound] = useState<LookupResult | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [inviteName, setInviteName] = useState('');
  const [inviting, setInviting] = useState(false);
  const addParticipant = useAddTripParticipant();
  const queryClient = useQueryClient();

  const handleSearch = async () => {
    const trimmed = email.trim().toLowerCase();
    if (!trimmed) return;
    setSearching(true);
    setFound(null);
    setNotFound(false);

    try {
      const res = await fetch(`/api/users/lookup?email=${encodeURIComponent(trimmed)}`, {
        credentials: 'include',
      });
      if (res.status === 404) {
        setNotFound(true);
        setInviteName('');
      } else if (res.ok) {
        const user: LookupResult = await res.json();
        if (currentParticipantIds.includes(user.id)) {
          toast.info(`${user.name} is already on this trip`);
        } else {
          setFound(user);
          if (user.otherTripsCount > 0) {
            setConfirmOpen(true);
          } else {
            doAdd(user);
          }
        }
      } else {
        toast.error('Search failed — please try again');
      }
    } finally {
      setSearching(false);
    }
  };

  const doAdd = (user: LookupResult) => {
    addParticipant.mutate(
      { tripId, data: { userId: user.id } },
      {
        onSuccess: (data: any) => {
          queryClient.invalidateQueries({ queryKey: getListTripParticipantsQueryKey(tripId) });
          queryClient.invalidateQueries({ queryKey: getListExpensesQueryKey(tripId) });
          queryClient.invalidateQueries({ queryKey: getGetExpenseBalanceQueryKey(tripId) });
          setEmail('');
          setFound(null);
          setConfirmOpen(false);
          const recalc = data?.splitsRecalculated ?? 0;
          toast.success(
            recalc > 0
              ? `${user.name} added — ${recalc} expense${recalc !== 1 ? 's' : ''} recalculated`
              : `${user.name} added to trip`
          );
        },
        onError: (e: any) => {
          setConfirmOpen(false);
          toast.error(e?.error || 'Failed to add traveler');
        },
      }
    );
  };

  const handleInvite = async () => {
    const trimmedName = inviteName.trim();
    const trimmedEmail = email.trim().toLowerCase();
    if (!trimmedName || !trimmedEmail) return;
    setInviting(true);
    try {
      const res = await fetch(`/api/trips/${tripId}/participants/invite`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ name: trimmedName, email: trimmedEmail }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 409) {
        toast.info('An account with that email was just created — searching again…');
        setNotFound(false);
        setInviteName('');
        handleSearch();
        return;
      }
      if (!res.ok) {
        toast.error(data?.error || 'Failed to create traveler');
        return;
      }
      queryClient.invalidateQueries({ queryKey: getListTripParticipantsQueryKey(tripId) });
      queryClient.invalidateQueries({ queryKey: getListExpensesQueryKey(tripId) });
      queryClient.invalidateQueries({ queryKey: getGetExpenseBalanceQueryKey(tripId) });
      setEmail('');
      setInviteName('');
      setNotFound(false);
      const recalc = data?.splitsRecalculated ?? 0;
      toast.success(
        recalc > 0
          ? `${trimmedName} added — ${recalc} expense${recalc !== 1 ? 's' : ''} recalculated`
          : `${trimmedName} added to trip`
      );
    } finally {
      setInviting(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <Input
          type="email"
          placeholder="Enter traveler's email address"
          value={email}
          onChange={e => { setEmail(e.target.value); setFound(null); setNotFound(false); }}
          onKeyDown={e => { if (e.key === 'Enter') handleSearch(); }}
          className="flex-1"
        />
        <Button
          type="button"
          onClick={handleSearch}
          disabled={!email.trim() || searching}
          variant="outline"
        >
          {searching
            ? <span className="h-4 w-4 animate-spin inline-block border-2 border-current border-t-transparent rounded-full" />
            : <Search className="h-4 w-4" />}
        </Button>
      </div>

      {notFound && (
        <div className="space-y-3 bg-muted/40 border rounded-lg px-4 py-3">
          <div className="flex items-center gap-2 text-sm font-medium">
            <AlertCircle className="h-4 w-4 shrink-0 text-amber-500" />
            <span>No account found for <span className="font-semibold">{email.trim()}</span></span>
          </div>
          <p className="text-xs text-muted-foreground">
            Create a basic traveler account and add them to this trip right now. They can set a password later.
          </p>
          <div className="flex gap-2">
            <Input
              placeholder="Full name"
              value={inviteName}
              onChange={e => setInviteName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && inviteName.trim()) handleInvite(); }}
              className="flex-1"
              autoFocus
            />
            <Button
              type="button"
              onClick={handleInvite}
              disabled={!inviteName.trim() || inviting}
              size="sm"
            >
              {inviting
                ? <span className="h-4 w-4 animate-spin inline-block border-2 border-current border-t-transparent rounded-full" />
                : 'Create & Add'}
            </Button>
          </div>
        </div>
      )}

      {found && (
        <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <UserCheck className="h-5 w-5 text-primary" />
                Confirm traveler
              </DialogTitle>
              <DialogDescription asChild>
                <div className="space-y-3 pt-1">
                  <p>Please confirm this is the right person before adding them to the trip.</p>
                  <div className="bg-muted rounded-lg px-4 py-3 space-y-1">
                    <p className="font-semibold text-foreground">{found.name}</p>
                    <p className="text-sm text-muted-foreground">{found.email}</p>
                    <p className="text-xs text-muted-foreground">@{found.username}</p>
                  </div>
                  {found.otherTripsCount > 0 && (
                    <p className="text-sm text-muted-foreground">
                      This traveler is currently on {found.otherTripsCount} other trip{found.otherTripsCount !== 1 ? 's' : ''}.
                    </p>
                  )}
                </div>
              </DialogDescription>
            </DialogHeader>
            <DialogFooter className="gap-2 sm:gap-0">
              <Button variant="outline" onClick={() => setConfirmOpen(false)} disabled={addParticipant.isPending}>
                Cancel
              </Button>
              <Button onClick={() => doAdd(found)} disabled={addParticipant.isPending}>
                {addParticipant.isPending ? 'Adding…' : 'Yes, add to trip'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

// ── Edit Traveler Dialog ──────────────────────────────────────────────────────

type EditTarget = { id: number; name: string; email: string | null; role: string };

function EditTravelerDialog({
  tripId,
  traveler,
  onClose,
}: {
  tripId: number;
  traveler: EditTarget;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();

  // Profile fields
  const [name, setName] = useState(traveler.name);
  const [email, setEmail] = useState(traveler.email ?? '');
  const [savingProfile, setSavingProfile] = useState(false);

  // Password fields
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [savingPassword, setSavingPassword] = useState(false);

  const isSuperAdmin = traveler.role === 'super_admin';

  const handleSaveProfile = async () => {
    if (!name.trim()) { toast.error('Name is required'); return; }
    setSavingProfile(true);
    try {
      const res = await fetch(`/api/trips/${tripId}/participants/${traveler.id}/details`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ name: name.trim(), email: email.trim() || undefined }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { toast.error(data?.error || 'Failed to save profile'); return; }
      queryClient.invalidateQueries({ queryKey: getListTripParticipantsQueryKey(tripId) });
      toast.success('Traveler profile updated');
      onClose();
    } catch {
      toast.error('Failed to save profile');
    } finally {
      setSavingProfile(false);
    }
  };

  const handleSetPassword = async () => {
    if (newPassword.length < 6) { toast.error('Password must be at least 6 characters'); return; }
    if (newPassword !== confirmPassword) { toast.error('Passwords do not match'); return; }
    setSavingPassword(true);
    try {
      const res = await fetch(`/api/trips/${tripId}/participants/${traveler.id}/set-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ newPassword }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { toast.error(data?.error || 'Failed to set password'); return; }
      setNewPassword('');
      setConfirmPassword('');
      toast.success('Password updated');
    } catch {
      toast.error('Failed to set password');
    } finally {
      setSavingPassword(false);
    }
  };

  return (
    <Dialog open onOpenChange={open => { if (!open) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Pencil className="h-4 w-4 text-primary" />
            Edit Traveler
          </DialogTitle>
          <DialogDescription>
            Update profile details or set a new password for {traveler.name}.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6 py-2">
          {/* Profile section */}
          <div className="space-y-4">
            <p className="text-sm font-semibold text-foreground">Profile Details</p>
            <div className="space-y-2">
              <Label htmlFor="edit-name">Full Name</Label>
              <Input
                id="edit-name"
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="Full name"
                disabled={isSuperAdmin}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-email">Email Address</Label>
              <Input
                id="edit-email"
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                placeholder="email@example.com"
                disabled={isSuperAdmin}
              />
            </div>
            {isSuperAdmin && (
              <p className="text-xs text-muted-foreground">
                Global admin profiles cannot be edited by trip admins.
              </p>
            )}
          </div>

          <Separator />

          {/* Password section */}
          <div className="space-y-4">
            <div>
              <p className="text-sm font-semibold text-foreground">Set Password</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Use this to set or reset the traveler's login password.
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-password">New Password</Label>
              <div className="relative">
                <Input
                  id="edit-password"
                  type={showPassword ? 'text' : 'password'}
                  value={newPassword}
                  onChange={e => setNewPassword(e.target.value)}
                  placeholder="At least 6 characters"
                  disabled={isSuperAdmin}
                  className="pr-10"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(v => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  tabIndex={-1}
                >
                  {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-confirm-password">Confirm Password</Label>
              <Input
                id="edit-confirm-password"
                type={showPassword ? 'text' : 'password'}
                value={confirmPassword}
                onChange={e => setConfirmPassword(e.target.value)}
                placeholder="Repeat password"
                disabled={isSuperAdmin}
              />
            </div>
            {!isSuperAdmin && (
              <Button
                type="button"
                variant="outline"
                className="w-full"
                onClick={handleSetPassword}
                disabled={savingPassword || !newPassword || !confirmPassword}
              >
                {savingPassword
                  ? <span className="h-4 w-4 animate-spin inline-block border-2 border-current border-t-transparent rounded-full mr-2" />
                  : null}
                {savingPassword ? 'Setting password…' : 'Set Password'}
              </Button>
            )}
          </div>
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={handleSaveProfile}
            disabled={savingProfile || isSuperAdmin || !name.trim()}
          >
            {savingProfile
              ? <span className="h-4 w-4 animate-spin inline-block border-2 border-current border-t-transparent rounded-full mr-2" />
              : null}
            {savingProfile ? 'Saving…' : 'Save Profile'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Main TripTravelers component ──────────────────────────────────────────────

export function TripTravelers({ tripId }: { tripId: number }) {
  const queryClient = useQueryClient();
  const { data: participants } = useListTripParticipants(tripId);
  const removeParticipant = useRemoveTripParticipant();
  const [removeWarning, setRemoveWarning] = useState<{ userId: number; name: string } | null>(null);
  const [togglingAdminId, setTogglingAdminId] = useState<number | null>(null);
  const [editTarget, setEditTarget] = useState<EditTarget | null>(null);

  const currentParticipantIds = participants?.map(p => p.id) ?? [];

  const handleToggleTripAdmin = async (userId: number, currentlyAdmin: boolean) => {
    setTogglingAdminId(userId);
    try {
      const res = await fetch(`/api/trips/${tripId}/participants/${userId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ isTripAdmin: !currentlyAdmin }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        toast.error(err?.error || 'Failed to update role');
        return;
      }
      queryClient.invalidateQueries({ queryKey: getListTripParticipantsQueryKey(tripId) });
      toast.success(currentlyAdmin ? 'Trip admin role removed' : 'Made trip admin');
    } catch {
      toast.error('Failed to update role');
    } finally {
      setTogglingAdminId(null);
    }
  };

  const doRemove = (userId: number) => {
    removeParticipant.mutate({ tripId, userId }, {
      onSuccess: (data: any) => {
        queryClient.invalidateQueries({ queryKey: getListTripParticipantsQueryKey(tripId) });
        queryClient.invalidateQueries({ queryKey: getListExpensesQueryKey(tripId) });
        queryClient.invalidateQueries({ queryKey: getGetExpenseBalanceQueryKey(tripId) });
        setRemoveWarning(null);
        const recalc = data?.splitsRecalculated ?? 0;
        const asPayer = data?.expensesAsPayer ?? 0;
        if (asPayer > 0) {
          toast.warning(
            `Traveler removed — they paid ${asPayer} expense${asPayer !== 1 ? 's' : ''}. Their balance is preserved so remaining travelers still owe them.`,
            { duration: 6000 }
          );
        } else if (recalc > 0) {
          toast.info(`Traveler removed — ${recalc} expense${recalc !== 1 ? 's' : ''} recalculated`);
        } else {
          toast.info('Traveler removed');
        }
      },
      onError: (e: any) => {
        setRemoveWarning(null);
        toast.error(e?.error || 'Failed to remove traveler');
      },
    });
  };

  return (
    <div className="max-w-2xl space-y-8">
      {/* Add traveler */}
      <div className="bg-card border rounded-xl p-6 shadow-sm space-y-4">
        <div>
          <h3 className="font-semibold flex items-center gap-2">
            <Users className="h-4 w-4 text-primary" />
            Add a Traveler
          </h3>
          <p className="text-sm text-muted-foreground mt-1">
            Search by email address. If they don't have an account yet, you can create one for them.
          </p>
        </div>
        <AddTravelerByEmail tripId={tripId} currentParticipantIds={currentParticipantIds} />
      </div>

      {/* Participant list */}
      <div className="space-y-3">
        <p className="text-sm font-medium text-muted-foreground">
          {participants?.length ?? 0} traveler{(participants?.length ?? 0) !== 1 ? 's' : ''} on this trip
        </p>
        {participants?.map(user => {
          const isTripAdmin = !!(user as any).isTripAdmin;
          return (
            <div key={user.id} className="flex items-center justify-between p-4 bg-card border rounded-xl shadow-sm">
              <div className="flex items-center gap-3">
                <div className="h-10 w-10 bg-primary/15 text-primary font-bold rounded-full flex items-center justify-center text-sm shrink-0">
                  {user.name.charAt(0).toUpperCase()}
                </div>
                <div>
                  <p className="font-medium text-sm flex items-center gap-1.5">
                    {user.name}
                    {(['admin', 'super_admin'] as string[]).includes(user.role) && (
                      <span title="Global admin"><Shield className="h-3.5 w-3.5 text-primary" /></span>
                    )}
                    {isTripAdmin && (
                      <span title="Trip admin"><Crown className="h-3.5 w-3.5 text-amber-500" /></span>
                    )}
                  </p>
                  <p className="text-xs text-muted-foreground">{user.email ?? `@${user.username}`}</p>
                </div>
              </div>
              <div className="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => setEditTarget({ id: user.id, name: user.name, email: (user as any).email ?? null, role: user.role })}
                    className="h-8 w-8 text-muted-foreground hover:text-foreground"
                    title="Edit traveler"
                  >
                    <Pencil className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => handleToggleTripAdmin(user.id, isTripAdmin)}
                    disabled={togglingAdminId === user.id}
                    className={`h-8 w-8 ${isTripAdmin ? 'text-amber-500 hover:text-amber-600' : 'text-muted-foreground hover:text-amber-500'}`}
                    title={isTripAdmin ? 'Remove trip admin role' : 'Make trip admin'}
                  >
                    {togglingAdminId === user.id
                      ? <span className="h-3 w-3 animate-spin inline-block border-2 border-current border-t-transparent rounded-full" />
                      : <Crown className="h-4 w-4" />}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => setRemoveWarning({ userId: user.id, name: user.name })}
                    className="h-8 w-8 text-destructive/60 hover:text-destructive"
                    title="Remove from trip"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
            </div>
          );
        })}
      </div>

      {/* Edit traveler dialog */}
      {editTarget && (
        <EditTravelerDialog
          tripId={tripId}
          traveler={editTarget}
          onClose={() => setEditTarget(null)}
        />
      )}

      {/* Remove confirmation */}
      <Dialog open={!!removeWarning} onOpenChange={open => { if (!open) setRemoveWarning(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <TriangleAlert className="h-5 w-5 text-amber-500" />
              Remove {removeWarning?.name}?
            </DialogTitle>
            <DialogDescription asChild>
              <div className="space-y-3 pt-1">
                <p>
                  This traveler will be removed from the trip and their unpaid splits will be
                  recalculated among the remaining travelers.
                </p>
                <div className="bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-lg px-4 py-3 text-sm text-amber-800 dark:text-amber-300">
                  <strong>Heads up:</strong> If {removeWarning?.name} paid for any group expenses,
                  their balance will be preserved and shown as a <em>departed traveler</em> on the
                  balance screen so everyone knows they're still owed money.
                </div>
              </div>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="outline" onClick={() => setRemoveWarning(null)} disabled={removeParticipant.isPending}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => removeWarning && doRemove(removeWarning.userId)}
              disabled={removeParticipant.isPending}
            >
              {removeParticipant.isPending ? 'Removing…' : 'Yes, remove traveler'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
