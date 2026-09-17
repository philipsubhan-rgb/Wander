import { 
  useUpdateTrip, useDeleteTrip, useListTripParticipants, useAddTripParticipant, useRemoveTripParticipant,
  useLookupUserByEmail, requestUploadUrl,
  getGetTripQueryKey, getListTripParticipantsQueryKey, getListExpensesQueryKey, getGetExpenseBalanceQueryKey,
} from '@workspace/api-client-react';
import { useState, useEffect, useRef } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { useQueryClient } from '@tanstack/react-query';
import { useLocation } from 'wouter';
import { toast } from 'sonner';
import { Users, Trash2, Shield, TriangleAlert, Search, UserCheck, AlertCircle, Crown, Copy, Check, KeyRound, Camera, RefreshCw, ImageOff, Newspaper } from 'lucide-react';

const tripSchema = z.object({
  title: z.string().min(1, 'Title is required'),
  destination: z.string().min(1, 'Destination is required'),
  startDate: z.string().min(1, 'Start date is required'),
  endDate: z.string().min(1, 'End date is required'),
  status: z.enum(['planning', 'confirmed', 'active', 'completed']),
});

// ── Email-based participant lookup ────────────────────────────────────────────

type LookupResult = {
  id: number;
  username: string;
  name: string;
  email: string;
  role: string;
  otherTripsCount: number;
};

