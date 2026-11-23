/**
 * Phone-first pricing blocks for flight and stay cards.
 *
 * Display only — no controls, nothing hover-gated. The total is the
 * hero figure; fare class / terms (flights) and nightly rate / nights
 * (stays) ride along as context. All values come from
 * lib/pricing-display over fields the API already returns; when a
 * record has no pricing, the block renders nothing.
 */
import { Badge } from "@/components/ui/badge";
import {
  summarizeFlightPricing,
  summarizeStayPricing,
  type FlightPricingInput,
  type StayPricingInput,
} from "@/lib/pricing-display";

export function FlightPricingBlock({ flight }: { flight: FlightPricingInput }) {
  const s = summarizeFlightPricing(flight);
  if (!s.hasPricing) return null;

  return (
    <div className="mt-5 border-t pt-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        {s.total && (
          <div className="shrink-0">
            <p className="text-2xl font-bold tracking-tight">{s.total}</p>
            <p className="text-xs text-muted-foreground">
              {s.totalCaption}
              {s.perPerson && <> · {s.perPerson} per person</>}
            </p>
          </div>
        )}
        {(s.fareBrand || s.terms.length > 0) && (
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
            {s.fareBrand && <Badge variant="secondary">{s.fareBrand}</Badge>}
            {s.terms.length > 0 && (
              <span className="text-sm text-muted-foreground">{s.terms.join(" · ")}</span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export function StayPricingBlock({ stay }: { stay: StayPricingInput }) {
  const s = summarizeStayPricing(stay);
  if (!s.hasPricing) return null;

  return (
    <div className="border-t pt-3">
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-xl font-bold tracking-tight">{s.primary}</p>
        <p className="text-xs text-muted-foreground text-right shrink-0">{s.primaryCaption}</p>
      </div>
      {s.detailLine && <p className="text-sm text-muted-foreground mt-0.5">{s.detailLine}</p>}
    </div>
  );
}
