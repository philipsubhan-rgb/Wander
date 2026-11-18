/**
 * Friendly names for traveler-profile fields and trip-required field
 * names. Everything here is NAMES ONLY — these maps exist so organizer
 * surfaces (the roster) and traveler surfaces (setup form, own profile)
 * can talk about which fields exist without ever touching values.
 *
 * The missing-field labels mirror the API's general-terms labels
 * (outreachLogic FIELD_LABELS): organizers see "your passport details"
 * class language, never a hint of the contents.
 */

/** Canonical vault fields, in the order forms present them. */
export const PROFILE_FIELDS = [
  { name: "legal_first_name", label: "First name", hint: "Exactly as it appears on your passport" },
  { name: "legal_middle_name", label: "Middle name", hint: "If your passport shows one" },
  { name: "legal_last_name", label: "Last name", hint: "Exactly as it appears on your passport" },
  { name: "date_of_birth", label: "Date of birth", hint: "Airlines and hotels ask for it when booking" },
  { name: "passport_number", label: "Passport number", hint: "From the passport you'll travel on" },
  { name: "passport_issuing_country", label: "Passport issuing country", hint: "The country that issued your passport" },
  { name: "passport_expiry", label: "Passport expiry date", hint: "Many destinations require 6+ months left" },
  { name: "nationality", label: "Nationality", hint: "Used to check entry rules for your destinations" },
  { name: "phone", label: "Phone number", hint: "So Wander or a hotel can reach you if plans change" },
  { name: "emergency_contact", label: "Emergency contact", hint: "Someone we can reach in an emergency while you travel" },
] as const;

export type ProfileFieldName = (typeof PROFILE_FIELDS)[number]["name"];

const FIELD_LABEL_BY_NAME: Record<string, string> = Object.fromEntries(
  PROFILE_FIELDS.map((f) => [f.name, f.label]),
);

export function profileFieldLabel(name: string): string {
  return FIELD_LABEL_BY_NAME[name] ?? name.replace(/_/g, " ");
}

/**
 * General-terms label for a trip-required field NAME (the roster and the
 * setup context speak in these names: "passport", "legal_name", …).
 * Mirrors the server's wording so the organizer's roster and the
 * traveler's setup page describe the same missing item the same way.
 */
const REQUIRED_NAME_LABELS: Record<string, string> = {
  passport: "Passport details",
  passport_number: "Passport details",
  passport_details: "Passport details",
  passport_expiry: "Passport expiry date",
  passport_expiration: "Passport expiry date",
  passport_issuing_country: "Passport issuing country",
  date_of_birth: "Date of birth",
  dob: "Date of birth",
  legal_name: "Full legal name",
  full_name: "Full legal name",
  name: "Full legal name",
  phone: "Phone number",
  phone_number: "Phone number",
  emergency_contact: "Emergency contact",
  nationality: "Nationality",
  known_traveler_number: "Known Traveler Number",
  frequent_flyer: "Frequent flyer details",
  frequent_flyer_number: "Frequent flyer details",
};

export function requiredFieldLabel(name: string): string {
  const key = name.trim().toLowerCase();
  return (
    REQUIRED_NAME_LABELS[key] ??
    key.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase())
  );
}

/**
 * Which setup-form fields a trip-required NAME covers, so the form can
 * mark them "Needed for this trip". Required names are loose ("passport"
 * covers the whole passport group), matching the server's aliasing.
 */
const REQUIRED_NAME_TO_FORM_FIELDS: Record<string, string[]> = {
  passport: ["passportNumber", "passportIssuingCountry", "passportExpiry"],
  passport_number: ["passportNumber"],
  passport_details: ["passportNumber", "passportIssuingCountry", "passportExpiry"],
  passport_expiry: ["passportExpiry"],
  passport_expiration: ["passportExpiry"],
  passport_issuing_country: ["passportIssuingCountry"],
  date_of_birth: ["dateOfBirth"],
  dob: ["dateOfBirth"],
  legal_name: ["legalFirstName", "legalLastName"],
  full_name: ["legalFirstName", "legalLastName"],
  name: ["legalFirstName", "legalLastName"],
  phone: ["phone"],
  phone_number: ["phone"],
  emergency_contact: ["emergencyContactName", "emergencyContactPhone"],
  nationality: ["nationality"],
};

export function formFieldsForRequiredNames(requiredNames: readonly string[]): Set<string> {
  const fields = new Set<string>();
  for (const name of requiredNames) {
    for (const f of REQUIRED_NAME_TO_FORM_FIELDS[name.trim().toLowerCase()] ?? []) {
      fields.add(f);
    }
  }
  return fields;
}

/** Plain-language failure reasons for roster chase display. */
export function chaseFailureLabel(reason: string): string {
  switch (reason) {
    case "email_send_failed":
      return "the email could not be sent";
    case "setup_link_unavailable":
      return "the setup link was unavailable";
    default:
      return reason.replace(/_/g, " ");
  }
}
