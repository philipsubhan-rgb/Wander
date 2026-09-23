import { useCallback, useEffect, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { ProtectedRoute } from "@/components/ProtectedRoute";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Loader2, Mail, RefreshCw, Trash2, Check, X, Inbox } from "lucide-react";
import { toast } from "sonner";

interface ConnectedAccount {
  id: number;
  provider: string;
  email: string;
  lastScanAt: string | null;
  createdAt: string;
}

interface ParsedReservation {
  type: string;
  title: string;
  venue?: string;
  date?: string;
  time?: string;
  confirmationCode?: string;
  numberOfPeople?: number;
  price?: string;
  notes?: string;
  confidence: "high" | "medium" | "low";
  source: string;
}

interface Proposal {
  id: number;
  accountId: number | null;
  tripId: number | null;
  subject: string | null;
  sender: string | null;
  parsed: ParsedReservation;
  status: string;
  createdAt: string;
}

interface Trip {
  id: number;
  destination: string;
  startDate: string;
  endDate: string;
}

async function api(path: string, init?: RequestInit) {
  const res = await fetch(path, { credentials: "include", ...init });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return res.json();
}

const CONFIDENCE_LABEL: Record<string, string> = {
  high: "High confidence",
  medium: "Medium confidence",
  low: "Needs review",
};

