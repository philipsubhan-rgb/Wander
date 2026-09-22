/**
 * AgentPicker for Wander.
 *
 * Radio-style picker shown in trip settings so the traveler can choose which
 * agent powers their in-app chat for this trip. Persists to localStorage,
 * namespaced per trip so each trip can have its own agent.
 *
 * Mounted in: artifacts/trip-planner/src/components/trip/TripSettings.tsx
 */

import { useEffect, useState } from "react";

export interface AgentOption {
  id: string;
  name: string;
  description: string;
  /** Optional avatar image shown next to the option. */
  icon?: string;
}

export const AGENT_OPTIONS: AgentOption[] = [
  {
    id: "wander",
    name: "Wander Assistant",
    description: "Wander's built-in trip helper",
  },
  {
    id: "muse-spark",
    name: "Marco",
    description: "Your travel agent, powered by Meta's Muse Spark",
    icon: "/marco-icon.webp",
  },
];

export const AGENT_STORAGE_KEY = "wander.selectedAgent";

/** Storage key for the agent choice; per-trip when a tripId is given. */
export function agentStorageKey(tripId?: string | number): string {
  return tripId != null ? `${AGENT_STORAGE_KEY}.trip.${tripId}` : AGENT_STORAGE_KEY;
}

export function getSelectedAgentId(tripId?: string | number): string {
  try {
    const saved = localStorage.getItem(agentStorageKey(tripId));
    if (saved && AGENT_OPTIONS.some((o) => o.id === saved)) return saved;
  } catch {
    // localStorage unavailable (SSR/tests) — fall through to default
  }
  return AGENT_OPTIONS[0].id;
}

interface AgentPickerProps {
  /** Scope the choice to a trip. When set, the selection is stored per trip. */
  tripId?: string | number;
  /** Called whenever the selection changes. */
  onSelect?: (agentId: string) => void;
}

export default function AgentPicker({ tripId, onSelect }: AgentPickerProps) {
  const [selected, setSelected] = useState<string>(() => getSelectedAgentId(tripId));

  // Keep other tabs/components in sync if they read localStorage directly.
  useEffect(() => {
    try {
      localStorage.setItem(agentStorageKey(tripId), selected);
    } catch {
      // ignore persistence failures
    }
    onSelect?.(selected);
  }, [selected, tripId, onSelect]);

  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium">Choose your travel agent</legend>
      {AGENT_OPTIONS.map((option) => (
        <label
          key={option.id}
          className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors ${
            selected === option.id
              ? "border-primary bg-primary/5"
              : "border-border hover:bg-muted/50"
          }`}
        >
          <input
            type="radio"
            name={`wander-agent${tripId != null ? `-${tripId}` : ""}`}
            value={option.id}
            checked={selected === option.id}
            onChange={() => setSelected(option.id)}
            className="mt-1"
          />
          {option.icon && (
            <img
              src={option.icon}
              alt=""
              className="mt-0.5 h-8 w-8 shrink-0 rounded-full object-cover"
            />
          )}
          <span>
            <span className="block text-sm font-medium">{option.name}</span>
            <span className="block text-xs text-muted-foreground">
              {option.description}
            </span>
          </span>
        </label>
      ))}
    </fieldset>
  );
}
