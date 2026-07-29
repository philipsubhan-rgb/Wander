import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { useLocation, useSearch } from 'wouter';
import { Button } from '@/components/ui/button';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { PlaneTakeoff, Loader2, ArrowLeft } from 'lucide-react';
import { toast } from 'sonner';
import { useState } from 'react';
import { useResetPassword } from '@workspace/api-client-react';

const resetPasswordSchema = z
  .object({
    newPassword: z.string().min(8, 'Password must be at least 8 characters'),
    confirmPassword: z.string().min(1, 'Please confirm your password'),
  })
  .refine((data) => data.newPassword === data.confirmPassword, {
    message: "Passwords don't match",
    path: ['confirmPassword'],
  });

export default function ResetPassword() {
  const [, setLocation] = useLocation();
  const search = useSearch();
  const params = new URLSearchParams(search);
  const token = params.get('token') ?? '';
  const [success, setSuccess] = useState(false);

  const resetPasswordMutation = useResetPassword();

  const form = useForm<z.infer<typeof resetPasswordSchema>>({
    resolver: zodResolver(resetPasswordSchema),
    defaultValues: { newPassword: '', confirmPassword: '' },
  });

  const onSubmit = (values: z.infer<typeof resetPasswordSchema>) => {
    if (!token) {
      toast.error('Invalid reset link. Please request a new one.');
      return;
    }
    resetPasswordMutation.mutate(
      { data: { token, newPassword: values.newPassword } },
      {
        onSuccess: () => {
          setSuccess(true);
        },
        onError: (error: any) => {
          toast.error(error?.error ?? 'This reset link is invalid or has expired. Please request a new one.');
        },
      }
    );
  };

  return (
    <div className="min-h-screen grid lg:grid-cols-2 bg-background">
      <div className="flex items-center justify-center p-8 sm:p-12 lg:p-16">
        <div className="w-full max-w-[400px] space-y-8">
          <div className="space-y-2 text-center lg:text-left">
            <div className="flex items-center justify-center lg:justify-start gap-2 text-primary mb-8">
              <PlaneTakeoff className="h-8 w-8" />
              <span className="font-serif font-bold text-2xl tracking-tight text-foreground">Wander</span>
            </div>
            <h1 className="text-3xl font-serif font-semibold tracking-tight text-foreground">
              {success ? 'Password updated' : 'Set new password'}
            </h1>
            <p className="text-muted-foreground">
              {success
                ? 'Your password has been reset successfully.'
                : 'Choose a strong password for your account.'}
            </p>
          </div>

          {!token && !success ? (
            <div className="space-y-4">
              <p className="text-sm text-destructive">
                This reset link is missing a token. Please use the link from your email or request a new one.
              </p>
              <Button
                variant="outline"
                className="w-full"
                onClick={() => setLocation('/forgot-password')}
              >
                Request a new reset link
              </Button>
            </div>
          ) : success ? (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                You can now sign in with your new password.
              </p>
              <Button className="w-full" onClick={() => setLocation('/login')}>
                Sign in
              </Button>
            </div>
          ) : (
            <Form {...form}>
              <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
                <div className="space-y-4">
                  <FormField
                    control={form.control}
                    name="newPassword"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>New password</FormLabel>
                        <FormControl>
                          <Input
                            type="password"
                            placeholder="••••••••"
                            {...field}
                            className="bg-white"
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="confirmPassword"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Confirm new password</FormLabel>
                        <FormControl>
                          <Input
                            type="password"
                            placeholder="••••••••"
                            {...field}
                            className="bg-white"
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

                <Button type="submit" className="w-full" disabled={resetPasswordMutation.isPending}>
                  {resetPasswordMutation.isPending ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : null}
                  Update password
                </Button>

                <button
                  type="button"
                  onClick={() => setLocation('/login')}
                  className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors mx-auto"
                >
                  <ArrowLeft className="h-3 w-3" />
                  Back to sign in
                </button>
              </form>
            </Form>
          )}
        </div>
      </div>

      <div className="hidden lg:block relative bg-muted">
        <div className="absolute inset-0 bg-primary/10 mix-blend-multiply z-10" />
        <img
          src="https://images.unsplash.com/photo-1548013146-72479768bada?q=80&w=2076&auto=format&fit=crop"
          alt="Golden hour landscape"
          className="absolute inset-0 h-full w-full object-cover"
        />
        <div className="absolute inset-0 bg-gradient-to-t from-black/40 to-transparent z-10" />
        <div className="absolute bottom-12 left-12 right-12 z-20">
          <h2 className="text-4xl font-serif font-bold text-white mb-4">
            The world awaits.
          </h2>
          <p className="text-lg text-white/90 max-w-md">
            Your next great adventure is meticulously organized and ready for takeoff.
          </p>
        </div>
      </div>
    </div>
  );
}
