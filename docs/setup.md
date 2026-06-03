# Setup

## First-time setup

```bash
git clone <repo-url>
cd ipad-aac-buddy
bun install
cp .env.example .env
```

Then fill in `.env`: the Firebase web config (see below) and the provider keys you want. See `.env.example` for which vars are server-only (no `VITE_` prefix) and which are public.

## Firebase setup

Authentication, the waitlist store, and (later) cloud data sync all run on Google Firebase. Create a project and wire it up:

1. Create a Firebase project at https://console.firebase.google.com.
2. **Authentication → Sign-in method**: enable **Email/Password**.
3. **Authentication → Settings → Authorized domains**: add your local dev origin (`localhost`) and your Vercel domains (e.g. `parley.vercel.app` and any custom domain). Firebase Auth refuses sign-ins from origins not listed here.
4. **Firestore Database**: create a database in **production mode** (the waitlist is written here via the Admin SDK).
5. **Project Settings → General → Your apps**: register a Web app and copy its config into the `VITE_FIREBASE_*` vars in `.env`. These are public by design — they only identify the project; access is governed by your Firebase security rules.

## Service account (admin features)

Server-side admin operations and the waitlist write use the Firebase **Admin SDK**, which needs a service-account credential:

1. **Project Settings → Service accounts → Generate new private key** — this downloads a JSON file.
2. Base64-encode it: `base64 -i serviceAccount.json`.
3. Set the resulting single-line string as `FIREBASE_SERVICE_ACCOUNT_B64` — locally in `.env` and in the Vercel project env. Do **not** `VITE_`-prefix it; it is a private key and must never reach the browser.

Without the service account, login still works (that's pure client-side Firebase Auth), but the admin **user list** and **waitlist persistence** don't — the waitlist falls back to validating and acknowledging without saving.

## First admin

There is no SQL or manual promotion step. Just sign up via `/signup` — **the first account created in the Firebase project is automatically promoted to admin** (an `admin: true` custom claim, set by the `/api/auth/ensure-role` server route via the Admin SDK). It can then reach `/admin`. This requires the service account to be configured; without it, no account is promoted.

## Dev

```bash
bun run dev
```

The app boots on http://localhost:3000.

## Typecheck

```bash
bun run typecheck
```

## Build

```bash
bun run build
```

## Deploy

Push to the repo's main branch. Vercel auto-detects the TanStack Start project (Nitro under the hood) and builds it. In the Vercel project's environment settings, add:

- the `VITE_FIREBASE_*` client config (public),
- `FIREBASE_SERVICE_ACCOUNT_B64` (secret — enables admin + waitlist persistence),
- the provider keys / model overrides from `.env.example` (LLM/STT/TTS),
- and the optional `PARLEY_ALLOWED_ORIGIN` / `PARLEY_CLIENT_TOKEN` proxy knobs.

Scope each to Production, Preview, and Development as needed.

> **Note:** conversation history and voiceprints currently live on the device (Dexie/IndexedDB). Background sync of that data to Firebase (Firestore + Storage) is planned but **not yet implemented**.
