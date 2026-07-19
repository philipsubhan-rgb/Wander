---
name: Email-based trip participant lookup
description: Trip participants are added via email lookup, not a dropdown of all users. Email is required and unique on the users table.
---

## The rule
- `users.email` is `NOT NULL UNIQUE` in the DB.
- `GET /users/lookup?email=` finds a user by email and returns their `otherTripsCount` (trips they're on). Uses `requireAuth` (not `requireAdmin`) so trip admins can use it.
- `TripSettings` uses an email input → fetch `/api/users/lookup?email=` directly (not via generated hook) → if found and on other trips, shows a confirmation dialog before `POST /trips/:tripId/participants`.
- `GET /users` (list all users) remains admin-only.
- The admin "New Traveler" form requires email (no longer optional).

**Why:** Users should be found by email to prevent accidentally adding the wrong person from a name-only dropdown. The confirmation dialog is shown when the target user is on other trips (proving they exist in the system and are real travelers).
