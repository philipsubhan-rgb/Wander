/**
 * "Continue planning" — resumable intake drafts on the dashboard
 * (design Decision 2; Story 1.1: abandoning mid-intake leaves a
 * resumable draft, not a dead end).
 *
 * Reads GET /api/agent/intake-sessions — the caller's own started,
 * un-materialized sessions — and renders one card per draft: where the
 * plan stands, the question Marco is waiting on, and a link that
 * resumes the session on /plan (resume loads the session; it never
 * creates a new one). Renders nothing while loading, on error, or
 * when there is nothing to resume — no empty shell on the dashboard.
 */

import { useEffect, useState } from "react";
import { Link } from "wouter";
import { ArrowRight, MessagesSquare } from "lucide-react";
import { format, parseISO } from "date-fns";
import { apiFetch } from "@/lib/api";

export interface ResumableIntake {
  id: number;
  state: string;
  slots: {
    destination?: { value: { kind: string; text: string } } | null;
  };
  nextAsk: { question: string } | null;
  updatedAt: string;
}

const STATE_LABELS: Record<string, string> = {
  DESTINATION: "Choosing a destination",
  PARTY: "Who's going",
  DATES: "Picking dates",
  STYLE: "Kind of trip",
  REVIEW: "Ready for a final look",
};

export function resumableTitle(item: ResumableIntake): string {
  const text = item.slots?.destination?.value?.text?.trim();
  return text ? text : "A trip in the making";
}

export function resumableStateLabel(state: string): string {
  return STATE_LABELS[state] ?? "In progress";
}

export default function ContinuePlanning() {
  const [items, setItems] = useState<ResumableIntake[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiFetch<{ sessions: ResumableIntake[] }>("/api/agent/intake-sessions")
      .then((data) => {
        if (!cancelled) setItems(data.sessions ?? []);
      })
      .catch(() => {
        // A failed read just hides the section — the dashboard still works.
        if (!cancelled) setItems([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!items || items.length === 0) return null;

  return (
    <section className="space-y-4">
      <h2 className="flex items-center gap-2 font-serif text-2xl font-medium">
        <span className="h-2 w-2 rounded-full bg-primary" />
        Continue planning
      </h2>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
        {items.map((item) => (
          <Link
            key={item.id}
            href={`/plan?session=${item.id}`}
            className="group block space-y-2 rounded-2xl border bg-card p-5 shadow-sm transition-all hover:shadow-md"
          >
            <div className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-primary">
              <MessagesSquare className="h-3.5 w-3.5" />
              {resumableStateLabel(item.state)}
            </div>
            <h3 className="font-serif text-xl font-semibold group-hover:text-primary">
              {resumableTitle(item)}
            </h3>
            {item.nextAsk && (
              <p className="text-sm text-muted-foreground">
                Marco's waiting on: “{item.nextAsk.question}”
              </p>
            )}
            <div className="flex items-center justify-between pt-1 text-sm">
              <span className="text-xs text-muted-foreground">
                Last touched {format(parseISO(item.updatedAt), "MMM d, h:mm a")}
              </span>
              <span className="flex items-center gap-1 font-medium text-primary">
                Pick up where you left off
                <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
              </span>
            </div>
          </Link>
        ))}
      </div>
    </section>
  );
}
