/**
 * Agent identity for Wander — FENCED (design Decision 7, ADR-5 style).
 *
 * This module used to host a radio picker (mounted in TripSettings)
 * that let a traveler switch a trip's chat agent between Marco and the
 * legacy mock "Wander Assistant". Marco is the product's agent now:
 * the picker UI is gone and the selection is pinned —
 * getSelectedAgentId always resolves to Marco, whatever an older
 * client stored in localStorage. Stored values are ignored, not
 * deleted (the fence pattern: the data stays, the traveler's ability
 * to change it goes).
 *
 * AGENT_OPTIONS remains as the id → display-name registry the chat
 * surfaces look Marco up in. The legacy "wander" entry stays because
 * the server still resolves that agent id for old clients — it is
 * simply no longer choosable anywhere in this UI.
 */

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

/** The one agent a traveler can meet in this UI. */
export const MARCO_AGENT_ID = "muse-spark";

export const AGENT_STORAGE_KEY = "wander.selectedAgent";

/**
 * Legacy per-trip storage key. Retained so the fence is explicit —
 * nothing reads or writes these keys anymore.
 */
export function agentStorageKey(tripId?: string | number): string {
  return tripId != null ? `${AGENT_STORAGE_KEY}.trip.${tripId}` : AGENT_STORAGE_KEY;
}

/**
 * The selected agent id — pinned to Marco (Decision 7). The tripId
 * parameter is kept so existing callers don't change shape; it no
 * longer affects the result, and any legacy stored choice is ignored.
 */
export function getSelectedAgentId(_tripId?: string | number): string {
  return MARCO_AGENT_ID;
}
