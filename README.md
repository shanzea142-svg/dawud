# DAWUD — PWA build

Same visual design as before (Apple-inspired, untouched in this pass) —
this update is a functionality/data-model upgrade underneath it:

**1. Calendar day editing.** Tapping any past or today date opens the
same bottom sheet as before, but it now always offers all four actual
states — **Fasted / Missed / Rest / Unrecorded** — regardless of what
was expected that day, so you can correct any day's record freely.
Expected and Actual are always shown separately and are never
conflated.

**2. Export / Import (Settings → Data).** Export writes a
`DAWUD-backup-YYYY-MM-DD.json` file (via the browser's normal download,
nothing is uploaded anywhere). Import validates the file (correct app,
version, well-formed schedule data) before asking you to confirm —
importing fully replaces your current plan and records with the
backup's.

**3. Schedule segments (the biggest change).** The single
`startDate`/`startStatus` plan is now an ordered list of **schedule
segments**. "Change schedule from this date" (from a Calendar day
sheet or Settings → Schedule) adds a new segment starting at a chosen
date/status; the expected pattern before that date is untouched, the
pattern from that date onward recalculates automatically, and your
actual records are never rewritten. Settings → Schedule History lists
every segment and lets you remove a not-yet-elapsed change (the
original plan start can't be removed there — use Reset schedule for
that instead, which replaces the *entire* history with one fresh
segment).

Old data migrates automatically: if a browser only has the previous
single-plan format saved, it's converted into a one-segment array the
first time this version loads — nothing is lost.

```
For the applicable segment covering a date:
  days_since_segment_start even -> expected = segment.startStatus
  days_since_segment_start odd  -> expected = opposite(segment.startStatus)
```

**Verified with Node-based logic tests during this update** (not a
real browser — see the note at the end of this file): the exact
acceptance scenario from the request (19 Sep FASTING start → record
19/20/21 → change schedule from 21 Sep to REST → expected/stats
recalculate correctly while the 21 Sep "Missed" record is preserved),
plus legacy-data migration, backup validation (corrupt/invalid/wrong
version/wrong app all rejected), duplicate/out-of-order segment
handling, and export→import round-tripping.

**Carried over unchanged from the previous pass:** dates before the
plan's very first segment are excluded from the schedule entirely,
statistics never count pre-plan or future dates, and a missed (or
now, schedule-changed) day never rewrites history.

## Why hosting is required (can't just double-click index.html)

Android's "Add to Home screen" only offers the full standalone,
no-address-bar experience — and service workers (needed for offline
support) only register at all — when the site is served over **HTTPS**
(or `http://localhost`). Opening `index.html` directly from a phone's
file system (`file://…`) will not register the service worker and
Chrome will not treat it as an installable app. You need to put these
files on any static HTTPS host first.

## 1. Host the files (pick one, all free)

**Netlify Drop (fastest, no account needed for a quick test)**
1. Go to https://app.netlify.com/drop
2. Drag the whole `dawud-pwa` folder onto the page
3. Netlify gives you an `https://…netlify.app` URL — open that on your Android phone

**GitHub Pages (best for something you'll keep using)**
1. Create a new GitHub repo, upload all files in `dawud-pwa/` to it
2. Repo Settings → Pages → Deploy from branch → `main` / root
3. Open the `https://<username>.github.io/<repo>/` URL it gives you

**Vercel**
1. `npx vercel` from inside the `dawud-pwa` folder (or drag-and-drop on vercel.com)
2. Open the deployment URL

Any other static host (Cloudflare Pages, Firebase Hosting, etc.) works
the same way — there's no build step, just upload the files as-is.

## 2. Install to the Android Home Screen

1. Open the hosted URL in **Chrome** on your Android phone
2. Tap the **⋮** menu (top right)
3. Tap **"Add to Home screen"** (or Chrome may show an **"Install app"**
   banner/button automatically — tap that instead if you see it)
4. Confirm the name **DAWUD** and tap **Add**
5. Open DAWUD from your Home Screen — it launches full-screen, with
   no browser address bar, using the DAWUD icon

## 3. Your data

Your schedule and fasting records are stored in the phone's browser
storage for that site (`localStorage`), scoped to the URL you hosted
it at. That means:
- Closing the app, restarting your phone, or going offline does **not**
  clear your data
- Data stays as long as you don't clear that browser's site data for
  this URL, and doesn't sync across different hosted URLs — so once
  you pick a host in step 1, keep using that same URL
- Nothing is sent to any server — it's 100% local to your phone
- Export Data (Settings) gives you a portable backup file independent
  of any of the above, which Import Data can restore on any host

## Files in this folder

- `index.html` — app shell + manifest/service-worker registration
- `app.js` — all UI + the same expected-vs-actual fasting schedule logic
- `manifest.json` — name "DAWUD", `display: standalone`, icons
- `sw.js` — service worker: caches the app shell for offline use
- `icons/` — 192px, 512px, maskable, and iOS touch icons
