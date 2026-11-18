/**
 * Minimal JSON fetch helper for the newer surfaces (roster, traveler
 * setup, profile, intake). Settings has its own local copy; this one is
 * shared by the group-layer pages and carries the server's structured
 * error fields (problems / reason) through on the thrown error so pages
 * can render them inline instead of collapsing everything to a toast.
 */

export class ApiError extends Error {
  readonly status: number;
  /** Field-level validation problems (profile/setup submissions). */
  readonly problems?: string[];
  /** Machine reason for token failures: "invalid" | "expired" | "used". */
  readonly reason?: string;

  constructor(
    message: string,
    status: number,
    extra?: { problems?: string[]; reason?: string },
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.problems = extra?.problems;
    this.reason = extra?.reason;
  }
}

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { credentials: "include", ...init });
  const data = (await res.json().catch(() => ({}))) as {
    error?: string;
    problems?: string[];
    reason?: string;
  };
  if (!res.ok) {
    throw new ApiError(data.error || `Request failed (${res.status})`, res.status, {
      problems: data.problems,
      reason: data.reason,
    });
  }
  return data as T;
}

export function apiJson(path: string, method: string, body: unknown) {
  return apiFetch(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