function AccountsSection() {
  const [accounts, setAccounts] = useState<ConnectedAccount[]>([]);
  const [googleConfigured, setGoogleConfigured] = useState(true);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await api("/api/integrations/accounts");
      setAccounts(data.accounts);
      setGoogleConfigured(data.googleConfigured);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to load accounts");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const params = new URLSearchParams(window.location.search);
    if (params.get("google") === "connected") {
      toast.success("Google account connected");
      window.history.replaceState({}, "", "/settings");
    } else if (params.get("google") === "error") {
      toast.error("Google connection failed — try again");
      window.history.replaceState({}, "", "/settings");
    }
  }, [load]);

  const disconnect = async (id: number) => {
    if (!window.confirm("Disconnect this account? Wander will stop scanning it.")) return;
    try {
      await api(`/api/integrations/accounts/${id}`, { method: "DELETE" });
      toast.success("Account disconnected");
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Disconnect failed");
    }
  };

  const scan = async (id: number) => {
    setScanning(id);
    try {
      const data = await api(`/api/integrations/accounts/${id}/scan`, { method: "POST" });
      toast.success(
        data.proposed > 0
          ? `Found ${data.proposed} booking${data.proposed === 1 ? "" : "s"} — review them below`
          : "Scan complete — no new bookings found",
      );
      load();
      window.dispatchEvent(new CustomEvent("proposals:refresh"));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Scan failed");
    } finally {
      setScanning(null);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Mail className="h-5 w-5" /> Connected email accounts
        </CardTitle>
        <CardDescription>
          Connect your inboxes and Wander will find booking confirmations — flights, hotels,
          restaurants, tours — and propose them for your trips. Nothing is imported without
          your approval.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!googleConfigured && (
          <p className="text-sm text-muted-foreground rounded-md bg-muted p-3">
            Google sign-in isn't configured on this server yet (missing GOOGLE_CLIENT_ID /
            GOOGLE_CLIENT_SECRET and APP_BASE_URL). Ask your Wander admin to set them up.
          </p>
        )}
        {loading ? (
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        ) : accounts.length === 0 ? (
          <p className="text-sm text-muted-foreground">No accounts connected yet.</p>
        ) : (
          <ul className="space-y-2">
            {accounts.map((a) => (
              <li
                key={a.id}
                className="flex items-center justify-between rounded-md border p-3"
              >
                <div>
                  <p className="text-sm font-medium">{a.email}</p>
                  <p className="text-xs text-muted-foreground">
                    {a.lastScanAt
                      ? `Last scanned ${new Date(a.lastScanAt).toLocaleString()}`
                      : "Never scanned"}
                  </p>
                </div>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={scanning === a.id}
                    onClick={() => scan(a.id)}
                  >
                    {scanning === a.id ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <RefreshCw className="h-4 w-4" />
                    )}
                    <span className="ml-1">Scan now</span>
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => disconnect(a.id)}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
        {googleConfigured && (
          <Button asChild>
            <a href="/api/integrations/google/connect?returnTo=/settings">
              Connect a Google account
            </a>
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

function ProposalsSection() {
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [trips, setTrips] = useState<Trip[]>([]);
  const [loading, setLoading] = useState(true);
  const [tripPick, setTripPick] = useState<Record<number, string>>({});
  const [acting, setActing] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const [p, t] = await Promise.all([
        api("/api/proposals?status=pending"),
        api("/api/trips"),
      ]);
      setProposals(p.proposals);
      setTrips(t);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to load proposals");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const refresh = () => load();
    window.addEventListener("proposals:refresh", refresh);
    return () => window.removeEventListener("proposals:refresh", refresh);
  }, [load]);

  const accept = async (p: Proposal) => {
    const tripId = p.tripId ?? Number(tripPick[p.id]);
    if (!tripId) {
      toast.error("Pick a trip for this reservation first");
      return;
    }
    setActing(p.id);
    try {
      await api(`/api/proposals/${p.id}/accept`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tripId }),
      });
      toast.success("Added to your trip");
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Accept failed");
    } finally {
      setActing(null);
    }
  };

  const reject = async (p: Proposal) => {
    setActing(p.id);
    try {
      await api(`/api/proposals/${p.id}/reject`, { method: "POST" });
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Reject failed");
    } finally {
      setActing(null);
    }
  };

  const tripName = (id: number | null) =>
    trips.find((t) => t.id === id)?.destination ?? "No trip matched";

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Inbox className="h-5 w-5" /> Booking inbox
          {proposals.length > 0 && <Badge variant="secondary">{proposals.length}</Badge>}
        </CardTitle>
        <CardDescription>
          Reservations Wander found in your email. Accept the ones you want on a trip —
          the rest are ignored.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {loading ? (
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        ) : proposals.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nothing waiting. Connect an account above and run a scan.
          </p>
        ) : (
          <ul className="space-y-3">
            {proposals.map((p) => (
              <li key={p.id} className="rounded-md border p-4 space-y-2">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="text-sm font-medium">{p.parsed.title}</p>
                    <p className="text-xs text-muted-foreground">
                      {[p.parsed.date, p.parsed.time].filter(Boolean).join(" · ")}
                      {p.parsed.confirmationCode && ` · ${p.parsed.confirmationCode}`}
                      {p.parsed.numberOfPeople && ` · party of ${p.parsed.numberOfPeople}`}
                    </p>
                    {p.parsed.notes && (
                      <p className="text-xs text-muted-foreground mt-1 line-clamp-2">
                        {p.parsed.notes}
                      </p>
                    )}
                  </div>
                  <Badge
                    variant={p.parsed.confidence === "high" ? "default" : "outline"}
                    className="shrink-0"
                  >
                    {CONFIDENCE_LABEL[p.parsed.confidence]}
                  </Badge>
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                  {p.tripId ? (
                    <span className="text-xs text-muted-foreground">
                      → {tripName(p.tripId)}
                    </span>
                  ) : (
                    <Select
                      value={tripPick[p.id] ?? ""}
                      onValueChange={(v) => setTripPick((s) => ({ ...s, [p.id]: v }))}
                    >
                      <SelectTrigger className="w-48 h-8 text-xs">
                        <SelectValue placeholder="Pick a trip…" />
                      </SelectTrigger>
                      <SelectContent>
                        {trips.map((t) => (
                          <SelectItem key={t.id} value={String(t.id)}>
                            {t.destination} ({t.startDate} → {t.endDate})
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                  <div className="flex-1" />
                  <Button
                    size="sm"
                    disabled={acting === p.id}
                    onClick={() => accept(p)}
                  >
                    <Check className="h-4 w-4 mr-1" /> Accept
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={acting === p.id}
                    onClick={() => reject(p)}
                  >
                    <X className="h-4 w-4 mr-1" /> Dismiss
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

export default function SettingsPage() {
  return (
    <ProtectedRoute>
      <AppShell>
        <div className="max-w-3xl mx-auto p-4 md:p-6 space-y-6">
          <h1 className="text-2xl font-bold">Settings</h1>
          <AccountsSection />
          <ProposalsSection />
        </div>
      </AppShell>
    </ProtectedRoute>
  );
}