function AddTravelerByEmail({
  tripId,
  currentParticipantIds,
  onAdded,
}: {
  tripId: number;
  currentParticipantIds: number[];
  onAdded: () => void;
}) {
  const [email, setEmail] = useState('');
  const [searching, setSearching] = useState(false);
  const [found, setFound] = useState<LookupResult | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [inviteName, setInviteName] = useState('');
  const [inviting, setInviting] = useState(false);
  const [tempPassword, setTempPassword] = useState<{ name: string; email: string; password: string; emailSent: boolean } | null>(null);
  const [copied, setCopied] = useState(false);
  const addParticipant = useAddTripParticipant();
  const queryClient = useQueryClient();

  const copyTempPassword = () => {
    if (!tempPassword) return;
    navigator.clipboard.writeText(tempPassword.password).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

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
          // If they're on other trips, require confirmation
          if (user.otherTripsCount > 0) {
            setConfirmOpen(true);
          } else {
            // New user with no trips — add immediately
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
          if (recalc > 0) {
            toast.success(`${user.name} added — ${recalc} expense${recalc !== 1 ? 's' : ''} recalculated`);
          } else {
            toast.success(`${user.name} added to trip`);
          }
          onAdded();
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
        // Race condition: someone else created the account; prompt to search again
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
      // Show the temporary password to the admin so they can relay it
      if (data?.temporaryPassword) {
        setTempPassword({ name: trimmedName, email: trimmedEmail, password: data.temporaryPassword, emailSent: !!data?.emailSent });
        setCopied(false);
      } else {
        const recalc = data?.splitsRecalculated ?? 0;
        if (recalc > 0) {
          toast.success(`${trimmedName} added — ${recalc} expense${recalc !== 1 ? 's' : ''} recalculated`);
        } else {
          toast.success(`${trimmedName} added to trip`);
        }
      }
      onAdded();
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
          {searching ? (
            <span className="h-4 w-4 animate-spin inline-block border-2 border-current border-t-transparent rounded-full" />
          ) : (
            <Search className="h-4 w-4" />
          )}
        </Button>
      </div>

      {notFound && (
        <div className="space-y-3 bg-muted/40 border rounded-lg px-4 py-3">
          <div className="flex items-center gap-2 text-sm font-medium">
            <AlertCircle className="h-4 w-4 shrink-0 text-amber-500" />
            <span>No account found for <span className="font-semibold">{email.trim()}</span></span>
          </div>
          <p className="text-xs text-muted-foreground">
            Create a basic traveler account and add them to this trip right now.
            They can set a password later.
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
              {inviting ? (
                <span className="h-4 w-4 animate-spin inline-block border-2 border-current border-t-transparent rounded-full" />
              ) : 'Create & Add'}
            </Button>
          </div>
        </div>
      )}

      {/* Confirmation dialog for existing user on other trips */}
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

      {/* Temporary password dialog — shown once after a new traveler is created */}
      <Dialog open={!!tempPassword} onOpenChange={(open) => { if (!open) setTempPassword(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <KeyRound className="h-5 w-5 text-primary" />
              Share login details with {tempPassword?.name}
            </DialogTitle>
            <DialogDescription asChild>
              <div className="space-y-4 pt-1">
                {tempPassword?.emailSent ? (
                  <p className="text-sm">
                    A welcome email with login credentials was sent to{' '}
                    <span className="font-semibold">{tempPassword?.email}</span>.
                    The credentials are also shown below as a backup in case the email doesn't arrive.
                  </p>
                ) : (
                  <p className="text-sm">
                    A new account was created. Share these credentials with{' '}
                    <span className="font-semibold">{tempPassword?.name}</span> so they can sign in.
                    They should change their password after their first login.
                  </p>
                )}
                <div className="bg-muted rounded-lg px-4 py-3 space-y-3">
                  <div>
                    <p className="text-xs text-muted-foreground mb-1">Email (username)</p>
                    <p className="text-sm font-mono font-medium">{tempPassword?.email}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground mb-1">Temporary password</p>
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-mono font-medium flex-1 break-all">{tempPassword?.password}</p>
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        className="h-7 w-7 shrink-0"
                        onClick={copyTempPassword}
                        title="Copy password"
                      >
                        {copied ? <Check className="h-3.5 w-3.5 text-green-600" /> : <Copy className="h-3.5 w-3.5" />}
                      </Button>
                    </div>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">
                  This password will not be shown again. Once they log in, they can change it from the account menu.
                </p>
              </div>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button onClick={() => setTempPassword(null)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ── Daily one-pager settings ──────────────────────────────────────────────────

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const TIMEZONE_SUGGESTIONS = [
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'Pacific/Honolulu',
  'Europe/London',
  'Europe/Berlin',
  'Asia/Tokyo',
  'Australia/Sydney',
];

type BriefingSettings = {
  enabled: boolean;
  sendTimeLocal: string;
  timezone: string;
  extraEmails: string[];
  lastSentForDate: string | null;
};

function parseEmailList(raw: string): { emails: string[]; invalid: string[] } {
  const emails: string[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(',')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (EMAIL_RE.test(trimmed)) {
      emails.push(trimmed);
    } else {
      invalid.push(trimmed);
    }
  }
  return { emails, invalid };
}

function DailyOnePagerSettings({ tripId }: { tripId: number }) {
  const [loading, setLoading] = useState(true);
  const [enabled, setEnabled] = useState(false);
  const [sendTimeLocal, setSendTimeLocal] = useState('07:00');
  const [timezone, setTimezone] = useState('');
  const [extraEmailsText, setExtraEmailsText] = useState('');
  const [lastSentForDate, setLastSentForDate] = useState<string | null>(null);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch(`/api/trips/${tripId}/briefing`, { credentials: 'include' })
      .then(async res => {
        if (!res.ok) throw new Error('load failed');
        const data = (await res.json()) as Partial<BriefingSettings>;
        if (cancelled) return;
        setEnabled(!!data.enabled);
        setSendTimeLocal(data.sendTimeLocal || '07:00');
        setTimezone(data.timezone || '');
        setExtraEmailsText(Array.isArray(data.extraEmails) ? data.extraEmails.join(', ') : '');
        setLastSentForDate(data.lastSentForDate ?? null);
        setEmailError(null);
      })
      .catch(() => {
        if (!cancelled) toast.error('Failed to load daily one-pager settings');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [tripId]);

  const handleEmailsChange = (value: string) => {
    setExtraEmailsText(value);
    const { invalid } = parseEmailList(value);
    setEmailError(
      invalid.length > 0
        ? `Invalid email${invalid.length !== 1 ? 's' : ''}: ${invalid.join(', ')}`
        : null
    );
  };

  const handleSave = async () => {
    const time = sendTimeLocal.trim().slice(0, 5);
    if (!TIME_RE.test(time)) {
      toast.error('Send time must be in HH:MM format');
      return;
    }
    if (!timezone.trim()) {
      toast.error('Timezone is required');
      return;
    }
    const { emails, invalid } = parseEmailList(extraEmailsText);
    if (invalid.length > 0) {
      setEmailError(`Invalid email${invalid.length !== 1 ? 's' : ''}: ${invalid.join(', ')}`);
      toast.error('Fix the invalid email addresses before saving');
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`/api/trips/${tripId}/briefing`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          enabled,
          sendTimeLocal: time,
          timezone: timezone.trim(),
          extraEmails: emails,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data?.error || 'Failed to save daily one-pager settings');
        return;
      }
      setEnabled(!!data.enabled);
      setSendTimeLocal(data.sendTimeLocal ?? time);
      setTimezone(data.timezone ?? timezone.trim());
      setExtraEmailsText(Array.isArray(data.extraEmails) ? data.extraEmails.join(', ') : extraEmailsText);
      setLastSentForDate(data.lastSentForDate ?? lastSentForDate);
      toast.success('Daily one-pager settings saved');
    } catch {
      toast.error('Failed to save daily one-pager settings');
    } finally {
      setSaving(false);
    }
  };

  const handleSendNow = async () => {
    setSending(true);
    try {
      const res = await fetch(`/api/trips/${tripId}/briefing/send-now`, {
        method: 'POST',
        credentials: 'include',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data?.error || 'Failed to send daily one-pager');
        return;
      }
      if (data.sent) {
        const count = data.recipientCount ?? 0;
        toast.success(`Sent to ${count} recipient${count !== 1 ? 's' : ''}`);
        if (typeof data.lastSentForDate === 'string') setLastSentForDate(data.lastSentForDate);
      } else {
        toast.error('Email not configured — SMTP not set up');
      }
    } catch {
      toast.error('Failed to send daily one-pager');
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="space-y-3">
      <h3 className="font-semibold text-base flex items-center gap-2">
        <Newspaper className="h-4 w-4" /> Daily one-pager
      </h3>
      <div className="bg-card border rounded-xl p-6 shadow-sm">
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <span className="h-4 w-4 animate-spin inline-block border-2 border-current border-t-transparent rounded-full" />
            Loading one-pager settings…
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center justify-between gap-4">
              <div>
                <Label htmlFor="briefing-enabled" className="text-sm font-medium">Enabled</Label>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Email a daily one-pager PDF to travelers each morning.
                </p>
              </div>
              <Switch id="briefing-enabled" checked={enabled} onCheckedChange={setEnabled} />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label htmlFor="briefing-time" className="text-sm font-medium">Send time</Label>
                <Input
                  id="briefing-time"
                  type="time"
                  value={sendTimeLocal}
                  onChange={e => setSendTimeLocal(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="briefing-timezone" className="text-sm font-medium">Timezone</Label>
                <Input
                  id="briefing-timezone"
                  type="text"
                  list="briefing-timezones"
                  placeholder="America/New_York"
                  value={timezone}
                  onChange={e => setTimezone(e.target.value)}
                />
                <datalist id="briefing-timezones">
                  {TIMEZONE_SUGGESTIONS.map(tz => (
                    <option key={tz} value={tz} />
                  ))}
                </datalist>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="briefing-emails" className="text-sm font-medium">Extra email recipients</Label>
              <Input
                id="briefing-emails"
                type="text"
                placeholder="friend@example.com, family@example.com"
                value={extraEmailsText}
                onChange={e => handleEmailsChange(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Comma-separated — emailed in addition to trip travelers.
              </p>
              {emailError && <p className="text-xs text-destructive">{emailError}</p>}
            </div>

            <div className="flex flex-wrap gap-2 pt-1">
              <Button type="button" onClick={handleSave} disabled={saving || sending || !!emailError}>
                {saving ? 'Saving…' : 'Save'}
              </Button>
              <Button type="button" variant="outline" asChild>
                <a href={`/api/trips/${tripId}/briefing/preview.pdf`} target="_blank" rel="noreferrer">
                  Preview PDF
                </a>
              </Button>
              <Button type="button" variant="outline" onClick={handleSendNow} disabled={sending || saving}>
                {sending ? 'Sending…' : 'Send now'}
              </Button>
            </div>

            {lastSentForDate && (
              <p className="text-xs text-muted-foreground">Last sent for {lastSentForDate}</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Main TripSettings component ───────────────────────────────────────────────

export function TripSettings({ trip }: { trip: any }) {
  const queryClient = useQueryClient();
  const [, setLocation] = useLocation();
  const updateTrip = useUpdateTrip();
  const deleteTrip = useDeleteTrip();
  const { data: participants } = useListTripParticipants(trip.id);
  const removeParticipant = useRemoveTripParticipant();
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);

  const tripToFormValues = (t: typeof trip) => ({
    title: t.title,
    destination: t.destination,
    startDate: (t.startDate ?? '').slice(0, 10),
    endDate: (t.endDate ?? '').slice(0, 10),
    status: t.status as z.infer<typeof tripSchema>['status'],
  });

  const form = useForm<z.infer<typeof tripSchema>>({
    resolver: zodResolver(tripSchema),
    defaultValues: tripToFormValues(trip),
  });

  useEffect(() => {
    form.reset(tripToFormValues(trip));
  }, [trip.id, trip.startDate, trip.endDate, trip.title, trip.destination, trip.status]);

  const onSubmit = (values: z.infer<typeof tripSchema>) => {
    updateTrip.mutate({ tripId: trip.id, data: values }, {
      onSuccess: (updated) => {
        toast.success('Trip settings saved');
        queryClient.invalidateQueries({ queryKey: getGetTripQueryKey(trip.id) });
        form.reset({
          title: updated.title,
          destination: updated.destination,
          startDate: (updated.startDate ?? '').slice(0, 10),
          endDate: (updated.endDate ?? '').slice(0, 10),
          status: updated.status as z.infer<typeof tripSchema>['status'],
        });
      },
      onError: (err: any) => {
        toast.error(err?.data?.error ?? err?.message ?? 'Failed to save trip settings');
      },
    });
  };

  // ── Cover image management ─────────────────────────────────────────────────
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploadingCover, setUploadingCover] = useState(false);
  const [refreshingCover, setRefreshingCover] = useState(false);

  const coverSrc = trip.coverImage
    ? (trip.coverImage.startsWith('/objects/')
        ? `/api/trips/${trip.id}/cover`
        : trip.coverImage)
    : null;

  const handleCoverFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!fileInputRef.current) return;
    fileInputRef.current.value = '';
    if (!file) return;
    if (!file.type.startsWith('image/')) { toast.error('Please select an image file'); return; }
    if (file.size > 10 * 1024 * 1024) { toast.error('Image must be under 10 MB'); return; }

    setUploadingCover(true);
    try {
      const { uploadURL, objectPath } = await requestUploadUrl({ name: file.name, size: file.size, contentType: file.type });
      await fetch(uploadURL, { method: 'PUT', body: file, headers: { 'Content-Type': file.type } });
      await updateTrip.mutateAsync({ tripId: trip.id, data: { coverImage: objectPath } });
      queryClient.invalidateQueries({ queryKey: getGetTripQueryKey(trip.id) });
      toast.success('Cover photo updated');
    } catch {
      toast.error('Failed to upload cover photo');
    } finally {
      setUploadingCover(false);
    }
  };

  const handleRefreshCover = async () => {
    setRefreshingCover(true);
    try {
      const res = await fetch(`/api/trips/${trip.id}/refresh-cover`, { method: 'POST', credentials: 'include' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { toast.error(data?.error || 'Could not find an image for this destination'); return; }
      queryClient.invalidateQueries({ queryKey: getGetTripQueryKey(trip.id) });
      toast.success('Cover photo refreshed from destination');
    } catch {
      toast.error('Failed to refresh cover photo');
    } finally {
      setRefreshingCover(false);
    }
  };

  const handleRemoveCover = async () => {
    try {
      await updateTrip.mutateAsync({ tripId: trip.id, data: { coverImage: '' } });
      queryClient.invalidateQueries({ queryKey: getGetTripQueryKey(trip.id) });
      toast.success('Cover photo removed');
    } catch {
      toast.error('Failed to remove cover photo');
    }
  };

  const [removePayerWarning, setRemovePayerWarning] = useState<{ userId: number; name: string; expensesAsPayer: number } | null>(null);

  const doRemoveParticipant = (userId: number) => {
    removeParticipant.mutate({ tripId: trip.id, userId }, {
      onSuccess: (data: any) => {
        queryClient.invalidateQueries({ queryKey: getListTripParticipantsQueryKey(trip.id) });
        queryClient.invalidateQueries({ queryKey: getListExpensesQueryKey(trip.id) });
        queryClient.invalidateQueries({ queryKey: getGetExpenseBalanceQueryKey(trip.id) });
        setRemovePayerWarning(null);
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
        setRemovePayerWarning(null);
        toast.error(e.error || 'Failed to remove traveler');
      },
    });
  };

  const handleRemoveParticipant = (userId: number, name: string) => {
    // Check if this participant is the payer of any expenses; if so show confirmation
    const isPayer = (participants ?? []).some(p => p.id === userId);
    // We always show the warning dialog — the real count comes from the API response,
    // but we need an optimistic pre-check. Just open a confirm dialog for safety.
    setRemovePayerWarning({ userId, name, expensesAsPayer: -1 }); // -1 = unknown until confirmed
  };

  const handleDeleteTrip = () => {
    deleteTrip.mutate({ tripId: trip.id }, {
      onSuccess: () => {
        toast.success('Trip deleted');
        queryClient.invalidateQueries({ queryKey: ['listTrips'] });
        setLocation('/trips');
      },
      onError: (err: any) => {
        toast.error(err?.data?.error ?? err?.message ?? 'Failed to delete trip');
        setDeleteDialogOpen(false);
      },
    });
  };

  const [togglingAdminId, setTogglingAdminId] = useState<number | null>(null);

  const handleToggleTripAdmin = async (userId: number, currentlyAdmin: boolean) => {
    setTogglingAdminId(userId);
    try {
      const res = await fetch(`/api/trips/${trip.id}/participants/${userId}`, {
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
      queryClient.invalidateQueries({ queryKey: getListTripParticipantsQueryKey(trip.id) });
      toast.success(currentlyAdmin ? 'Trip admin role removed' : 'Made trip admin');
    } catch {
      toast.error('Failed to update role');
    } finally {
      setTogglingAdminId(null);
    }
  };

  const startDate = form.watch('startDate');
  const currentParticipantIds = participants?.map(p => p.id) ?? [];

  return (
    <div className="grid md:grid-cols-2 gap-10">
      <div className="space-y-6">
        <h2 className="text-2xl font-serif font-bold">General Settings</h2>
        <div className="bg-card border rounded-xl p-6 shadow-sm">
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
              <FormField control={form.control} name="title" render={({ field }) => (
                <FormItem><FormLabel>Trip Title</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage /></FormItem>
              )} />
              <FormField control={form.control} name="destination" render={({ field }) => (
                <FormItem><FormLabel>Destination</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage /></FormItem>
              )} />
              <div className="grid grid-cols-2 gap-4">
                <FormField control={form.control} name="startDate" render={({ field }) => (
                  <FormItem><FormLabel>Start Date</FormLabel><FormControl><Input type="date" {...field} /></FormControl><FormMessage /></FormItem>
                )} />
                <FormField control={form.control} name="endDate" render={({ field }) => (
                  <FormItem><FormLabel>End Date</FormLabel><FormControl><Input type="date" min={startDate || undefined} {...field} /></FormControl><FormMessage /></FormItem>
                )} />
              </div>
              <FormField control={form.control} name="status" render={({ field }) => (
                <FormItem><FormLabel>Status</FormLabel>
                  <Select onValueChange={field.onChange} defaultValue={field.value}>
                    <FormControl><SelectTrigger><SelectValue /></SelectTrigger></FormControl>
                    <SelectContent>
                      <SelectItem value="planning">Planning</SelectItem>
                      <SelectItem value="confirmed">Confirmed</SelectItem>
                      <SelectItem value="active">Active (Happening now)</SelectItem>
                      <SelectItem value="completed">Completed</SelectItem>
                    </SelectContent>
                  </Select>
                <FormMessage /></FormItem>
              )} />
              <div className="pt-4">
                <Button type="submit" disabled={updateTrip.isPending} className="w-full">
                  {updateTrip.isPending ? 'Saving...' : 'Save Settings'}
                </Button>
              </div>
            </form>
          </Form>
        </div>

        {/* Cover image editor */}
        <div className="space-y-3">
          <h3 className="font-semibold text-base">Cover Photo</h3>
          <div className="bg-card border rounded-xl overflow-hidden shadow-sm">
            {/* Preview */}
            <div className="relative h-36 bg-muted">
              {coverSrc ? (
                <img src={coverSrc} alt="Trip cover" className="w-full h-full object-cover" />
              ) : (
                <div className="w-full h-full flex items-center justify-center">
                  <ImageOff className="h-8 w-8 text-muted-foreground/40" />
                </div>
              )}
            </div>
            {/* Actions */}
            <div className="p-3 flex flex-wrap gap-2">
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={handleCoverFile}
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploadingCover}
                className="flex-1"
              >
                {uploadingCover
                  ? <span className="h-3.5 w-3.5 animate-spin inline-block border-2 border-current border-t-transparent rounded-full mr-1.5" />
                  : <Camera className="h-3.5 w-3.5 mr-1.5" />}
                Upload Photo
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleRefreshCover}
                disabled={refreshingCover}
                className="flex-1"
                title="Auto-fetch a photo for this destination"
              >
                {refreshingCover
                  ? <span className="h-3.5 w-3.5 animate-spin inline-block border-2 border-current border-t-transparent rounded-full mr-1.5" />
                  : <RefreshCw className="h-3.5 w-3.5 mr-1.5" />}
                Auto-generate
              </Button>
              {coverSrc && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={handleRemoveCover}
                  className="text-destructive/70 hover:text-destructive w-full"
                >
                  Remove cover photo
                </Button>
              )}
            </div>
          </div>
        </div>

        {/* Daily one-pager */}
        <DailyOnePagerSettings tripId={trip.id} />
      </div>

      <div className="space-y-6">
        <h2 className="text-2xl font-serif font-bold">Travelers</h2>
        <div className="bg-card border rounded-xl p-6 shadow-sm space-y-6">
          <div className="space-y-1">
            <p className="text-sm font-medium">Add by email</p>
            <p className="text-xs text-muted-foreground mb-2">Enter the traveler's email address to find and add them.</p>
            <AddTravelerByEmail
              tripId={trip.id}
              currentParticipantIds={currentParticipantIds}
              onAdded={() => {}}
            />
          </div>

          <div className="space-y-3">
            <p className="text-sm font-medium text-muted-foreground">
              {participants?.length ?? 0} traveler{(participants?.length ?? 0) !== 1 ? 's' : ''} on this trip
            </p>
            {participants?.map(user => {
              const isTripAdmin = !!(user as any).isTripAdmin;
              return (
                <div key={user.id} className="flex items-center justify-between p-3 bg-muted/50 rounded-lg">
                  <div className="flex items-center gap-3">
                    <div className="h-8 w-8 bg-primary/20 text-primary font-bold rounded-full flex items-center justify-center text-xs">
                      {user.name.charAt(0)}
                    </div>
                    <div>
                      <p className="font-medium text-sm flex items-center gap-1">
                        {user.name}
                        {(['admin', 'super_admin'] as string[]).includes(user.role) && <Shield className="h-3 w-3 text-primary" />}
                        {isTripAdmin && <Crown className="h-3 w-3 text-amber-500" title="Trip admin" />}
                      </p>
                      <p className="text-xs text-muted-foreground">{user.email ?? `@${user.username}`}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
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
                    <Button variant="ghost" size="icon" onClick={() => handleRemoveParticipant(user.id, user.name)} className="h-8 w-8 text-destructive hover:text-destructive">
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* Danger Zone */}
      <div className="md:col-span-2 space-y-4">
        <h2 className="text-2xl font-serif font-bold text-destructive flex items-center gap-2">
          <TriangleAlert className="h-5 w-5" /> Danger Zone
        </h2>
        <div className="bg-card border border-destructive/30 rounded-xl p-6 flex items-center justify-between">
          <div>
            <p className="font-medium">Delete this trip</p>
            <p className="text-sm text-muted-foreground mt-0.5">
              Permanently remove this trip and all its content. This cannot be undone.
            </p>
          </div>
          <Button variant="destructive" onClick={() => setDeleteDialogOpen(true)}>
            <Trash2 className="h-4 w-4 mr-2" /> Delete Trip
          </Button>
        </div>
      </div>

      {/* Remove participant confirmation dialog */}
      <Dialog open={!!removePayerWarning} onOpenChange={open => { if (!open) setRemovePayerWarning(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <TriangleAlert className="h-5 w-5 text-amber-500" />
              Remove {removePayerWarning?.name}?
            </DialogTitle>
            <DialogDescription asChild>
              <div className="space-y-3 pt-1">
                <p>
                  This traveler will be removed from the trip and their unpaid splits will be
                  recalculated among the remaining travelers.
                </p>
                <div className="bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-lg px-4 py-3 text-sm text-amber-800 dark:text-amber-300">
                  <strong>Heads up:</strong> If {removePayerWarning?.name} paid for any group expenses,
                  their balance will be preserved and shown as a <em>departed traveler</em> on the
                  balance screen so everyone knows they're still owed money.
                </div>
              </div>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="outline" onClick={() => setRemovePayerWarning(null)} disabled={removeParticipant.isPending}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => removePayerWarning && doRemoveParticipant(removePayerWarning.userId)}
              disabled={removeParticipant.isPending}
            >
              {removeParticipant.isPending ? 'Removing…' : 'Yes, remove traveler'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete "{trip.title}"?</DialogTitle>
            <DialogDescription>
              This will permanently delete the trip and all associated flights, accommodations,
              activities, and other content. This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="outline" onClick={() => setDeleteDialogOpen(false)} disabled={deleteTrip.isPending}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleDeleteTrip} disabled={deleteTrip.isPending}>
              {deleteTrip.isPending ? 'Deleting...' : 'Yes, delete trip'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
