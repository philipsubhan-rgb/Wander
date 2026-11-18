/**
 * "Plan a trip" — the conversational intake entry (Stories 1.1–1.3).
 *
 * No blank form: the page creates a planner intake session
 * (POST /api/agent/intake-sessions) and opens Marco in intake scope.
 * The traveler says where they want to go; Marco asks the rest, one
 * question at a time. When intake confirms and materializes the draft,
 * the session view reports a draftTripId — the page then swaps the bar
 * to trip scope (the conversation was re-keyed to the trip server-side)
 * so planning continues seamlessly on the real trip.
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
}

export default function PlanTripPage() {
  const [session, setSession] = useState<IntakeSessionView | null>(null);
  const [createFailed, setCreateFailed] = useState(false);
  const [materializedTripId, setMaterializedTripId] = useState<number | null>(null);
  const creatingRef = useRef(false);

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

  useEffect(() => {
    void createSession();
  }, [createSession]);

  // After each completed turn, check whether intake materialized a trip.
  // Event-driven (turn completion), not a polling timer.
  const refreshSession = useCallback(async () => {
    if (!session || materializedTripId) return;
    try {
      const view = await apiFetch<IntakeSessionView>(`/api/agent/intake-sessions/${session.id}`);
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
          No forms, no blank itinerary. Tell Marco where you want to go — he'll ask
          who's coming, when, and what kind of trip, and build it as you talk.
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
        />
      )}
    </div>
  );
}
