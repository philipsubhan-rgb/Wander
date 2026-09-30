/**
 * Build the create/update payload for the reservation form.
 *
 * Cleared optional fields are sent as explicit `null`, never `undefined`:
 * `undefined` keys are dropped from the JSON body, and the API skips missing
 * keys in PATCH updates (Drizzle ignores `undefined` in `.set()`), so a
 * cleared Website URL would silently keep its old value — e.g. renaming the
 * venue "Orlando's" → "Bayside" cleared the URL field in the form, but the
 * old `https://orlandosrestaurantslu.com/` persisted on save.
 * `null` writes SQL NULL, which every card treats as empty.
 */

export interface ReservationFormValues {
  type?: string;
  title: string;
  venue?: string;
  address?: string;
  date: string;
  time?: string;
  endTime?: string;
  numberOfPeople?: number;
  confirmationCode?: string;
  phone?: string;
  notes?: string;
  url?: string;
  imageUrl?: string;
  lat?: number;
  lon?: number;
}

export function buildReservationPayload<T extends ReservationFormValues>(values: T) {
  return {
    ...values,
    time:               values.time               || null,
    endTime:            values.endTime            || null,
    confirmationCode:   values.confirmationCode   || null,
    phone:              values.phone              || null,
    notes:              values.notes              || null,
    url:                values.url                || null,
    imageUrl:           values.imageUrl           || null,
    venue:              values.venue              || null,
    address:            values.address            || null,
    lat:                values.lat                ?? null,
    lon:                values.lon                ?? null,
  };
}
