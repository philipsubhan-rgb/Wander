import { 
  useUpdateTrip, useDeleteTrip, useListTripParticipants, useAddTripParticipant, useRemoveTripParticipant,
  useLookupUserByEmail,
  getGetTripQueryKey, getListTripParticipantsQueryKey, getListExpensesQueryKey, getGetExpenseBalanceQueryKey,
} from '@workspace/api-client-react';
import { useState, useEffect, useRef } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { useQueryClient } from '@tanstack/react-query';
import { useLocation } from 'wouter';
import { toast } from 'sonner';
import { Users, Trash2, Shield, TriangleAlert, Search, UserCheck, AlertCircle } from 'lucide-react';

const tripSchema = z.object({
  title: z.string().min(1, 'Title is required'),
  destination: z.string().min(1, 'Destination is required'),
  startDate: z.string().min(1, 'Start date is required'),
  endDate: z.string().min(1, 'End date is required'),
  status: z.enum(['planning', 'confirmed', 'active', 'completed']),
  coverImage: z.string().optional(),
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
        <div className="flex items-center gap-2 text-sm text-muted-foreground bg-muted/50 rounded-lg px-3 py-2">
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span>No traveler found with that email. Ask an admin to create an account first.</span>
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
    coverImage: t.coverImage ?? '',
  });

  const form = useForm<z.infer<typeof tripSchema>>({
    resolver: zodResolver(tripSchema),
    defaultValues: tripToFormValues(trip),
  });

  useEffect(() => {
    form.reset(tripToFormValues(trip));
  }, [trip.id, trip.startDate, trip.endDate, trip.title, trip.destination, trip.status, trip.coverImage]);

  const onSubmit = (values: z.infer<typeof tripSchema>) => {
    const payload = { ...values, coverImage: values.coverImage || undefined };
    updateTrip.mutate({ tripId: trip.id, data: payload }, {
      onSuccess: (updated) => {
        toast.success('Trip settings saved');
        queryClient.invalidateQueries({ queryKey: getGetTripQueryKey(trip.id) });
        form.reset({
          title: updated.title,
          destination: updated.destination,
          startDate: (updated.startDate ?? '').slice(0, 10),
          endDate: (updated.endDate ?? '').slice(0, 10),
          status: updated.status as z.infer<typeof tripSchema>['status'],
          coverImage: updated.coverImage ?? '',
        });
      },
      onError: (err: any) => {
        toast.error(err?.data?.error ?? err?.message ?? 'Failed to save trip settings');
      },
    });
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
              <FormField control={form.control} name="coverImage" render={({ field }) => (
                <FormItem><FormLabel>Cover Image URL</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage /></FormItem>
              )} />
              <div className="pt-4">
                <Button type="submit" disabled={updateTrip.isPending} className="w-full">
                  {updateTrip.isPending ? 'Saving...' : 'Save Settings'}
                </Button>
              </div>
            </form>
          </Form>
        </div>
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
            {participants?.map(user => (
              <div key={user.id} className="flex items-center justify-between p-3 bg-muted/50 rounded-lg">
                <div className="flex items-center gap-3">
                  <div className="h-8 w-8 bg-primary/20 text-primary font-bold rounded-full flex items-center justify-center text-xs">
                    {user.name.charAt(0)}
                  </div>
                  <div>
                    <p className="font-medium text-sm flex items-center gap-1">
                      {user.name}
                      {(['admin', 'super_admin'] as string[]).includes(user.role) && <Shield className="h-3 w-3 text-primary" />}
                    </p>
                    <p className="text-xs text-muted-foreground">{user.email ?? `@${user.username}`}</p>
                  </div>
                </div>
                <Button variant="ghost" size="icon" onClick={() => handleRemoveParticipant(user.id, user.name)} className="h-8 w-8 text-destructive hover:text-destructive">
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            ))}
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
