/**
 * MarcoBar for Wander.
 *
 * Full-width "Ask Marco" entry bar pinned above the KPI cards on the trip
 * Overview tab. Typing a question expands the bar inline into a chat panel
 * (no separate tab) — the conversation stays mounted when minimized so
 * history is preserved.
 *
 * Mounted in: artifacts/trip-planner/src/components/trip/TripOverview.tsx
 */

import { useState, type FormEvent } from "react";
import { Sparkles, Send, ChevronDown, ChevronUp } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import AgentChat from "@/components/AgentChat";
import { AGENT_OPTIONS, getSelectedAgentId } from "@/components/AgentPicker";

interface MarcoBarProps {
  tripId: number;
  /** Trip snapshot (itinerary, reservations) from Drizzle — see README. */
  tripContext?: Record<string, unknown>;
}

export default function MarcoBar({ tripId, tripContext }: MarcoBarProps) {
  const [open, setOpen] = useState(false);
  const [hasOpened, setHasOpened] = useState(false);
  const [seed, setSeed] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  const agentName =
    AGENT_OPTIONS.find((o) => o.id === getSelectedAgentId(tripId))?.name ??
    "Marco";

  const startChat = (e: FormEvent) => {
    e.preventDefault();
    const message = draft.trim();
    if (!message) return;
    setDraft("");
    setSeed(message);
    setHasOpened(true);
    setOpen(true);
  };

  return (
    <>
      {/* Collapsed, never opened: the ask bar */}
      {!open && !hasOpened && (
        <form
          onSubmit={startChat}
          className="flex w-full items-center gap-3 rounded-xl border bg-card px-4 py-3 shadow-sm transition-all focus-within:border-primary/60 focus-within:ring-1 focus-within:ring-primary/30"
        >
          <Sparkles className="h-4 w-4 shrink-0 text-primary" />
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={`Ask ${agentName} anything about this trip…`}
            className="flex-1 border-0 bg-transparent px-0 shadow-none focus-visible:ring-0"
          />
          <Button
            type="submit"
            size="icon"
            disabled={!draft.trim()}
            className="h-8 w-8 shrink-0 rounded-full"
            aria-label={`Ask ${agentName}`}
          >
            <Send className="h-4 w-4" />
          </Button>
        </form>
      )}

      {/* Collapsed, conversation in progress: resume pill */}
      {!open && hasOpened && (
        <button
          onClick={() => setOpen(true)}
          className="flex w-full items-center justify-between rounded-xl border bg-card px-4 py-3 shadow-sm transition-all hover:border-primary/50 hover:bg-primary/5"
        >
          <span className="flex items-center gap-2 text-sm">
            <Sparkles className="h-4 w-4 text-primary" />
            <span className="font-medium">Continue chatting with {agentName}</span>
          </span>
          <ChevronDown className="h-4 w-4 text-muted-foreground" />
        </button>
      )}

      {/* Expanded: inline chat panel. Stays mounted when minimized so the
          conversation (and scroll position) survives collapsing. */}
      {hasOpened && (
        <div
          className={
            open
              ? "w-full overflow-hidden rounded-xl border bg-card shadow-sm"
              : "hidden"
          }
        >
          <div className="flex items-center justify-between border-b px-4 py-2.5">
            <span className="flex items-center gap-2 text-sm font-medium">
              <Sparkles className="h-4 w-4 text-primary" />
              {agentName}
            </span>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={() => setOpen(false)}
              aria-label="Minimize chat"
            >
              <ChevronUp className="h-4 w-4" />
            </Button>
          </div>
          <div className="h-[420px]">
            <AgentChat
              bare
              tripId={tripId}
              tripContext={tripContext}
              initialMessage={seed}
              onInitialMessageConsumed={() => setSeed(null)}
            />
          </div>
        </div>
      )}
    </>
  );
}
