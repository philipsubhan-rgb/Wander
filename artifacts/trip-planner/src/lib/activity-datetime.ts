import { format, isValid, parseISO } from 'date-fns';

/**
 * Defensive date/time formatting for activity, reservation, and timeline cards.
 *
 * The date/time columns are TEXT, so legacy rows can hold non-ISO dates
 * ("05/12/2027") or 12-hour times ("2:45 PM"). The naive formatters used
 * previously — `format(parseISO(...))` and a manual `split(':')` — throw a
 * RangeError or emit "h:NaN AM/PM" on those shapes, which drops the field
 * (or the whole card) from view even though the value is stored.
 *
 * These helpers never throw and never hide a stored value: unparseable
 * input falls back to the raw string.
 */

export function parseStoredDate(value: string | null | undefined): Date | null {
  if (value == null) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const iso = parseISO(trimmed);
  if (isValid(iso)) return iso;
  const native = new Date(trimmed);
  return isValid(native) ? native : null;
}

/**
 * Format a stored date for card display. Falls back to the raw string when
 * the value isn't parseable, so a stored date is never omitted from a card.
 */
export function formatStoredDate(
  value: string | null | undefined,
  pattern = 'MMM d, yyyy',
): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = parseStoredDate(trimmed);
  return parsed ? format(parsed, pattern) : trimmed;
}

/**
 * Format a stored time as 12-hour ("4:30 PM"). Accepts "HH:MM",
 * "HH:MM:SS", and already-12-hour "h:MM AM/PM" shapes. Unknown shapes are
 * returned raw rather than hidden or mangled into "NaN".
 */
export function formatStoredTime(value: string | null | undefined): string | null {
  if (value == null) return null;
  const t = value.trim();
  if (!t) return null;

  // Already 12-hour: "2:45 PM", "02:45:00 pm", "2:45PM"
  const twelve = t.match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*([AaPp])\.?\s*[Mm]\.?$/);
  if (twelve) {
    const h = Number(twelve[1]);
    if (h >= 1 && h <= 12 && Number(twelve[2]) <= 59) {
      return `${h}:${twelve[2]} ${twelve[3].toUpperCase()}M`;
    }
    return t;
  }

  // 24-hour: "16:30", "9:05", "16:30:00"
  const twentyFour = t.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (twentyFour) {
    const h = Number(twentyFour[1]);
    if (h <= 23 && Number(twentyFour[2]) <= 59) {
      return `${h % 12 || 12}:${twentyFour[2]} ${h >= 12 ? 'PM' : 'AM'}`;
    }
    return t;
  }

  return t;
}
