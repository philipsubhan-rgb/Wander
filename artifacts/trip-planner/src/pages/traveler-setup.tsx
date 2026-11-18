/**
 * Traveler setup page — the account-wall-free landing for invite links
 * (Story 4.3). The token IS the credential; there is no login here.
 *
 * The emailed/shared link is `${APP_BASE_URL}/traveler-setup?token=…`;
 * the `/traveler-setup/:token` path form is accepted too.
 *
 * Order on the page is the promise, kept in this order:
 *   1. Who invited you, and to what.
 *   2. The privacy promise — BEFORE any field is shown.
 *   3. What will be asked, and why.
 *   4. Only then, the form.
 */

import { useEffect, useMemo, useState } from "react";
import { useParams } from "wouter";
import { format, parseISO } from "date-fns";
import {
  PlaneTakeoff,
  ShieldCheck,
  Loader2,
  CheckCircle2,
  AlertTriangle,
  PartyPopper,
  HeartHandshake,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ApiError, apiFetch, apiJson } from "@/lib/api";
import { formFieldsForRequiredNames, requiredFieldLabel } from "@/lib/profile-fields";

interface NamedField {
  name: string;
  label: string;
}

interface SetupContext {
  travelerName: string;
  organizerName: string;
  trip: { title: string; destination: string; startDate: string; endDate: string };
  status: string;
  requiredFields: NamedField[];
  missingFields: NamedField[];
  privacyNotice: string;
  profileSetupAvailable: boolean;
}

interface SubmitResult {
  status: string;
  missingFields: string[];
  warnings: string[];
}

const WHY_BY_NAME: Record<string, string> = {
  passport: "So Wander can book flights and hotels under your legal name, exactly as it appears on your passport.",
  passport_number: "So Wander can book flights and hotels under your legal name, exactly as it appears on your passport.",
  passport_details: "So Wander can book flights and hotels under your legal name, exactly as it appears on your passport.",
  passport_expiry: "Many destinations turn travelers away with less than six months left on a passport — Wander checks early.",
  passport_expiration: "Many destinations turn travelers away with less than six months left on a passport — Wander checks early.",
  passport_issuing_country: "Part of matching your bookings to your passport exactly.",
  legal_name: "Bookings have to match your passport exactly — this is the name that goes on them.",
  full_name: "Bookings have to match your passport exactly — this is the name that goes on them.",
  name: "Bookings have to match your passport exactly — this is the name that goes on them.",
  date_of_birth: "Airlines and hotels ask for it at booking time.",
  dob: "Airlines and hotels ask for it at booking time.",
  phone: "So Wander — or a hotel — can reach you if plans change.",
  phone_number: "So Wander — or a hotel — can reach you if plans change.",
  emergency_contact: "Just in case: someone Wander can contact in an emergency while you're away.",
  nationality: "Some destinations have entry rules based on nationality; Wander checks before it matters.",
  known_traveler_number: "Speeds up airport security screening where it's accepted.",
  frequent_flyer: "So your miles and status are credited on flights Wander books.",
  frequent_flyer_number: "So your miles and status are credited on flights Wander books.",
};

function whyFor(name: string): string {
  return WHY_BY_NAME[name.trim().toLowerCase()] ?? "Needed to set this trip up properly.";
}

const EMPTY_FORM = {
  email: "",
  legalFirstName: "",
  legalMiddleName: "",
  legalLastName: "",
  dateOfBirth: "",
  passportNumber: "",
  passportIssuingCountry: "",
  passportExpiry: "",
  nationality: "",
  phone: "",
  emergencyContactName: "",
  emergencyContactRelationship: "",
  emergencyContactPhone: "",
};
type SetupForm = typeof EMPTY_FORM;

function formatTripDates(trip: SetupContext["trip"]): string {
  try {
    return `${format(parseISO(trip.startDate), "MMM d")} – ${format(parseISO(trip.endDate), "MMM d, yyyy")}`;
  } catch {
    return `${trip.startDate} – ${trip.endDate}`;
  }
}

function PageShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-background">
      <header className="border-b bg-card">
        <div className="mx-auto flex max-w-xl items-center gap-2 px-4 py-4 text-primary">
          <PlaneTakeoff className="h-6 w-6" />
          <span className="font-serif text-lg font-bold">Wander</span>
        </div>
      </header>
      <main className="mx-auto max-w-xl space-y-6 px-4 py-8 pb-[max(2rem,env(safe-area-inset-bottom))]">
        {children}
      </main>
    </div>
  );
}

