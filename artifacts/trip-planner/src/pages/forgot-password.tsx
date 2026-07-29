import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { useLocation } from 'wouter';
import { Button } from '@/components/ui/button';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { PlaneTakeoff, Loader2, ArrowLeft } from 'lucide-react';
import { toast } from 'sonner';
import { useState } from 'react';
import { useForgotPassword } from '@workspace/api-client-react';

const forgotPasswordSchema = z.object({
  email: z.string().email('Please enter a valid email address'),
});

export default function ForgotPassword() {
  const [, setLocation] = useLocation();
  const [submitted, setSubmitted] = useState(false);
  const forgotPasswordMutation = useForgotPassword();

  const form = useForm<z.infer<typeof forgotPasswordSchema>>({
    resolver: zodResolver(forgotPasswordSchema),
    defaultValues: { email: '' },
  });

  const onSubmit = (values: z.infer<typeof forgotPasswordSchema>) => {
    forgotPasswordMutation.mutate(
      { data: { email: values.email } },
      {
        onSuccess: () => {
          setSubmitted(true);
        },
        onError: () => {
          toast.error('Something went wrong. Please try again.');
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
              Forgot password?
            </h1>
            <p className="text-muted-foreground">
              {submitted
                ? "Check your inbox for a reset link."
                : "Enter your email and we'll send you a reset link."}
            </p>
          </div>

          {submitted ? (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                If an account exists for that email address, you'll receive a password reset link shortly. The link expires in 1 hour.
              </p>
              <Button
                variant="outline"
                className="w-full"
                onClick={() => setLocation('/login')}
              >
                <ArrowLeft className="mr-2 h-4 w-4" />
                Back to sign in
              </Button>
            </div>
          ) : (
            <Form {...form}>
              <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
                <FormField
                  control={form.control}
                  name="email"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Email</FormLabel>
                      <FormControl>
                        <Input
                          type="email"
                          placeholder="Enter your email address"
                          {...field}
                          className="bg-white"
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <Button type="submit" className="w-full" disabled={forgotPasswordMutation.isPending}>
                  {forgotPasswordMutation.isPending ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : null}
                  Send reset link
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
