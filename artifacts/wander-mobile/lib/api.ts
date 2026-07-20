/**
 * Helpers for direct API/storage calls that go outside the generated client.
 */

/** Returns the API base URL (e.g. https://…replit.dev) without a trailing slash. */
export function getBaseUrl(): string {
  const domain = process.env.EXPO_PUBLIC_DOMAIN;
  if (domain) return `https://${domain}`;
  return '';
}
