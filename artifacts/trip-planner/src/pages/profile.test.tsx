// @vitest-environment jsdom
/**
 * Traveler profile page — the owner's vault surface (Stories 5.1–5.3).
 *
 * Covers: completeness rendering (present vs missing field names),
 * form prefill from the owner's own profile, the access log rendered
 * readably (purpose + field names, never values), and the no-profile
 * state.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import React from "react";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const PROFILE = {
  userId: 5,
  legalFirstName: "Kurt",
  legalMiddleName: null,
  legalLastName: "Rao",
  dateOfBirth: null,
  passportNumber: "X1234567",
  passportIssuingCountry: null,
  passportExpiry: null,
  nationality: null,
  phone: null,
  emergencyContact: null,
  profileVersion: 3,
  createdAt: "2026-11-01T10:00:00.000Z",
  updatedAt: "2026-11-10T10:00:00.000Z",
};

const ACCESS_LOG = [
  {
    id: 1,
    accessorKind: "agent",
    accessorUserId: null,
    purpose: "booking_execution",
    fieldsAccessed: ["passport_number", "date_of_birth"],
    bookingId: 7,
    createdAt: "2026-11-12T15:30:00.000Z",
  },
  {
    id: 2,
    accessorKind: "system",
    accessorUserId: null,
    purpose: "derived_check",
    fieldsAccessed: ["passport_expiry"],
    bookingId: null,
    createdAt: "2026-11-13T09:00:00.000Z",
  },
];

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

function installFetch(profile: unknown) {
  const mock = vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.includes("/access-log")) return jsonResponse(200, { accessLog: ACCESS_LOG });
    if (url.includes("/api/profile/me")) return jsonResponse(200, { profile });
    return jsonResponse(200, {});
  });
  vi.stubGlobal("fetch", mock);
}

import TravelerProfilePage from "@/pages/profile";

describe("TravelerProfilePage", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("renders completeness and names what's missing", async () => {
    installFetch(PROFILE);
    render(<TravelerProfilePage />);

    // 3 of the 10 canonical fields are present in the fixture.
    expect(await screen.findByText(/3 of 10 details in place/)).toBeTruthy();
    expect(screen.getByText(/Still missing:/)).toBeTruthy();
    expect(screen.getByText(/Still missing:.*Date of birth/)).toBeTruthy();
  });

  it("prefills the form from the owner's own profile", async () => {
    installFetch(PROFILE);
    render(<TravelerProfilePage />);
    await screen.findByText(/3 of 10 details in place/);
    const inputs = Array.from(document.querySelectorAll("input")) as HTMLInputElement[];
    expect(inputs.some((i) => i.value === "Kurt")).toBe(true);
    expect(inputs.some((i) => i.value === "Rao")).toBe(true);
    expect(inputs.some((i) => i.value === "X1234567")).toBe(true);
  });

  it("renders the access log readably — purposes and field names", async () => {
    installFetch(PROFILE);
    render(<TravelerProfilePage />);

    expect(await screen.findByText("Supplied details for a booking")).toBeTruthy();
    expect(screen.getByText("Completeness check")).toBeTruthy();
    expect(screen.getByText(/Booking #7/)).toBeTruthy();
    // Field names as chips in the log entries (also present as form /
    // checklist labels — the log adds its own occurrences).
    expect(screen.getAllByText("Passport number").length).toBeGreaterThan(1);
    expect(screen.getAllByText("Passport expiry date").length).toBeGreaterThan(1);
  });

  it("shows the no-profile state", async () => {
    installFetch(null);
    render(<TravelerProfilePage />);
    expect(await screen.findByText(/haven't added your travel details yet/)).toBeTruthy();
    // Every canonical field reads as missing.
    expect(screen.getAllByText("Missing").length).toBe(10);
  });
});
