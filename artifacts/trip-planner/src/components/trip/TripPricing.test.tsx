// @vitest-environment jsdom
/**
 * TripPricing blocks — the phone pricing UI for flight and stay cards.
 * Verifies the hero figure is the full price (never a per-night
 * fragment), fare class is visible on flights, and unpriced records
 * render nothing.
 */
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import React from "react";
import { FlightPricingBlock, StayPricingBlock } from "./TripPricing";

afterEach(cleanup);

describe("FlightPricingBlock", () => {
  it("leads with the full total and shows the fare brand", () => {
    render(
      <FlightPricingBlock
        flight={{
          totalPrice: "1286.26",
          currency: "USD",
          passengerCount: 2,
          fareBrand: "Main Cabin",
          refundable: false,
          changeable: true,
          checkedBags: "2 checked bags included",
        }}
      />,
    );
    expect(screen.getByText("$1,286.26")).toBeTruthy();
    expect(screen.getByText(/Total for 2 passengers/)).toBeTruthy();
    expect(screen.getByText(/\$643\.13 per person/)).toBeTruthy();
    expect(screen.getByText("Main Cabin")).toBeTruthy();
    expect(screen.getByText(/Non-refundable · Changeable · 2 checked bags included/)).toBeTruthy();
  });

  it("renders nothing for a flight with no pricing or fare info", () => {
    const { container } = render(<FlightPricingBlock flight={{}} />);
    expect(container.firstChild).toBeNull();
  });

  it("still shows fare class when no price was recorded", () => {
    render(<FlightPricingBlock flight={{ fareBrand: "Economy" }} />);
    expect(screen.getByText("Economy")).toBeTruthy();
  });
});

describe("StayPricingBlock", () => {
  it("leads with the full-stay total, not the nightly fragment", () => {
    render(
      <StayPricingBlock
        stay={{
          nightlyRate: "450.00",
          totalPrice: "2250.00",
          currency: "USD",
          checkIn: "2026-09-24T15:00:00.000Z",
          checkOut: "2026-09-29T11:00:00.000Z",
        }}
      />,
    );
    expect(screen.getByText("$2,250.00")).toBeTruthy();
    expect(screen.getByText("Total for the stay")).toBeTruthy();
    expect(screen.getByText("$450.00 per night · 5 nights")).toBeTruthy();
  });

  it("falls back to the nightly rate when no total was recorded", () => {
    render(
      <StayPricingBlock
        stay={{ nightlyRate: "180.50", currency: "USD", checkIn: "2026-09-24", checkOut: "2026-09-26" }}
      />,
    );
    expect(screen.getByText("$180.50")).toBeTruthy();
    expect(screen.getByText("Per night")).toBeTruthy();
    expect(screen.getByText("2 nights")).toBeTruthy();
  });

  it("renders nothing for a stay with no pricing", () => {
    const { container } = render(
      <StayPricingBlock stay={{ checkIn: "2026-09-24", checkOut: "2026-09-29" }} />,
    );
    expect(container.firstChild).toBeNull();
  });
});
