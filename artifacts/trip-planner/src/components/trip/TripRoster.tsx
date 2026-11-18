/**
 * TripRoster — the organizer's party view (Story 3.2, architecture §3.3).
 *
 * Renders ONLY the server's status projection: name, email, status,
 * missing field NAMES, chase summary. This component never calls a
 * profile endpoint — there is no organizer path to a traveler's private
 * details, and this surface keeps it that way by construction.
 *
 * Actions (organizer only; the server enforces it too):
 *   - Send invitations — POST /trips/:tripId/roster/send-invites, the
 *     ONE send path. Nothing anywhere else in this UI sends email.
 *   - Resend one invitation, pause/resume Wander's reminders, and copy
 *     a hand-deliverable setup link per entry.
 */

import { useCallback, useEffect, useState } from "react";
import { format, parseISO } from "date-fns";
import {
  Users,
  Loader2,
  Send,
  RefreshCw,
  Pause,
  Play,
  Link2,
  Check,
  MailWarning,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { apiFetch, apiJson } from "@/lib/api";
import { requiredFieldLabel, chaseFailureLabel } from "@/lib/profile-fields";

export interface RosterEntryView {
  id: number;
  tripId: number;
  invitedName: string;
  invitedEmail: string | null;
  status: string;
  hasLinkedAccount: boolean;
  missingFields: string[];
  chase: {
    invitesSent: number;
    remindersSent: number;
    paused: boolean;
    nextDueAt: string | null;
    escalated: boolean;
    lastFailureReason: string | null;
  };
}

interface SendInvitesSummary {
  sent: number[];
  needsEmail: number[];
  failed: Array<{ entryId: number; reason: string }>;
  skipped: Array<{ entryId: number; reason: string }>;
}

const STATUS_DISPLAY: Record<string, { label: string; variant: "default" | "secondary" | "outline" | "destructive" }> = {
  invited: { label: "Invited", variant: "secondary" },
  setting_up: { label: "Setting up", variant: "outline" },
  ready: { label: "Ready", variant: "default" },
  needs_attention: { label: "Needs attention", variant: "destructive" },
  declined: { label: "Declined", variant: "outline" },
};

function formatDay(iso: string): string {
  try {
    return format(parseISO(iso), "MMM d");
  } catch {
    return iso.slice(0, 10);
  }
}

function chaseSummary(entry: RosterEntryView): string {
  if (entry.status === "ready") return "All set — nothing outstanding.";
  if (entry.status === "declined") return "Declined — Wander won't remind them.";
  const { chase } = entry;
  const parts: string[] = [];
  if (chase.invitesSent > 0) {
    parts.push(chase.invitesSent === 1 ? "Invitation sent" : `Invitation sent ×${chase.invitesSent}`);
  } else if (entry.invitedEmail) {
    parts.push("Not invited yet");
  } else {
    parts.push("No email — share their setup link instead");
  }
  if (chase.remindersSent > 0) {
    parts.push(`${chase.remindersSent} reminder${chase.remindersSent === 1 ? "" : "s"} sent`);
  }
  if (chase.escalated) {
    parts.push("Wander has stopped reminding — a personal nudge from you may land better now");
  } else if (chase.paused) {
    parts.push("Reminders paused by you");
  } else if (chase.nextDueAt) {
    parts.push(`Next reminder ${formatDay(chase.nextDueAt)}`);
  }
  if (chase.lastFailureReason) {
    parts.push(`Last attempt failed: ${chaseFailureLabel(chase.lastFailureReason)}`);
  }
  return parts.join(" · ");
}

export function TripRoster({ tripId, canManage }: { tripId: number; canManage: boolean }) {
  const [entries, setEntries] = useState<RosterEntryView[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [actingOn, setActingOn] = useState<number | null>(null);
  const [copiedId, setCopiedId] = useState<number | null>(null);
  const [shownLink, setShownLink] = useState<{ entryId: number; url: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await apiFetch<{ roster: RosterEntryView[] }>(`/api/trips/${tripId}/roster`);
      setEntries(data.roster);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Failed to load the roster");
    } finally {
      setLoading(false);
    }
  }, [tripId]);

  useEffect(() => {
    load();
  }, [load]);

  const sendInvites = async () => {
    setSending(true);
    try {
      const summary = await apiJson(`/api/trips/${tripId}/roster/send-invites`, "POST", {}) as SendInvitesSummary;
      const bits: string[] = [];
      if (summary.sent.length > 0) {
        bits.push(`Sent to ${summary.sent.length} traveler${summary.sent.length === 1 ? "" : "s"}`);
      }
      if (summary.needsEmail.length > 0) {
        bits.push(`${summary.needsEmail.length} without an email — use their setup link`);
      }
      if (summary.failed.length > 0) {
        bits.push(`${summary.failed.length} couldn't be sent`);
      }
      if (summary.sent.length > 0) {
        toast.success(bits.join(" · ") || "Invitations sent");
      } else {
        toast.error(bits.join(" · ") || "No invitations were sent");
      }
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Sending invitations failed");
    } finally {
      setSending(false);
    }
  };

  const resend = async (entry: RosterEntryView) => {
    setActingOn(entry.id);
    try {
      const outcome = (await apiJson(`/api/roster-entries/${entry.id}/resend-invite`, "POST", {})) as {
        outcome: string;
        reason?: string;
      };
      if (outcome.outcome === "sent") {
        toast.success(`Invitation resent to ${entry.invitedName}`);
      } else if (outcome.outcome === "no_email") {
        toast.error(`${entry.invitedName} has no email address — share their setup link instead`);
      } else {
        toast.error(`Couldn't resend to ${entry.invitedName}: ${chaseFailureLabel(outcome.reason ?? "unknown")}`);
      }
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Resend failed");
    } finally {
      setActingOn(null);
    }
  };

  const toggleChase = async (entry: RosterEntryView) => {
    setActingOn(entry.id);
    try {
      const view = (await apiJson(`/api/roster-entries/${entry.id}/chase`, "POST", {
        paused: !entry.chase.paused,
      })) as RosterEntryView;
      setEntries((prev) => prev.map((e) => (e.id === view.id ? view : e)));
      toast.success(
        view.chase.paused
          ? `Reminders paused for ${entry.invitedName}`
          : `Reminders resumed for ${entry.invitedName}`,
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Updating reminders failed");
    } finally {
      setActingOn(null);
    }
  };

  const copyLink = async (entry: RosterEntryView) => {
    setActingOn(entry.id);
    try {
      const link = await apiFetch<{ url: string; expiresAt: string }>(
        `/api/roster-entries/${entry.id}/share-link`,
      );
      try {
        await navigator.clipboard.writeText(link.url);
        setCopiedId(entry.id);
        setShownLink(null);
        window.setTimeout(() => setCopiedId((id) => (id === entry.id ? null : id)), 2500);
      } catch {
        // Clipboard unavailable (permissions/insecure context): show the
        // link so the organizer can copy it by hand.
        setShownLink({ entryId: entry.id, url: link.url });
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Getting the setup link failed");
    } finally {
      setActingOn(null);
    }
  };

  const sendable = entries.filter((e) => e.status !== "ready" && e.status !== "declined");

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-xl font-serif font-semibold">
            <Users className="h-5 w-5 text-primary" /> Who's going
          </h2>
          <p className="mt-1 max-w-xl text-sm text-muted-foreground">
            Wander invites each traveler to add their own details, and chases what's
            missing. You see where things stand — never the details themselves.
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            className="min-h-[44px]"
            onClick={() => {
              setLoading(true);
              load();
            }}
            aria-label="Refresh roster"
          >
            <RefreshCw className="h-4 w-4" />
          </Button>
          {canManage && sendable.length > 0 && (
            <Button className="min-h-[44px]" disabled={sending} onClick={sendInvites}>
              {sending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Send className="mr-2 h-4 w-4" />
              )}
              Send invitations ({sendable.length})
            </Button>
          )}
        </div>
      </div>

      {!canManage && (
        <p className="rounded-md bg-muted p-3 text-sm text-muted-foreground">
          Only the trip organizer can send invitations and manage reminders — this is
          the read-only status view.
        </p>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-10">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : loadError ? (
        <p className="rounded-md bg-muted p-3 text-sm text-muted-foreground">{loadError}</p>
      ) : entries.length === 0 ? (
        <div className="rounded-xl border bg-card p-6 text-center">
          <p className="font-medium">No invitations yet</p>
          <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
            When you name who's going — here, or by telling Marco — each traveler
            appears on this list. Wander invites them, keeps their setup status
            current, and reminds them about anything missing, so you don't have to.
          </p>
        </div>
      ) : (
        <ul className="space-y-3">
          {entries.map((entry) => {
            const status = STATUS_DISPLAY[entry.status] ?? {
              label: entry.status.replace(/_/g, " "),
              variant: "outline" as const,
            };
            const actionable =
              canManage &&
              entry.status !== "ready" &&
              entry.status !== "declined";
            const busy = actingOn === entry.id;
            return (
              <li key={entry.id} className="rounded-xl border bg-card p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="flex items-start gap-3">
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/15 text-sm font-bold text-primary">
                      {entry.invitedName.charAt(0).toUpperCase()}
                    </div>
                    <div>
                      <p className="font-medium">{entry.invitedName}</p>
                      <p className="text-sm text-muted-foreground">
                        {entry.invitedEmail ?? "No email on file"}
                      </p>
                    </div>
                  </div>
                  <Badge variant={status.variant} className="shrink-0">
                    {status.label}
                  </Badge>
                </div>

                {entry.missingFields.length > 0 && entry.status !== "declined" && (
                  <p className="mt-3 text-sm">
                    <span className="text-muted-foreground">Still needed: </span>
                    {entry.missingFields.map(requiredFieldLabel).join(", ")}
                  </p>
                )}

                <p className="mt-1.5 text-sm text-muted-foreground">{chaseSummary(entry)}</p>

                {entry.chase.lastFailureReason && (
                  <p className="mt-1.5 flex items-center gap-1.5 text-sm text-destructive">
                    <MailWarning className="h-4 w-4 shrink-0" />
                    The last invitation to this traveler ran into trouble — resending
                    usually fixes it.
                  </p>
                )}

                {actionable && (
                  <div className="mt-3 flex flex-wrap gap-2 border-t pt-3">
                    {entry.invitedEmail && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="min-h-[44px]"
                        disabled={busy}
                        onClick={() => resend(entry)}
                      >
                        {busy ? (
                          <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                        ) : (
                          <Send className="mr-1.5 h-4 w-4" />
                        )}
                        Resend invite
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="outline"
                      className="min-h-[44px]"
                      disabled={busy}
                      onClick={() => toggleChase(entry)}
                    >
                      {entry.chase.paused ? (
                        <Play className="mr-1.5 h-4 w-4" />
                      ) : (
                        <Pause className="mr-1.5 h-4 w-4" />
                      )}
                      {entry.chase.paused ? "Resume reminders" : "Pause reminders"}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="min-h-[44px]"
                      disabled={busy}
                      onClick={() => copyLink(entry)}
                    >
                      {copiedId === entry.id ? (
                        <Check className="mr-1.5 h-4 w-4 text-primary" />
                      ) : (
                        <Link2 className="mr-1.5 h-4 w-4" />
                      )}
                      {copiedId === entry.id ? "Copied" : "Copy setup link"}
                    </Button>
                  </div>
                )}

                {shownLink?.entryId === entry.id && (
                  <div className="mt-3 rounded-md bg-muted p-3">
                    <p className="mb-1.5 text-xs text-muted-foreground">
                      Copy this link and send it to {entry.invitedName} yourself:
                    </p>
                    <code className="block break-all text-xs">{shownLink.url}</code>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
