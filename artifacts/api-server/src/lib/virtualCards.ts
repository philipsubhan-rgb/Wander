/**
 * Payment-instrument seam for phone bookings (international-foundation
 * §3.4; architecture-north-star §5.6/§6.5).
 *
 * When a supplier on a call needs a card, the agent NEVER reads out
 * the traveler's real card. It reads a single-use virtual card:
 *
 *   · spend limit = the brief's approved total + the brief's stated
 *     tolerance — the confirmation rule is enforced by the payment
 *     instrument itself: the card physically cannot be charged beyond
 *     what the traveler approved;
 *   · single merchant category, short expiry, single use;
 *   · issued at call time by this seam (Stripe Issuing class) and
 *     handed to the live call session only.
 *
 * The details (PAN/CVC) exist ONLY in the value returned by
 * `issueSingleUseCard` — held in memory by the call session for the
 * duration of the call. They are never written to the database (the
 * call task stores only `instrumentRef`), never placed in a
 * transcript, and never logged. The concierge tests sentinel-scan the
 * recorded DB writes and log calls to prove it.
 *
 * No issuer is configured in any environment this build can run in
 * (Stripe Issuing needs Phil's Stripe account + Issuing enablement —
 * Packet #1), so `virtualCardProviderFromEnv` returns null and a call
 * whose brief says payment may be required refuses to dial rather
 * than improvising a payment path.
 */

import type { Money } from "@workspace/money";
import { logger } from "./logger";

// ─── Interface ───────────────────────────────────────────────────────────────

export interface IssueCardInput {
  /** The hard spend limit: brief cap + stated tolerance, money-typed. */
  limit: Money;
  /** Merchant category restriction, when the brief knows it (e.g. "lodging"). */
  merchantCategory?: string | null;
  /** Card lifetime — short by design (the call + a settlement window). */
  expiresInMinutes: number;
  /** Caller-side reference tying the card to the call task. */
  reference: string;
}

export interface IssuedCard {
  /** The ONLY card artifact that may be persisted — an opaque reference. */
  instrumentRef: string;
  /** ⚠ Session-only secrets: returned to the live call session, read
   * to the venue on the call, and then gone. Never persist or log. */
  pan: string;
  expiryMonth: number;
  expiryYear: number;
  cvc: string;
  brand: string;
  limit: Money;
}

export interface PaymentInstrumentProvider {
  readonly id: string;
  issueSingleUseCard(input: IssueCardInput): Promise<IssuedCard>;
}

export class PaymentInstrumentError extends Error {
  constructor(
    readonly provider: string,
    message: string,
  ) {
    super(message);
    this.name = "PaymentInstrumentError";
  }
}

// ─── Env wiring + test seam ──────────────────────────────────────────────────

/**
 * Build the provider from the environment. Stripe Issuing is the
 * designated first issuer (international §3 recommendation), but it
 * requires the Stripe account + Issuing enablement that don't exist
 * yet — until then this returns null and call preparation says so
 * plainly. No fake issuer is substituted: an unconfigured seam must
 * look unconfigured, not simulated.
 */
export function virtualCardProviderFromEnv(
  _env: NodeJS.ProcessEnv = process.env,
): PaymentInstrumentProvider | null {
  return null;
}

let cachedProvider: PaymentInstrumentProvider | null | undefined;
let testProvider: PaymentInstrumentProvider | null | undefined;

/** The process-wide payment-instrument provider (env-built, cached). */
export function getPaymentInstrumentProvider(): PaymentInstrumentProvider | null {
  if (testProvider !== undefined) return testProvider;
  if (cachedProvider === undefined) {
    cachedProvider = virtualCardProviderFromEnv();
    logger.info(
      { provider: cachedProvider?.id ?? null },
      "[VirtualCards] provider resolved",
    );
  }
  return cachedProvider;
}

/** Test seam: replace the provider, or pass undefined to restore env. */
export function setPaymentInstrumentProviderForTests(
  provider: PaymentInstrumentProvider | null | undefined,
): void {
  testProvider = provider;
}
