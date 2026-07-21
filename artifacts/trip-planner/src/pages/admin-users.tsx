import {
  useListUsers, useCreateUser, useUpdateUser, useDeleteUser, useChangeUserPassword,
  useListTrips, useAddTripParticipant, useRemoveTripParticipant,
  getListUsersQueryKey,
} from '@workspace/api-client-react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Badge } from '@/components/ui/badge';
import { Copy, MoreVertical, Key, Trash2, Shield, Pencil, Plus, Plane, UserCheck, UserX, ShieldCheck } from 'lucide-react';

// ── Schemas ───────────────────────────────────────────────────────────────────

const newUserSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  password: z.string().min(6, 'Password must be at least 6 characters'),
  email: z.string().email('Valid email is required'),
  role: z.enum(['super_admin', 'admin', 'traveler']),
});

const editUserSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  email: z.string().email('Valid email is required'),
  role: z.enum(['super_admin', 'admin', 'traveler']),
});

const passwordSchema = z.object({
  newPassword: z.string().min(6, 'Password must be at least 6 characters'),
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function RoleBadge({ role }: { role: string }) {
  if (role === 'super_admin') return (
    <Badge className="bg-purple-100 text-purple-700 border-purple-200 text-xs">
      <ShieldCheck className="h-3 w-3 mr-1" />Super Admin
    </Badge>
  );
  if (role === 'admin') return (
    <Badge className="bg-primary/10 text-primary border-primary/20 text-xs">
      <Shield className="h-3 w-3 mr-1" />Admin
    </Badge>
  );
  return null;
}

function AvatarCircle({ name, role }: { name: string; role: string }) {
  const bg =
    role === 'super_admin' ? 'bg-purple-100 text-purple-700' :
    role === 'admin' ? 'bg-primary/20 text-primary' :
    'bg-secondary text-secondary-foreground';
  return (
    <div className={`h-10 w-10 rounded-full flex items-center justify-center font-bold text-sm ${bg}`}>
      {name.charAt(0).toUpperCase()}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function AdminUsers() {
  const { data: users, isLoading } = useListUsers();
  const [isNewUserOpen, setIsNewUserOpen] = useState(false);
  const [editUser, setEditUser] = useState<any | null>(null);
  const [passwordUserId, setPasswordUserId] = useState<number | null>(null);

  if (isLoading) return <div className="p-8">Loading travelers...</div>;

  const handleCopyEmail = (email: string) => {
    navigator.clipboard.writeText(email);
    toast.success('Email copied to clipboard');
  };

  return (
    <div className="p-6 md:p-10 max-w-5xl mx-auto space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-serif font-bold">Travelers</h1>
          <p className="text-muted-foreground mt-1">Manage people who can access trips.</p>
        </div>
        <Dialog open={isNewUserOpen} onOpenChange={setIsNewUserOpen}>
          <DialogTrigger asChild>
            <Button><Plus className="h-4 w-4 mr-2" />New Traveler</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader><DialogTitle>Add New Traveler</DialogTitle></DialogHeader>
            <NewUserForm onSuccess={() => setIsNewUserOpen(false)} />
          </DialogContent>
        </Dialog>
      </div>

      <div className="bg-card border rounded-xl shadow-sm overflow-hidden">
        <div className="divide-y">
          {users?.map(user => (
            <div key={user.id} className="flex items-center justify-between p-4 hover:bg-muted/50 transition-colors">
              <div className="flex items-center gap-4">
                <AvatarCircle name={user.name} role={user.role} />
                <div>
                  <p className="font-medium flex items-center gap-2">
                    {user.name}
                    <RoleBadge role={user.role} />
                  </p>
                  <p className="text-sm text-muted-foreground">{user.email}</p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Button variant="ghost" size="sm" onClick={() => handleCopyEmail(user.email)} title="Copy email">
                  <Copy className="h-4 w-4" />
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon"><MoreVertical className="h-4 w-4" /></Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={() => setEditUser(user)}>
                      <Pencil className="h-4 w-4 mr-2" />Edit Details
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => setPasswordUserId(user.id)}>
                      <Key className="h-4 w-4 mr-2" />Reset Password
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DeleteUserItem userId={user.id} userName={user.name} />
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Edit dialog */}
      <Dialog open={!!editUser} onOpenChange={open => { if (!open) setEditUser(null); }}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Edit Traveler — {editUser?.name}</DialogTitle>
          </DialogHeader>
          {editUser && (
            <div className="grid md:grid-cols-2 gap-8 pt-2">
              <EditUserForm user={editUser} onSuccess={() => setEditUser(null)} />
              <TripAccessSection userId={editUser.id} />
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Reset password dialog */}
      <Dialog open={!!passwordUserId} onOpenChange={open => { if (!open) setPasswordUserId(null); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>Reset Password</DialogTitle></DialogHeader>
          {passwordUserId && (
            <ResetPasswordForm userId={passwordUserId} onSuccess={() => setPasswordUserId(null)} />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ── Edit user form ────────────────────────────────────────────────────────────

function EditUserForm({ user, onSuccess }: { user: any; onSuccess: () => void }) {
  const queryClient = useQueryClient();
  const updateUser = useUpdateUser();

  const form = useForm<z.infer<typeof editUserSchema>>({
    resolver: zodResolver(editUserSchema),
    defaultValues: {
      name: user.name,
      email: user.email ?? '',
      role: user.role as 'super_admin' | 'admin' | 'traveler',
    },
  });

  const onSubmit = (values: z.infer<typeof editUserSchema>) => {
    updateUser.mutate(
      { userId: user.id, data: values },
      {
        onSuccess: () => {
          toast.success('Traveler updated');
          queryClient.invalidateQueries({ queryKey: getListUsersQueryKey() });
          onSuccess();
        },
        onError: (err: any) => toast.error(err?.data?.error ?? err?.message ?? 'Failed to update'),
      },
    );
  };

  return (
    <div className="space-y-4">
      <h3 className="font-semibold text-base">Profile Details</h3>
      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
          <FormField control={form.control} name="name" render={({ field }) => (
            <FormItem><FormLabel>Full Name</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage /></FormItem>
          )} />
          <FormField control={form.control} name="email" render={({ field }) => (
            <FormItem><FormLabel>Email (used to log in)</FormLabel><FormControl><Input type="email" {...field} /></FormControl><FormMessage /></FormItem>
          )} />
          <FormField control={form.control} name="role" render={({ field }) => (
            <FormItem>
              <FormLabel>Role</FormLabel>
              <Select onValueChange={field.onChange} value={field.value}>
                <FormControl><SelectTrigger><SelectValue /></SelectTrigger></FormControl>
                <SelectContent>
                  <SelectItem value="traveler">Traveler</SelectItem>
                  <SelectItem value="admin">Admin</SelectItem>
                  <SelectItem value="super_admin">Super Admin</SelectItem>
                </SelectContent>
              </Select>
              <FormMessage />
            </FormItem>
          )} />
          <Button type="submit" className="w-full" disabled={updateUser.isPending}>
            {updateUser.isPending ? 'Saving...' : 'Save Changes'}
          </Button>
        </form>
      </Form>
    </div>
  );
}

// ── Trip access section ───────────────────────────────────────────────────────

function TripAccessSection({ userId }: { userId: number }) {
  const queryClient = useQueryClient();
  const { data: allTrips, isLoading: tripsLoading } = useListTrips();
  const { data: userTripIds, isLoading: userTripsLoading } = useQuery<number[]>({
    queryKey: ['userTrips', userId],
    queryFn: () => fetch(`/api/users/${userId}/trips`, { credentials: 'include' }).then(r => r.json()),
  });
  const addParticipant = useAddTripParticipant();
  const removeParticipant = useRemoveTripParticipant();

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['userTrips', userId] });

  const handleToggle = (tripId: number, currentlyOn: boolean) => {
    if (currentlyOn) {
      removeParticipant.mutate({ tripId, userId }, { onSuccess: invalidate, onError: () => toast.error('Failed to remove from trip') });
    } else {
      addParticipant.mutate({ tripId, data: { userId } }, { onSuccess: invalidate, onError: () => toast.error('Failed to add to trip') });
    }
  };

  const isLoading = tripsLoading || userTripsLoading;

  return (
    <div className="space-y-4">
      <h3 className="font-semibold text-base flex items-center gap-2">
        <Plane className="h-4 w-4" /> Trip Access
      </h3>
      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading trips…</p>
      ) : !allTrips?.length ? (
        <p className="text-sm text-muted-foreground">No trips exist yet.</p>
      ) : (
        <div className="space-y-2 max-h-80 overflow-y-auto pr-1">
          {allTrips.map(trip => {
            const isOn = userTripIds?.includes(trip.id) ?? false;
            const isPending = addParticipant.isPending || removeParticipant.isPending;
            return (
              <div
                key={trip.id}
                className="flex items-center justify-between gap-3 p-3 rounded-lg border bg-muted/30 hover:bg-muted/60 transition-colors"
              >
                <div className="min-w-0">
                  <p className="font-medium text-sm truncate">{trip.title}</p>
                  <p className="text-xs text-muted-foreground truncate">{trip.destination}</p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {isOn && <Badge variant="secondary" className="text-xs">Assigned</Badge>}
                  <Button
                    variant={isOn ? 'outline' : 'default'}
                    size="sm"
                    disabled={isPending}
                    onClick={() => handleToggle(trip.id, isOn)}
                    className="h-7 text-xs"
                  >
                    {isOn
                      ? <><UserX className="h-3 w-3 mr-1" />Remove</>
                      : <><UserCheck className="h-3 w-3 mr-1" />Assign</>
                    }
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── New user form ─────────────────────────────────────────────────────────────

function NewUserForm({ onSuccess }: { onSuccess: () => void }) {
  const queryClient = useQueryClient();
  const createUser = useCreateUser();

  const form = useForm<z.infer<typeof newUserSchema>>({
    resolver: zodResolver(newUserSchema),
    defaultValues: { name: '', password: '', email: '', role: 'traveler' },
  });

  const onSubmit = (values: z.infer<typeof newUserSchema>) => {
    createUser.mutate({ data: values }, {
      onSuccess: () => {
        toast.success('Traveler created');
        queryClient.invalidateQueries({ queryKey: getListUsersQueryKey() });
        onSuccess();
      },
      onError: (error: any) => toast.error(error?.data?.error ?? error?.message ?? 'Failed to create traveler'),
    });
  };

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4 pt-4">
        <FormField control={form.control} name="name" render={({ field }) => (
          <FormItem><FormLabel>Full Name</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage /></FormItem>
        )} />
        <FormField control={form.control} name="email" render={({ field }) => (
          <FormItem><FormLabel>Email (used to log in)</FormLabel><FormControl><Input type="email" {...field} /></FormControl><FormMessage /></FormItem>
        )} />
        <FormField control={form.control} name="password" render={({ field }) => (
          <FormItem><FormLabel>Temporary Password</FormLabel><FormControl><Input type="password" {...field} /></FormControl><FormMessage /></FormItem>
        )} />
        <FormField control={form.control} name="role" render={({ field }) => (
          <FormItem>
            <FormLabel>Role</FormLabel>
            <Select onValueChange={field.onChange} defaultValue={field.value}>
              <FormControl><SelectTrigger><SelectValue placeholder="Select role" /></SelectTrigger></FormControl>
              <SelectContent>
                <SelectItem value="traveler">Traveler</SelectItem>
                <SelectItem value="admin">Admin</SelectItem>
                <SelectItem value="super_admin">Super Admin</SelectItem>
              </SelectContent>
            </Select>
            <FormMessage />
          </FormItem>
        )} />
        <div className="flex justify-end pt-4">
          <Button type="submit" disabled={createUser.isPending}>
            {createUser.isPending ? 'Creating...' : 'Create'}
          </Button>
        </div>
      </form>
    </Form>
  );
}

// ── Reset password form ───────────────────────────────────────────────────────

function ResetPasswordForm({ userId, onSuccess }: { userId: number; onSuccess: () => void }) {
  const changePassword = useChangeUserPassword();
  const form = useForm<z.infer<typeof passwordSchema>>({
    resolver: zodResolver(passwordSchema),
    defaultValues: { newPassword: '' },
  });

  const onSubmit = (values: z.infer<typeof passwordSchema>) => {
    changePassword.mutate({ userId, data: values }, {
      onSuccess: () => { toast.success('Password updated'); onSuccess(); },
      onError: (error: any) => toast.error(error?.data?.error ?? error?.message ?? 'Failed to update password'),
    });
  };

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4 pt-4">
        <FormField control={form.control} name="newPassword" render={({ field }) => (
          <FormItem><FormLabel>New Password</FormLabel><FormControl><Input type="text" {...field} /></FormControl><FormMessage /></FormItem>
        )} />
        <div className="flex justify-end pt-4">
          <Button type="submit" disabled={changePassword.isPending}>Update Password</Button>
        </div>
      </form>
    </Form>
  );
}

// ── Delete user dropdown item ─────────────────────────────────────────────────

function DeleteUserItem({ userId, userName }: { userId: number; userName: string }) {
  const queryClient = useQueryClient();
  const deleteUser = useDeleteUser();

  const handleDelete = () => {
    if (confirm(`Are you sure you want to remove ${userName}?`)) {
      deleteUser.mutate({ userId }, {
        onSuccess: () => {
          toast.success('User removed');
          queryClient.invalidateQueries({ queryKey: getListUsersQueryKey() });
        },
        onError: (error: any) => toast.error(error?.data?.error ?? error?.message ?? 'Failed to remove user'),
      });
    }
  };

  return (
    <DropdownMenuItem onClick={handleDelete} className="text-destructive focus:text-destructive">
      <Trash2 className="h-4 w-4 mr-2" />Remove User
    </DropdownMenuItem>
  );
}
