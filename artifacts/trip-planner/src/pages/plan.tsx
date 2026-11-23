/**
 * "Plan a trip" — the conversational intake entry (Stories 1.1–1.3).
 *
 * No blank form: the page creates a planner intake session
 * (POST /api/agent/intake-sessions) and opens Marco in intake scope.
 * Marco speaks first (design Decision 2): the session view's nextAsk
 * question — for a fresh session, "Ok, where are we going?" — renders
 * as his opening message before the traveler types anything.
 *
 * Resume: /plan?session=<id> reopens an existing session (the
 * dashboard's "Continue planning" cards link here) — the session is
 * loaded, never recreated, and its conversation history fills in.
 *
 * When intake confirms and materializes the draft, the session view
 * reports a draftTripId — the page then swaps the bar to trip scope
 * (the conversation was re-keyed to the trip server-side) so planning
 * continues seamlessly on the real trip.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { Loader2, Sparkles, ArrowRight, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import MarcoBar from "@/components/MarcoBar";
import { apiFetch, apiJson } from "@/lib/api";

interface IntakeSessionView {
  id: number;
  state: string;
  draftTripId: number | null;
  nextAsk: { key: string; slot: string; question: string } | null;
}

/** The ?session=<id> resume target, if the URL carries a valid one. */
function resumeSessionIdFromUrl(): number | null {
  const raw = new URLSearchParams(window.location.search).get("session");
  if (!raw) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export default function PlanTripPage() {
  const [session, setSession] = useState<IntakeSessionView | null>(null);
  const [createFailed, setCreateFailed] = useState(false);
  const [resumeFailed, setResumeFailed] = useState(false);
  const [materializedTripId, setMaterializedTripId] = useState<number | null>(null);
  const creatingRef = useRef(false);
  const loadingRef = useRef(false);
  const [resumeId] = useState<number | null>(() => resumeSessionIdFromUrl());

  const createSession = useCallback(async () => {
    if (creatingRef.current) return;
    creatingRef.current = true;
    setCreateFailed(false);
    try {
      const view = (await apiJson("/api/agent/intake-sessions", "POST", {})) as IntakeSessionView;
      setSession(view);
      if (view.draftTripId) setMaterializedTripId(view.draftTripId);
    } catch {
      setCreateFailed(true);
    } finally {
      creatingRef.current = false;
    }
  }, []);

  const loadSession = useCallback(async (id: number) => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    try {
      const view = await apiFetch<IntakeSessionView>(`/api/agent/intake-sessions/${id}`);
      setSession(view);
      if (view.draftTripId) setMaterializedTripId(view.draftTripId);
    } catch {
      setResumeFailed(true);
    } finally {
      loadingRef.current = false;
    }
  }, []);

  useEffect(() => {
    if (resumeId != null) {
      void loadSession(resumeId);
    } else {
      void createSession();
    }
  }, [resumeId, loadSession, createSession]);

  const startFreshAfterFailedResume = useCallback(() => {
    setResumeFailed(false);
    // Drop the dead ?session= so a reload starts clean too.
    window.history.replaceState(null, "", "/plan");
    void createSession();
  }, [createSession]);

  // After each completed turn, check whether intake materialized a trip.
  // Event-driven (turn completion), not a polling timer.
  const refreshSession = useCallback(async () => {
    if (!session || materializedTripId) return;
    try {
      const view = await apiFetch<IntakeSessionView>(`/api/agent/intake-sessions/${session.id}`);
      setSession(view);
      if (view.draftTripId) setMaterializedTripId(view.draftTripId);
    } catch {
      // A failed refresh just means we check again after the next turn.
    }
  }, [session, materializedTripId]);

  return (
    <div className="mx-auto max-w-3xl space-y-6 px-4 py-6 pb-24 md:px-6 md:py-10 md:pb-10">
      <div className="space-y-2">
        <h1 className="flex items-center gap-2 font-serif text-3xl font-bold md:text-4xl">
          <Sparkles className="h-7 w-7 text-primary" /> Plan a trip
        </h1>
        <p className="text-lg text-muted-foreground">
          No forms, no blank itinerary — Marco runs this conversation. He'll ask
          where you're headed, who's coming, and when, then build the trip as
          you talk.
        </p>
      </div>

      {materializedTripId ? (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-primary/30 bg-primary/5 p-4">
            <div>
              <p className="font-medium">Your trip is on the board</p>
              <p className="text-sm text-muted-foreground">
                Marco turned your answers into a real trip. Keep chatting below to
                shape it, or open it to see everything in one place.
              </p>
            </div>
            <Button asChild className="min-h-[44px]">
              <Link href={`/trips/${materializedTripId}`}>
                View your trip <ArrowRight className="ml-2 h-4 w-4" />
              </Link>
            </Button>
          </div>
          <MarcoBar key={`trip-${materializedTripId}`} tripId={materializedTripId} defaultOpen />
        </div>
      ) : resumeFailed ? (
        <div className="space-y-3 rounded-xl border bg-card p-6 text-center">
          <p className="flex items-center justify-center gap-2 font-medium">
            <AlertTriangle className="h-5 w-5 text-amber-500" /> That planning session couldn't be reopened
          </p>
          <p className="text-sm text-muted-foreground">
            It may already have become a trip, or it belongs to a different
            account. Start a fresh plan and Marco will take it from there.
          </p>
          <Button className="min-h-[44px]" onClick={startFreshAfterFailedResume}>
            Start a new plan
          </Button>
        </div>
      ) : createFailed ? (
        <div className="space-y-3 rounded-xl border bg-card p-6 text-center">
          <p className="flex items-center justify-center gap-2 font-medium">
            <AlertTriangle className="h-5 w-5 text-amber-500" /> Marco couldn't get started
          </p>
          <p className="text-sm text-muted-foreground">
            Starting a planning session hit a snag. It's usually temporary.
          </p>
          <Button className="min-h-[44px]" onClick={() => void createSession()}>
            Try again
          </Button>
        </div>
      ) : !session ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
        </div>
      ) : (
        <MarcoBar
          key={`intake-${session.id}`}
          intakeSessionId={session.id}
          defaultOpen
          onTurnComplete={refreshSession}
          openingMessage={session.nextAsk?.question ?? null}
        />
      )}
    </div>
  );
}
