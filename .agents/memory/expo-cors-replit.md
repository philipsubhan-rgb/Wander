---
name: Expo CORS on Replit
description: Expo dev server runs on *.expo.kirk.replit.dev; API on *.kirk.replit.dev — different origins requiring explicit CORS handling.
---

## Rule
When an Expo artifact makes fetch requests to the API server on Replit, the browser-based web preview runs on `*.expo.kirk.replit.dev` while the API is at `*.kirk.replit.dev`. These are different origins, so CORS must be explicitly configured.

**Why:** `cors({ origin: true })` alone does not reliably reflect the origin for cross-subdomain preflight (OPTIONS) requests in this proxied Replit environment. The proxy may intercept OPTIONS before Express handles it.

**How to apply:** Add a manual CORS middleware *before* the cors package in `artifacts/api-server/src/app.ts` that explicitly sets `Access-Control-Allow-Origin: <reflected>`, `Access-Control-Allow-Credentials: true`, and handles OPTIONS with a 204 early return. See current implementation in `artifacts/api-server/src/app.ts`.

## Auth note
Session cookies work in the Expo *web* preview (browser cookie jar handles them). On native Expo Go (iOS/Android), session cookie persistence is unreliable across requests — a bearer token approach via `setAuthTokenGetter` from `@workspace/api-client-react` + `expo-secure-store` is the correct fix for native.
