/**
 * "My traveler profile" — the owner's surface for the profile vault
 * (Stories 5.1/5.2/5.3, architecture §3.1/§3.3).
 *
 * Reads and writes go to /profile/me only — identity comes from the
 * session; there is no userId anywhere on this page because the API has
 * none to give. The access log at the bottom is the traveler's proof
 * the vault keeps its promise: every use of their details, by whom, for
 * what, naming fields — never values.
 */

import { useCallback, useEffect, useState } from "react";
import {
  Lock,
  Loader2,
  CheckCircle2,
  Circle,
  ScrollText,
  AlertTriangle,
  ShieldCheck,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { ApiError, apiFetch, apiJson } from "@/lib/api";
import { PROFILE_FIELDS, profileFieldLabel } from "@/lib/profile-fields";

interface EmergencyContact {
  name: string;
  relationship: string | null;
  phone: string;
}

interface ProfileView {
  userId: number;
  legalFirstName: string | null;
  legalMiddleName: string | null;
  legalLastName: string | null;
  dateOfBirth: string | null;
  passportNumber: string | null;
  passportIssuingCountry: string | null;
  passportExpiry: string | null;
  nationality: string | null;
  phone: string | null;
  emergencyContact: EmergencyContact | null;
  profileVersion: number;
  createdAt: string;
  updatedAt: string;
}

interface AccessLogEntry {
  id: number;
  accessorKind: string;
  accessorUserId: number | null;
  purpose: string;
  fieldsAccessed: string[];
  bookingId: number | null;
  createdAt: string;
}

const EMPTY_FORM = {
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
type ProfileForm = typeof EMPTY_FORM;

function formFromProfile(p: ProfileView | null): ProfileForm {
  if (!p) return EMPTY_FORM;
  return {
    legalFirstName: p.legalFirstName ?? "",
    legalMiddleName: p.legalMiddleName ?? "",
    legalLastName: p.legalLastName ?? "",
    dateOfBirth: p.dateOfBirth ?? "",
    passportNumber: p.passportNumber ?? "",
    passportIssuingCountry: p.passportIssuingCountry ?? "",
    passportExpiry: p.passportExpiry ?? "",
    nationality: p.nationality ?? "",
    phone: p.phone ?? "",
    emergencyContactName: p.emergencyContact?.name ?? "",
    emergencyContactRelationship: p.emergencyContact?.relationship ?? "",
    emergencyContactPhone: p.emergencyContact?.phone ?? "",
  };
}

function fieldPresent(p: ProfileView | null, name: string): boolean {
  if (!p) return false;
  if (name === "emergency_contact") return p.emergencyContact !== null;
  const key = name.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()) as keyof ProfileView;
  const value = p[key];
  return typeof value === "string" && value.trim() !== "";
}

const ACCESSOR_LABEL: Record<string, string> = {
  user: "You",
  agent: "Marco (Wander's agent)",
  system: "Wander (automatic)",
};

const PURPOSE_LABEL: Record<string, { title: string; detail: string }> = {
  owner_view: { title: "Viewed your profile", detail: "That's you, on this page." },
  booking_execution: {
    title: "Supplied details for a booking",
    detail: "Wander gave these details to a booking you're part of.",
  },
  derived_check: {
    title: "Completeness check",
    detail: "Wander checked whether details exist — the checker saw only yes/no, never the details.",
  },
  agent_task: {
    title: "Used for a task you asked for",
    detail: "Marco used these details for something you asked him to do.",
  },
};

function purposeLabel(purpose: string) {
  return (
    PURPOSE_LABEL[purpose] ?? {
      title: purpose.replace(/_/g, " "),
      detail: "",
    }
  );
}

const inputCls = "min-h-[44px]";

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label className="text-sm font-medium">{label}</label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

export default function TravelerProfilePage() {
  const [profile, setProfile] = useState<ProfileView | null>(null);
  const [accessLog, setAccessLog] = useState<AccessLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [form, setForm] = useState<ProfileForm>(EMPTY_FORM);
  const [problems, setProblems] = useState<string[]>([]);
  const [saveNote, setSaveNote] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const [p, log] = await Promise.all([
        apiFetch<{ profile: ProfileView | null }>("/api/profile/me"),
        apiFetch<{ accessLog: AccessLogEntry[] }>("/api/profile/me/access-log"),
      ]);
      setProfile(p.profile);
      setForm(formFromProfile(p.profile));
      setAccessLog(log.accessLog);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Failed to load your profile");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const set = (key: keyof ProfileForm) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));

  const presentCount = PROFILE_FIELDS.filter((f) => fieldPresent(profile, f.name)).length;
  const missing = PROFILE_FIELDS.filter((f) => !fieldPresent(profile, f.name));

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setProblems([]);
    setSaveNote(null);
    setSaving(true);
    const orNull = (v: string) => {
      const t = v.trim();
      return t === "" ? null : t;
    };
    const body: Record<string, unknown> = {
      legalFirstName: orNull(form.legalFirstName),
      legalMiddleName: orNull(form.legalMiddleName),
      legalLastName: orNull(form.legalLastName),
      dateOfBirth: orNull(form.dateOfBirth),
      passportNumber: orNull(form.passportNumber),
      passportIssuingCountry: orNull(form.passportIssuingCountry),
      passportExpiry: orNull(form.passportExpiry),
      nationality: orNull(form.nationality),
      phone: orNull(form.phone),
      emergencyContact:
        form.emergencyContactName.trim() || form.emergencyContactPhone.trim()
          ? {
              name: form.emergencyContactName.trim(),
              relationship: form.emergencyContactRelationship.trim() || null,
              phone: form.emergencyContactPhone.trim(),
            }
          : null,
    };
    if (profile) body.expectedVersion = profile.profileVersion;
    try {
      const res = (await apiJson("/api/profile/me", "PUT", body)) as {
        profileVersion: number;
        warnings: string[];
        flaggedEntryIds: number[];
      };
      const notes: string[] = ["Saved."];
      if (res.warnings.includes("passport_expired")) {
        notes.push("Heads-up: the passport expiry you saved is in the past.");
      }
      if (res.flaggedEntryIds.length > 0) {
        notes.push(
          `This change flagged ${res.flaggedEntryIds.length} trip${res.flaggedEntryIds.length === 1 ? "" : "s"} you're on for a details re-check — organizers see only that something changed, never what.`,
        );
      }
      setSaveNote(notes.join(" "));
      toast.success("Profile saved");
      await load();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        toast.error("Your profile changed somewhere else — we've reloaded the latest version.");
        await load();
      } else if (err instanceof ApiError && err.problems && err.problems.length > 0) {
        setProblems(err.problems);
      } else {
        toast.error(err instanceof Error ? err.message : "Saving failed");
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-4 pb-24 md:p-6 md:pb-10">
      <div>
        <h1 className="font-serif text-3xl font-bold">My traveler profile</h1>
        <p className="mt-1 text-muted-foreground">
          The private details Wander books with — kept by you, for you.
        </p>
      </div>

      <Card className="border-primary/30 bg-primary/5">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <Lock className="h-5 w-5 text-primary" /> Only you can see this page
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p>
            Trip organizers and fellow travelers can only see whether your details are
            complete — never the details themselves. There is no organizer view of this
            data, for anyone, including Wander admins.
          </p>
          <p>
            When Wander uses your details — for a booking you're part of, or a task you
            asked for — it lands in your access log below.
          </p>
        </CardContent>
      </Card>

      {loading ? (
        <div className="flex items-center justify-center py-10">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : loadError ? (
        <p className="rounded-md bg-muted p-3 text-sm text-muted-foreground">{loadError}</p>
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-lg">
                <ShieldCheck className="h-5 w-5 text-primary" /> Completeness
              </CardTitle>
              <CardDescription>
                {profile === null
                  ? "You haven't added your travel details yet. Add them once, here or from any trip invitation, and Wander can book for you without asking again."
                  : presentCount === PROFILE_FIELDS.length
                    ? "Everything's in place — Wander can book for you without asking for details again."
                    : `${presentCount} of ${PROFILE_FIELDS.length} details in place. Missing pieces only slow down bookings that need them.`}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ul className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
                {PROFILE_FIELDS.map((f) => {
                  const present = fieldPresent(profile, f.name);
                  return (
                    <li key={f.name} className="flex items-center gap-2 text-sm">
                      {present ? (
                        <CheckCircle2 className="h-4 w-4 shrink-0 text-primary" />
                      ) : (
                        <Circle className="h-4 w-4 shrink-0 text-muted-foreground" />
                      )}
                      <span className={present ? "" : "text-muted-foreground"}>{f.label}</span>
                      {!present && (
                        <Badge variant="outline" className="ml-auto">
                          Missing
                        </Badge>
                      )}
                    </li>
                  );
                })}
              </ul>
              {missing.length > 0 && profile !== null && (
                <p className="mt-3 text-xs text-muted-foreground">
                  Still missing: {missing.map((f) => f.label).join(", ")}.
                </p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Your details</CardTitle>
              <CardDescription>
                Edit anything, any time. Clearing a field removes it — bookings that
                need it will ask again.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={save} className="space-y-4">
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
                  </div>
                )}
                {saveNote && (
                  <p className="flex items-start gap-2 rounded-md bg-primary/5 p-3 text-sm">
                    <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                    {saveNote}
                  </p>
                )}

                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <Field label="First name" hint="Exactly as on your passport">
                    <Input autoComplete="given-name" className={inputCls} value={form.legalFirstName} onChange={set("legalFirstName")} />
                  </Field>
                  <Field label="Middle name" hint="If your passport shows one">
                    <Input autoComplete="additional-name" className={inputCls} value={form.legalMiddleName} onChange={set("legalMiddleName")} />
                  </Field>
                </div>
                <Field label="Last name" hint="Exactly as on your passport">
                  <Input autoComplete="family-name" className={inputCls} value={form.legalLastName} onChange={set("legalLastName")} />
                </Field>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <Field label="Date of birth">
                    <Input type="date" autoComplete="bday" className={inputCls} value={form.dateOfBirth} onChange={set("dateOfBirth")} />
                  </Field>
                  <Field label="Phone number">
                    <Input type="tel" autoComplete="tel" className={inputCls} value={form.phone} onChange={set("phone")} />
                  </Field>
                </div>
                <Field label="Passport number">
                  <Input className={inputCls} value={form.passportNumber} onChange={set("passportNumber")} />
                </Field>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <Field label="Issuing country">
                    <Input autoComplete="country-name" className={inputCls} value={form.passportIssuingCountry} onChange={set("passportIssuingCountry")} />
                  </Field>
                  <Field label="Passport expiry date">
                    <Input type="date" className={inputCls} value={form.passportExpiry} onChange={set("passportExpiry")} />
                  </Field>
                </div>
                <Field label="Nationality">
                  <Input className={inputCls} value={form.nationality} onChange={set("nationality")} />
                </Field>

                <div className="space-y-4 rounded-md border p-3">
                  <p className="text-sm font-medium">Emergency contact</p>
                  <Field label="Their name">
                    <Input className={inputCls} value={form.emergencyContactName} onChange={set("emergencyContactName")} />
                  </Field>
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <Field label="Relationship to you">
                      <Input className={inputCls} value={form.emergencyContactRelationship} onChange={set("emergencyContactRelationship")} placeholder="e.g. Sister" />
                    </Field>
                    <Field label="Their phone">
                      <Input type="tel" className={inputCls} value={form.emergencyContactPhone} onChange={set("emergencyContactPhone")} />
                    </Field>
                  </div>
                </div>

                <Button type="submit" disabled={saving} className="min-h-[44px] w-full sm:w-auto">
                  {saving ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Saving…
                    </>
                  ) : (
                    "Save my profile"
                  )}
                </Button>
              </form>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-lg">
                <ScrollText className="h-5 w-5 text-primary" /> Access log
              </CardTitle>
              <CardDescription>
                Every time your details were touched — who, when, why, and which
                fields. Values are never recorded here, and only you can read this log.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {accessLog.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  Nothing here yet. When Wander uses your details, it will show up
                  here — that's the deal.
                </p>
              ) : (
                <ul className="space-y-4">
                  {accessLog.map((entry) => {
                    const purpose = purposeLabel(entry.purpose);
                    return (
                      <li key={entry.id} className="border-b pb-4 last:border-0 last:pb-0">
                        <div className="flex flex-wrap items-baseline justify-between gap-2">
                          <p className="text-sm font-medium">{purpose.title}</p>
                          <p className="text-xs text-muted-foreground">
                            {new Date(entry.createdAt).toLocaleString()}
                          </p>
                        </div>
                        <p className="mt-0.5 text-sm text-muted-foreground">
                          By {ACCESSOR_LABEL[entry.accessorKind] ?? entry.accessorKind}
                          {entry.bookingId ? ` · Booking #${entry.bookingId}` : ""}
                          {purpose.detail ? ` — ${purpose.detail}` : ""}
                        </p>
                        {entry.fieldsAccessed.length > 0 && (
                          <div className="mt-2 flex flex-wrap gap-1.5">
                            {entry.fieldsAccessed.map((f) => (
                              <Badge key={f} variant="secondary">
                                {profileFieldLabel(f)}
                              </Badge>
                            ))}
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
              <p className="mt-4 flex items-start gap-2 text-xs text-muted-foreground">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                See something here you don't recognize? Change your password from
                Settings — your details themselves are never shown to anyone else.
              </p>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