function TokenProblem({ reason }: { reason: string | null }) {
  const copy =
    reason === "expired"
      ? {
          title: "This link has expired",
          body: "Invitation links don't last forever. Ask the person who invited you to send a fresh one — it only takes them a moment from their trip page.",
        }
      : reason === "used"
        ? {
            title: "This link has already been used",
            body: "Setup links work once. If you already sent your details, you're all done — there's nothing more to do here. If something needs changing, ask the person who invited you for a fresh link.",
          }
        : {
            title: "This link doesn't look right",
            body: "It may have been copied incompletely. Try opening it again from the original email, or ask the person who invited you to send a new one.",
          };
  return (
    <PageShell>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-amber-500" /> {copy.title}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">{copy.body}</p>
        </CardContent>
      </Card>
    </PageShell>
  );
}

function Field({
  label,
  hint,
  needed,
  children,
}: {
  label: string;
  hint?: string;
  needed?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <label className="text-sm font-medium">{label}</label>
        {needed && <Badge variant="secondary">Needed for this trip</Badge>}
      </div>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

const inputCls = "min-h-[44px]";

export default function TravelerSetupPage() {
  const params = useParams();
  const token = useMemo(() => {
    if (params.token) return params.token;
    return new URLSearchParams(window.location.search).get("token") ?? "";
  }, [params.token]);

  const [context, setContext] = useState<SetupContext | null>(null);
  const [tokenProblem, setTokenProblem] = useState<string | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [form, setForm] = useState<SetupForm>(EMPTY_FORM);
  const [problems, setProblems] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<SubmitResult | null>(null);
  const [declineStep, setDeclineStep] = useState<"idle" | "confirm" | "done">("idle");
  const [declining, setDeclining] = useState(false);

  useEffect(() => {
    if (!token) {
      setTokenProblem("invalid");
      return;
    }
    let cancelled = false;
    apiFetch<SetupContext>(`/api/traveler-setup/${encodeURIComponent(token)}`)
      .then((ctx) => {
        if (!cancelled) setContext(ctx);
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof ApiError && (err.reason || err.status === 410 || err.status === 404)) {
          setTokenProblem(err.reason ?? "invalid");
        } else {
          setLoadFailed(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  const set = (key: keyof SetupForm) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));

  const neededFields = useMemo(
    () => formFieldsForRequiredNames((context?.missingFields ?? []).map((f) => f.name)),
    [context],
  );
  const needed = (field: string) => neededFields.has(field);

  const expiryInPast =
    form.passportExpiry !== "" && form.passportExpiry < new Date().toISOString().slice(0, 10);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setProblems([]);
    setSubmitting(true);
    const body: Record<string, unknown> = {};
    const put = (key: string, value: string) => {
      const v = value.trim();
      if (v) body[key] = v;
    };
    put("email", form.email);
    put("legalFirstName", form.legalFirstName);
    put("legalMiddleName", form.legalMiddleName);
    put("legalLastName", form.legalLastName);
    put("dateOfBirth", form.dateOfBirth);
    put("passportNumber", form.passportNumber);
    put("passportIssuingCountry", form.passportIssuingCountry);
    put("passportExpiry", form.passportExpiry);
    put("nationality", form.nationality);
    put("phone", form.phone);
    if (form.emergencyContactName.trim() || form.emergencyContactPhone.trim()) {
      body.emergencyContact = {
        name: form.emergencyContactName.trim(),
        relationship: form.emergencyContactRelationship.trim() || null,
        phone: form.emergencyContactPhone.trim(),
      };
    }
    try {
      const res = await apiJson(`/api/traveler-setup/${encodeURIComponent(token)}/submit`, "POST", body);
      setResult(res as SubmitResult);
    } catch (err) {
      if (err instanceof ApiError && err.problems && err.problems.length > 0) {
        // Validation happens before anything is saved, so this link
        // still works — the traveler can fix the problem and resend.
        setProblems(err.problems);
      } else if (err instanceof ApiError && err.reason) {
        setTokenProblem(err.reason);
      } else {
        setProblems([
          err instanceof Error ? err.message : "Something went wrong — please try again.",
        ]);
      }
    } finally {
      setSubmitting(false);
    }
  };

  const decline = async () => {
    setDeclining(true);
    try {
      await apiJson(`/api/traveler-setup/${encodeURIComponent(token)}/decline`, "POST", {});
      setDeclineStep("done");
    } catch (err) {
      if (err instanceof ApiError && err.reason) {
        setTokenProblem(err.reason);
      } else {
        setProblems([
          err instanceof Error ? err.message : "Something went wrong — please try again.",
        ]);
      }
    } finally {
      setDeclining(false);
    }
  };

  if (tokenProblem) return <TokenProblem reason={tokenProblem} />;

  if (loadFailed) {
    return (
      <PageShell>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-amber-500" /> Something went wrong
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              We couldn't load your invitation just now. Give it a moment and refresh the
              page — your link will still work.
            </p>
          </CardContent>
        </Card>
      </PageShell>
    );
  }

  if (!context) {
    return (
      <PageShell>
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
        </div>
      </PageShell>
    );
  }

  const { organizerName, trip } = context;
  const firstName = context.travelerName.split(" ")[0];

  if (declineStep === "done" || context.status === "declined") {
    return (
      <PageShell>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <HeartHandshake className="h-5 w-5 text-primary" /> No hard feelings
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm text-muted-foreground">
            <p>
              We've marked you as not coming on {trip.title}, so the reminders will stop.
              {` ${organizerName}`} can see you've declined on the trip roster.
            </p>
            <p>If things change, {organizerName} can invite you again any time.</p>
          </CardContent>
        </Card>
      </PageShell>
    );
  }

  if (result) {
    const stillMissing = result.missingFields.map(requiredFieldLabel);
    return (
      <PageShell>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <PartyPopper className="h-5 w-5 text-primary" />
              {result.status === "ready" ? `You're all set, ${firstName}` : "Thanks — that's saved"}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 text-sm text-muted-foreground">
            {result.warnings.includes("passport_expired") && (
              <div className="flex gap-2 rounded-md bg-amber-500/10 p-3 text-foreground">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
                <p>
                  One heads-up: the passport expiry date you entered is in the past. If
                  that's a typo, ask {organizerName} to resend your invitation so you can
                  fix it. If your passport really has expired, you'll want to renew it
                  before this trip.
                </p>
              </div>
            )}
            {result.status === "ready" ? (
              <>
                <p>
                  {organizerName} can now see that your details are complete — not what
                  they are. There's nothing else you need to do.
                </p>
                <p>
                  If a booking on this trip needs your details, Wander will use them and
                  note it in your profile's access log.
                </p>
              </>
            ) : (
              <>
                <p>We've saved what you gave us. Still needed for this trip:</p>
                <ul className="list-disc space-y-1 pl-5">
                  {stillMissing.map((label) => (
                    <li key={label}>{label}</li>
                  ))}
                </ul>
                <p>
                  This link has done its job, so Wander will send you a fresh one to
                  finish up — {organizerName} can see what's still outstanding (just the
                  names of what's missing, never the details).
                </p>
              </>
            )}
            <p>
              Want to look after these details yourself in future? On the Wander sign-in
              page, choose “Forgot password” with your email address — you can set a
              password and see your private profile any time.
            </p>
          </CardContent>
        </Card>
      </PageShell>
    );
  }

  if (context.status === "ready") {
    return (
      <PageShell>
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <CheckCircle2 className="h-5 w-5 text-primary" /> You're already set up
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              Your details for {trip.title} are complete — {organizerName} can see that
              you're ready to go, and there's nothing more to do here.
            </p>
          </CardContent>
        </Card>
      </PageShell>
    );
  }

  if (!context.profileSetupAvailable) {
    return (
      <PageShell>
        <Card>
          <CardHeader>
            <CardTitle>Setup isn't open yet</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              {organizerName} invited you to {trip.title}, but detail collection isn't
              switched on yet. They'll be in touch when it is.
            </p>
          </CardContent>
        </Card>
      </PageShell>
    );
  }

  return (
    <PageShell>
      {/* 1 — Who invited you, and to what */}
      <div className="space-y-2">
        <h1 className="font-serif text-3xl font-bold">Hi {firstName} — you're invited</h1>
        <p className="text-muted-foreground">
          {organizerName} is planning <span className="font-medium text-foreground">{trip.title}</span>
          {" — "}
          {trip.destination}, {formatTripDates(trip)} — and listed you as going.
        </p>
      </div>

      {/* 2 — The privacy promise, before any field is shown */}
      <Card className="border-primary/30 bg-primary/5">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <ShieldCheck className="h-5 w-5 text-primary" /> Your details stay yours
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <p>{context.privacyNotice}</p>
          <ul className="list-disc space-y-1.5 pl-5 text-muted-foreground">
            <li>You type your details here, straight into Wander — never through {organizerName}.</li>
            <li>
              {organizerName} can see that you're set up, and the names of anything still
              missing — never the details themselves.
            </li>
            <li>
              Wander only uses your details for trips you're part of, and every use is
              written into an access log you can read.
            </li>
          </ul>
        </CardContent>
      </Card>

      {/* 3 — What will be asked, and why */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">What we'll ask for</CardTitle>
        </CardHeader>
        <CardContent>
          {context.requiredFields.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              This trip doesn't require anything specific. Adding your details now means
              Wander can book for you later without having to ask again.
            </p>
          ) : (
            <ul className="space-y-3">
              {context.requiredFields.map((f) => (
                <li key={f.name} className="text-sm">
                  <span className="font-medium">{requiredFieldLabel(f.name)}</span>
                  <span className="text-muted-foreground"> — {whyFor(f.name)}</span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* 4 — The form */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Your details</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="space-y-4">
            {problems.length > 0 && (
              <div
                role="alert"
                className="space-y-1 rounded-md border border-destructive/50 bg-destructive/5 p-3 text-sm text-destructive"
              >
                <p className="font-medium">A couple of things to fix:</p>
                <ul className="list-disc pl-5">
                  {problems.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
                <p>Nothing was saved — fix these and send again; this link still works.</p>
              </div>
            )}

            <Field
              label="Email address"
              hint="If this link arrived by email, use that same address. If someone handed you this link in person, we need your email to save your details."
            >
              <Input
                type="email"
                autoComplete="email"
                className={inputCls}
                value={form.email}
                onChange={set("email")}
                placeholder="you@example.com"
              />
            </Field>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="First name" needed={needed("legalFirstName")} hint="Exactly as on your passport">
                <Input autoComplete="given-name" className={inputCls} value={form.legalFirstName} onChange={set("legalFirstName")} />
              </Field>
              <Field label="Middle name" hint="If your passport shows one">
                <Input autoComplete="additional-name" className={inputCls} value={form.legalMiddleName} onChange={set("legalMiddleName")} />
              </Field>
            </div>
            <Field label="Last name" needed={needed("legalLastName")} hint="Exactly as on your passport">
              <Input autoComplete="family-name" className={inputCls} value={form.legalLastName} onChange={set("legalLastName")} />
            </Field>

            <Field label="Date of birth" needed={needed("dateOfBirth")}>
              <Input type="date" autoComplete="bday" className={inputCls} value={form.dateOfBirth} onChange={set("dateOfBirth")} />
            </Field>

            <Field label="Passport number" needed={needed("passportNumber")}>
              <Input className={inputCls} value={form.passportNumber} onChange={set("passportNumber")} />
            </Field>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Issuing country" needed={needed("passportIssuingCountry")}>
                <Input autoComplete="country-name" className={inputCls} value={form.passportIssuingCountry} onChange={set("passportIssuingCountry")} placeholder="e.g. United States" />
              </Field>
              <Field label="Passport expiry" needed={needed("passportExpiry")}>
                <Input type="date" className={inputCls} value={form.passportExpiry} onChange={set("passportExpiry")} />
              </Field>
            </div>
            {expiryInPast && (
              <p className="flex items-center gap-2 text-sm text-amber-600">
                <AlertTriangle className="h-4 w-4 shrink-0" />
                That expiry date is in the past — worth a double-check before you send.
              </p>
            )}

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Nationality" needed={needed("nationality")}>
                <Input className={inputCls} value={form.nationality} onChange={set("nationality")} />
              </Field>
              <Field label="Phone number" needed={needed("phone")}>
                <Input type="tel" autoComplete="tel" className={inputCls} value={form.phone} onChange={set("phone")} />
              </Field>
            </div>

            <div className="space-y-4 rounded-md border p-3">
              <p className="text-sm font-medium">Emergency contact</p>
              <Field label="Their name" needed={needed("emergencyContactName")}>
                <Input className={inputCls} value={form.emergencyContactName} onChange={set("emergencyContactName")} />
              </Field>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label="Relationship to you">
                  <Input className={inputCls} value={form.emergencyContactRelationship} onChange={set("emergencyContactRelationship")} placeholder="e.g. Sister" />
                </Field>
                <Field label="Their phone" needed={needed("emergencyContactPhone")}>
                  <Input type="tel" className={inputCls} value={form.emergencyContactPhone} onChange={set("emergencyContactPhone")} />
                </Field>
              </div>
            </div>

            <p className="text-xs text-muted-foreground">
              Fill in what you have — anything still missing, Wander will gently remind
              you about. {organizerName} only ever sees “done” or the names of what's
              still needed.
            </p>

            <Button type="submit" disabled={submitting} className="min-h-[44px] w-full sm:w-auto">
              {submitting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Saving securely…
                </>
              ) : (
                "Save my details"
              )}
            </Button>
          </form>
        </CardContent>
      </Card>

      {/* Decline — quiet, no pressure */}
      <div className="rounded-xl border bg-card p-4">
        {declineStep === "confirm" ? (
          <div className="space-y-3">
            <p className="text-sm">
              Let {organizerName} know you can't make this trip? You'll stop getting
              reminders about it.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button variant="destructive" className="min-h-[44px]" disabled={declining} onClick={decline}>
                {declining ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                Yes, let them know
              </Button>
              <Button variant="ghost" className="min-h-[44px]" onClick={() => setDeclineStep("idle")}>
                Keep my spot
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-muted-foreground">Can't make this trip?</p>
            <Button variant="ghost" className="min-h-[44px]" onClick={() => setDeclineStep("confirm")}>
              Let {organizerName} know
            </Button>
          </div>
        )}
      </div>
    </PageShell>
  );
}
