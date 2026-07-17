import { useListUsers, useCreateUser, useDeleteUser, useChangeUserPassword, getListUsersQueryKey } from '@workspace/api-client-react';
import { useAuth } from '@/hooks/use-auth';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Copy, MoreVertical, Key, Trash2, Shield, User as UserIcon, Plus } from 'lucide-react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

const userSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  username: z.string().min(1, 'Username is required'),
  password: z.string().min(6, 'Password must be at least 6 characters'),
  email: z.string().email('Invalid email').optional().or(z.literal('')),
  role: z.enum(['admin', 'traveler']),
});

const passwordSchema = z.object({
  newPassword: z.string().min(6, 'Password must be at least 6 characters'),
});

export default function AdminUsers() {
  const { data: users, isLoading } = useListUsers();
  const [isNewUserOpen, setIsNewUserOpen] = useState(false);
  const [selectedUserId, setSelectedUserId] = useState<number | null>(null);
  const [isPasswordOpen, setIsPasswordOpen] = useState(false);

  if (isLoading) return <div className="p-8">Loading travelers...</div>;

  const handleCopyCredentials = (username: string) => {
    navigator.clipboard.writeText(`Username: ${username}`);
    toast.success('Username copied to clipboard');
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
            <Button>
              <Plus className="h-4 w-4 mr-2" />
              New Traveler
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Add New Traveler</DialogTitle>
            </DialogHeader>
            <NewUserForm onSuccess={() => setIsNewUserOpen(false)} />
          </DialogContent>
        </Dialog>
      </div>

      <div className="bg-card border rounded-xl shadow-sm overflow-hidden">
        <div className="divide-y">
          {users?.map(user => (
            <div key={user.id} className="flex items-center justify-between p-4 hover:bg-muted/50 transition-colors">
              <div className="flex items-center gap-4">
                <div className={`h-10 w-10 rounded-full flex items-center justify-center font-bold ${user.role === 'admin' ? 'bg-primary/20 text-primary' : 'bg-secondary text-secondary-foreground'}`}>
                  {user.name.charAt(0).toUpperCase()}
                </div>
                <div>
                  <p className="font-medium flex items-center gap-2">
                    {user.name}
                    {user.role === 'admin' && <Shield className="h-3.5 w-3.5 text-primary" />}
                  </p>
                  <div className="flex items-center text-sm text-muted-foreground gap-2">
                    <span>@{user.username}</span>
                    {user.email && (
                      <>
                        <span>•</span>
                        <span>{user.email}</span>
                      </>
                    )}
                  </div>
                </div>
              </div>
              
              <div className="flex items-center gap-2">
                <Button variant="ghost" size="sm" onClick={() => handleCopyCredentials(user.username)} title="Copy username">
                  <Copy className="h-4 w-4" />
                </Button>
                
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon">
                      <MoreVertical className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={() => { setSelectedUserId(user.id); setIsPasswordOpen(true); }}>
                      <Key className="h-4 w-4 mr-2" />
                      Reset Password
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

      <Dialog open={isPasswordOpen} onOpenChange={setIsPasswordOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reset Password</DialogTitle>
          </DialogHeader>
          {selectedUserId && <ResetPasswordForm userId={selectedUserId} onSuccess={() => setIsPasswordOpen(false)} />}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function NewUserForm({ onSuccess }: { onSuccess: () => void }) {
  const queryClient = useQueryClient();
  const createUser = useCreateUser();
  
  const form = useForm<z.infer<typeof userSchema>>({
    resolver: zodResolver(userSchema),
    defaultValues: {
      name: '',
      username: '',
      password: '',
      email: '',
      role: 'traveler',
    },
  });

  const onSubmit = (values: z.infer<typeof userSchema>) => {
    createUser.mutate({ data: { ...values, email: values.email || undefined } }, {
      onSuccess: () => {
        toast.success('Traveler created');
        queryClient.invalidateQueries({ queryKey: getListUsersQueryKey() });
        onSuccess();
      },
      onError: (error: any) => {
        toast.error(error.error || 'Failed to create traveler');
      }
    });
  };

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4 pt-4">
        <FormField control={form.control} name="name" render={({ field }) => (
          <FormItem><FormLabel>Full Name</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage /></FormItem>
        )} />
        <div className="grid grid-cols-2 gap-4">
          <FormField control={form.control} name="username" render={({ field }) => (
            <FormItem><FormLabel>Username</FormLabel><FormControl><Input {...field} /></FormControl><FormMessage /></FormItem>
          )} />
          <FormField control={form.control} name="password" render={({ field }) => (
            <FormItem><FormLabel>Password</FormLabel><FormControl><Input type="password" {...field} /></FormControl><FormMessage /></FormItem>
          )} />
        </div>
        <FormField control={form.control} name="email" render={({ field }) => (
          <FormItem><FormLabel>Email (Optional)</FormLabel><FormControl><Input type="email" {...field} /></FormControl><FormMessage /></FormItem>
        )} />
        <FormField control={form.control} name="role" render={({ field }) => (
          <FormItem>
            <FormLabel>Role</FormLabel>
            <Select onValueChange={field.onChange} defaultValue={field.value}>
              <FormControl>
                <SelectTrigger><SelectValue placeholder="Select role" /></SelectTrigger>
              </FormControl>
              <SelectContent>
                <SelectItem value="traveler">Traveler</SelectItem>
                <SelectItem value="admin">Admin</SelectItem>
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

function ResetPasswordForm({ userId, onSuccess }: { userId: number, onSuccess: () => void }) {
  const changePassword = useChangeUserPassword();
  
  const form = useForm<z.infer<typeof passwordSchema>>({
    resolver: zodResolver(passwordSchema),
    defaultValues: { newPassword: '' },
  });

  const onSubmit = (values: z.infer<typeof passwordSchema>) => {
    changePassword.mutate({ userId, data: values }, {
      onSuccess: () => {
        toast.success('Password updated');
        onSuccess();
      },
      onError: (error: any) => {
        toast.error(error.error || 'Failed to update password');
      }
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

function DeleteUserItem({ userId, userName }: { userId: number, userName: string }) {
  const queryClient = useQueryClient();
  const deleteUser = useDeleteUser();

  const handleDelete = () => {
    if (confirm(`Are you sure you want to remove ${userName}?`)) {
      deleteUser.mutate({ userId }, {
        onSuccess: () => {
          toast.success('User removed');
          queryClient.invalidateQueries({ queryKey: getListUsersQueryKey() });
        },
        onError: (error: any) => toast.error(error.error || 'Failed to remove user')
      });
    }
  };

  return (
    <DropdownMenuItem onClick={handleDelete} className="text-destructive focus:text-destructive">
      <Trash2 className="h-4 w-4 mr-2" />
      Remove User
    </DropdownMenuItem>
  );
}
