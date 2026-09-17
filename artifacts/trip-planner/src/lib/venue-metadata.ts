/**
 * Venue metadata lifecycle for the reservation form.
 *
 * Venue suggestions auto-fill fields that belong to the venue (address, url,
 * phone, photo, coordinates). Two bugs this fixes:
 *
 * 1. Editing the venue text by hand left the previous venue's metadata behind
 *    (stale address/url/coordinates/image).
 * 2. Picking a new suggestion only filled phone/url when the fields were
 *    blank, so the old venue's contact details were preserved.
 *
 * Rules:
 * - When the venue text changes away from the last selected/original venue,
 *   venue-specific fields are cleared. address/url/coordinates always go;
 *   phone/imageUrl go only when they still hold the auto-filled value from
 *   the last suggestion — a value the user typed by hand is preserved.
 * - When a suggestion is picked, its metadata replaces the old venue's:
 *   address/coordinates always, phone/url when blank or still holding the
 *   previously auto-filled value (user-typed values survive).
 */

export interface VenueMetadataFields {
  address?: string | null;
  url?: string | null;
  phone?: string | null;
  imageUrl?: string | null;
  lat?: number | null;
  lon?: number | null;
}

export interface VenueSuggestion {
  name: string;
  address: string;
  lat: number;
  lon: number;
  phone?: string | null;
  website?: string | null;
}

export type VenueField = keyof VenueMetadataFields;

/** Updates produced when a venue suggestion is picked. */
export interface VenueSuggestionUpdates {
  address: string;
  lat: number;
  lon: number;
  phone?: string;
  url?: string;
}

const norm = (v: string | null | undefined): string => v ?? '';

/**
 * Fields to clear when the venue text diverges from the last
 * selected/original venue. Pure — the caller applies the clears.
 */
export function venueFieldsToClearOnVenueChange(
  current: VenueMetadataFields,
  autoFilled: VenueMetadataFields | null,
): VenueField[] {
  // address, url and coordinates are intrinsically venue-specific.
  const fields: VenueField[] = ['address', 'url', 'lat', 'lon'];
  if (!autoFilled) {
    fields.push('phone', 'imageUrl');
    return fields;
  }
  // phone/imageUrl are only stale when the user hasn't customized them
  // away from what the last suggestion auto-filled.
  if (norm(current.phone) === norm(autoFilled.phone)) fields.push('phone');
  if (norm(current.imageUrl) === norm(autoFilled.imageUrl)) fields.push('imageUrl');
  return fields;
}

/** A field is safe to overwrite when blank or still holding the auto-filled value. */
function replaceable(current: string | null | undefined, autoFilled: string | null | undefined): boolean {
  const c = norm(current);
  return c === '' || c === norm(autoFilled);
}

/**
 * Computes the form updates when a venue suggestion is picked, plus the new
 * auto-filled snapshot the caller should record. Venue-specific
 * address/coordinates always come from the suggestion; phone/url replace the
 * old venue's values unless the user typed their own.
 */
export function venueUpdatesForSuggestion(
  current: VenueMetadataFields,
  suggestion: VenueSuggestion,
  autoFilled: VenueMetadataFields | null,
): { updates: VenueSuggestionUpdates; autoFilled: VenueMetadataFields } {
  const updates: VenueSuggestionUpdates = {
    address: suggestion.address,
    lat: suggestion.lat,
    lon: suggestion.lon,
  };
  const nextAutoFilled: VenueMetadataFields = {
    address: suggestion.address,
    lat: suggestion.lat,
    lon: suggestion.lon,
    phone: norm(suggestion.phone),
    url: norm(suggestion.website),
  };
  if (replaceable(current.phone, autoFilled?.phone)) {
    updates.phone = norm(suggestion.phone);
  }
  if (replaceable(current.url, autoFilled?.url)) {
    updates.url = norm(suggestion.website);
  }
  return { updates, autoFilled: nextAutoFilled };
}

/**
 * Whether a freshly fetched venue photo may overwrite the current imageUrl:
 * only when the field is blank or still holds the previously auto-filled photo.
 */
export function mayReplaceVenueImage(
  currentImageUrl: string | null | undefined,
  autoFilledImageUrl: string | null | undefined,
): boolean {
  return replaceable(currentImageUrl, autoFilledImageUrl);
}
