# CampusPulse learning prototype (Sprint 3)

HxAzzam, CS 4261/8803 Mobile Apps and Services, Fall 2026.

A "near me, soon" map of things happening on Georgia Tech's campus. Official events come from the public Engage feed. Students, staff and officers can post informal things (leftover food, a pickup game) that expire after an hour unless someone confirms them.

- App: https://campuspulse.cfakhir3.workers.dev
- Live test data: https://campuspulse.cfakhir3.workers.dev/stats
- Raw data as CSV: `/api/export/logs.csv`, `checks.csv`, `posts.csv`, `events.csv`, `ingest_runs.csv`

## What it tests

1. Can public Engage data fill the map during the day, or is it empty when students have gaps between classes?
2. Do people tap "Walk there" on what they see?
3. Will anyone post informal events, and who?
4. Do "Still going / It's over" answers keep informal pins accurate?
5. Do people come back on another day without being pushed?

## How it works

- One Cloudflare Worker serves the web app, the API and the stats page.
- A cron trigger runs every 15 minutes. It pulls the next 8 days of approved public events from Engage, drops online and multi-day listings, and places events on the map. Events without a pin are placed with a building table (`src/buildings.js`) that was built from the medians of Engage events that did have pins.
- Data lives in Cloudflare D1 (SQLite). Tables: `events`, `checks`, `logs`, `ingest_runs` (see `migrations/`).
- Informal posts expire after 60 minutes. A "still going" answer pushes the end out 30 minutes. Two "it's over" answers take the pin down.
- After someone taps "Walk there", the next time they open the app (5 minutes to 3 hours later) it asks "Did you make it?" This replaces a push notification, which a web app on iOS cannot rely on.
- Every open, view, filter, save, directions tap, post and check is logged with an anonymous device ID. Test sessions add `?t=P01` (participant code) to the URL so a session can be matched to interview notes. The code `TEST` marks the team's own debugging and is left out of the stats.

## Run it

```
npm install
npx wrangler d1 migrations apply campuspulse-db --local
npx wrangler dev --test-scheduled   # then curl localhost:8787/__scheduled to ingest
npx wrangler deploy
```

## Why a web app instead of the iOS build

Sprint 2 planned a TestFlight build. Cohort feedback pointed out that iOS only would leave out Android testers, and that Render's free tier sleeps after inactivity. A web app runs on both platforms from one link, so recruiting is a QR code instead of TestFlight invites. Jad's SwiftUI prototype (github.com/jmbgat/campusFinder) stays the reference for the native version.
