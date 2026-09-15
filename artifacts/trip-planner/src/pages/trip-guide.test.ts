import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('wouter', () => ({
  Link: ({ href, children, ...props }: { href: string; children: React.ReactNode; [key: string]: unknown }) =>
    React.createElement('a', { href, ...props }, children),
  useParams: () => ({ id: '42' }),
}));

vi.mock('@/lib/wiki-image', () => ({
  fetchWikiImage: vi.fn(async () => null),
}));

vi.mock('@/components/trip/GuideMap', () => ({
  GuideMap: ({ stops }: { stops: Array<{ id: string }> }) =>
    React.createElement('div', {
      'data-testid': 'mock-guide-map',
      'data-stop-count': String(stops.length),
    }),
}));

vi.mock('@workspace/api-client-react', () => {
  const queryKey = (name: string) => (tripId: number) => [name, tripId];
  return {
    getGetTripQueryKey: queryKey('trip'),
    getGetTripTimelineQueryKey: queryKey('timeline'),
    getListAccommodationsQueryKey: queryKey('accommodations'),
    getListActivitiesQueryKey: queryKey('activities'),
    getListCarRentalsQueryKey: queryKey('cars'),
    getListFlightsQueryKey: queryKey('flights'),
    getListReservationsQueryKey: queryKey('reservations'),
    getListTravelDocumentsQueryKey: queryKey('documents'),
    getListTripNotesQueryKey: queryKey('notes'),
    useGetTrip: () => ({
      data: {
        id: 42,
        title: 'Three Days in Paris',
        destination: 'Paris, France',
        startDate: '2026-04-10',
        endDate: '2026-04-12',
        description: 'A long weekend of art, food, and slow walks.',
        coverImage: null,
        status: 'confirmed',
      },
      isLoading: false,
      isError: false,
    }),
    useGetTripTimeline: () => ({
      data: [
        {
          id: 1,
          type: 'itinerary',
          date: '2026-04-10',
          title: 'Left Bank arrival',
          description: 'Settle in and take an evening walk.',
          location: 'Saint-Germain-des-Prés',
          time: '18:00',
        },
        {
          id: 2,
          type: 'activity',
          date: '2026-04-11',
          title: 'Louvre morning',
          description: 'Reserve an early entry.',
          location: 'Louvre Museum',
          time: '09:30',
        },
      ],
    }),
    useListFlights: () => ({
      data: [{
        id: 11,
        airline: 'Air France',
        flightNumber: 'AF 123',
        departureAirport: 'JFK',
        arrivalAirport: 'CDG',
        departureDatetime: '2026-04-10T10:00:00Z',
        arrivalDatetime: '2026-04-10T18:00:00Z',
        direction: 'outbound',
        confirmationCode: 'FLIGHT42',
      }],
    }),
    useListAccommodations: () => ({
      data: [{
        id: 21,
        name: 'Hôtel des Arts',
        address: '15 Rue de Buci, Paris',
        checkIn: '2026-04-10T15:00:00Z',
        checkOut: '2026-04-12T11:00:00Z',
        lat: 48.853,
        lon: 2.335,
        confirmationCode: 'HOTEL42',
      }],
    }),
    useListActivities: () => ({
      data: [{
        id: 31,
        title: 'Montmartre walk',
        description: 'A neighborhood walk above the city.',
        date: '2026-04-11',
        time: '14:00',
        location: 'Montmartre',
        notes: 'Wear comfortable shoes.',
      }],
    }),
    useListCarRentals: () => ({ data: [] }),
    useListReservations: () => ({
      data: [{
        id: 41,
        type: 'restaurant',
        title: 'Dinner at Le Comptoir',
        venue: 'Le Comptoir du Relais',
        address: '9 Carrefour de l’Odéon, Paris',
        date: '2026-04-11',
        time: '20:00',
        confirmationCode: 'DINNER42',
        lat: 48.851,
        lon: 2.338,
      }],
    }),
    useListTripNotes: () => ({
      data: [{
        id: 51,
        title: 'Paris tips',
        content: 'Keep a little cash for neighborhood bakeries.',
        authorName: null,
      }],
    }),
    useListTravelDocuments: () => ({
      data: [{
        id: 61,
        type: 'passport',
        number: '••••4242',
        expiryDate: '2030-12-31',
        notes: 'Check validity before departure.',
      }],
    }),
  };
});

import TripGuide from './trip-guide';

describe('TripGuide authenticated content surface', () => {
  it('renders the fixture trip, print control, itinerary, bookings, notes, documents, and map', () => {
    const html = renderToStaticMarkup(React.createElement(TripGuide));

    expect(html).toContain('Three Days in Paris');
    expect(html).toContain('Print / Save as PDF');
    expect(html).toContain('Left Bank arrival');
    expect(html).toContain('Air France');
    expect(html).toContain('Dinner at Le Comptoir');
    expect(html).toContain('Paris tips');
    expect(html).toContain('Travel documents');
    expect(html).toContain('mock-guide-map');
    expect(html).toContain('Approx. 12 min walk · 5 min drive');
  });

  it('keeps the guide print control and route map addressable for browser tests', () => {
    const html = renderToStaticMarkup(React.createElement(TripGuide));

    expect(html).toContain('data-testid="button-print-guide"');
    expect(html).toContain('data-testid="mock-guide-map"');
    expect(html).toContain('data-stop-count="3"');
  });
});