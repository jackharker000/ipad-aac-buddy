# Parley — AAC Reply Copilot

This file orients Claude Code on the project. Read it first, then `Parley_Approach_and_Options.md` for the full reasoning. The screen tour (`Parley_Screens_Annotated.pdf`) and design brief (`Parley_Design_Brief.pdf`) describe the _prototype_ and pin the locked cockpit UX — rebuild the engine, not the UX.

## What this is

Parley is an iPad-first AAC (Augmentative and Alternative Communication) copilot. The cockpit listens to a conversation, transcribes in real time, identifies who is speaking, and offers tappable, contextually-aware reply suggestions that the user speaks aloud via TTS in a cloned version of their own voice.

The first user is James — a non-verbal man with cerebral palsy and impaired motor control — and his voice, profile, and people are still our north star for what "good" feels like. The app itself is now multi-user: other non-speaking people and their families sign in to their own account and run their own cockpit on their own iPad.

A prototype was built in Lovable but is too slow and unreliable. This is a clean rebuild. The functional design (cockpit layout, mood selector, quick phrases, speaker panel states, helper tabs, settings tabs) is sound and stays as designed. The _engine_ is what changes.

## Hard context (decided, do not relitigate without asking)

- **Multi-user behind a login via Firebase Auth (Google).** Sign-in is client-side Firebase Auth (email/password). Admin is a Firebase custom claim (`admin: true`); the first account created in the project is auto-promoted. Server-side admin ops + the waitlist use the Firebase Admin SDK (a service account, server-only). Speaker-ID still runs on-device; API keys still never live in the client. Conversation data is on-device today; cloud sync to Firebase (Firestore + Storage) is planned/in-progress.
- **Top priority: speaker-ID accuracy.** This is the most-broken part of the prototype (mean-MFCC + cosine was the root cause, not a threshold problem). Fix it first.
- **Latency matters intensely.** The user feels every extra second. Suggestions land within 1–2s of a speaker finishing.
- **The UI layout and feature set are already designed and liked** — see `Parley_Screens_Annotated.pdf` and `Parley_Design_Brief.pdf`. Rebuild the engine, not the cockpit UX. The marketing site and admin dashboard are new surfaces and have their own designs.
- **API keys never live in the iPad client.** They sit behind small server functions / API routes (TanStack Start). Provider switching is a settings change, not a key swap.
- **Vendor-neutral on the AI/audio path.** Drop Lovable Gateway and Lovable Cloud — provider switching (LLM/STT/TTS) is a settings change. Auth, the waitlist, and the admin user list run on Firebase (Auth + Firestore, via the Admin SDK server-side). Cockpit data (conversations, turns, voiceprints, memories) is on-device today; syncing it to Firebase is the planned next step.
- **We pair on this.** Claude writes most code; the human edits, runs, and deploys. Prefer clean, conventional patterns over clever ones.

## Route map

The app is one TanStack Start project with three surfaces. URLs are the source of truth — file paths under `src/routes/` follow the standard file-based-routing convention.

- **Public marketing** (no login): `/`, `/how-it-works`, `/features`, `/story`, `/privacy`, `/get-started`.
- **Auth**: `/login`, `/signup`. (No `/auth/callback` — there is no email confirmation.)
- **App** (login-gated, client-side, by `beforeLoad` in `src/routes/app.tsx`): `/app`, `/app/people`, `/app/events`, `/app/recent`, `/app/helpers`, `/app/settings`, `/app/spike/speaker-id`.
- **Admin** (admin-only, client-side guard in `src/routes/admin.tsx`; server routes re-verify the ID token + admin claim): `/admin`, `/admin/users`, `/admin/users/$userId`, `/admin/usage`. The admin user list comes from Firebase Auth via the Admin SDK (`/api/admin/*`) — a central, cross-device directory.
- **API** (keyed server routes): `/api/llm/*`, `/api/stt/*`, `/api/tts/*`, `/api/embed/*`, `/api/admin/*`, `/api/auth/ensure-role`, `/api/waitlist`. The waitlist persists to Firestore via the Admin SDK when the service account is configured; without it (e.g. local dev) it validates + logs + returns ok without saving.

## Auth model

Authentication runs on **Firebase Auth** (Google). Sign-in is client-side (email/password); admin privilege is a Firebase custom claim verified server-side. Client route guards gate the UI; the admin API routes re-verify the caller's ID token and admin claim with the Admin SDK, so the real trust boundary is the server, not the browser.

- **SessionUser** is the canonical shape:
  ```ts
  type SessionUser = { id: string; email: string | null; is_admin: boolean };
  ```
- **`useSession()`** from `@/lib/auth` is the canonical client-side session reader — it subscribes to Firebase auth state and reads the `admin` custom claim, returning the signed-in `SessionUser` (or `null`) plus a `loading` flag.
- **`signIn` / `signUp` / `signOut` / `getIdToken`** from `@/lib/auth` are the account operations. `signUp` / `signIn` wrap Firebase email/password auth; `signOut` clears the Firebase session; `getIdToken` returns the current user's Firebase ID token for authenticating calls to `/api/admin/*`.
- **First account is admin.** The first account created in the project is auto-promoted to admin — the `/api/auth/ensure-role` server route sets the `admin: true` custom claim via the Admin SDK (the client can't set its own claims), then the client refreshes its ID token so the claim is visible without re-logging-in. Needs the service account configured.
- **Guards are layered.** `beforeLoad` in `src/routes/app.tsx` gates `/app/*` on a session; `beforeLoad` in `src/routes/admin.tsx` gates `/admin/*` on the admin claim. These guard the UI; the admin server routes (`/api/admin/*`, `/api/auth/ensure-role`) independently verify the ID token + admin claim, which is the authoritative check.

## Target architecture

### Frontend

- **React 19 + TanStack Start v1**, Tailwind v4 with the existing Slate & Sun oklch palette.
- **Local-first with Dexie/IndexedDB** for cockpit data — but a **single clean schema**, not the prototype's 9 versions. Add tables (people, voiceprints, conversations, turns, suggestions, suggestions_log, memories, follow_ups, style_profile, james_profile, locations, events, document blobs, settings) as the features that need them land. This data is device-local today; syncing it to Firebase (Firestore + Storage) is the planned next step, not built yet.
- **Local-first PWA wrapped with Capacitor** as a native iPad app. Full-screen, reliable mic, on-device IndexedDB. Hosting is a thin Vercel edge runtime for the keyed API calls and the marketing/auth/admin pages.

### Speaker ID (build this first)

- **Silero VAD** (ONNX) for clean segmentation. Replaces energy-based silence detection.
- **ECAPA-TDNN (or ECAPA2)** exported to ONNX, run via **ONNX Runtime Web + WebGPU**. ~192-dim speaker embeddings, on-device. Replaces the prototype's mean-MFCC + cosine.
- **Enrollment** per known person — multiple short, clean samples captured _in the room the user is in_ (not long studio takes). Centroid = mean of enrolled embeddings.
- **Bayesian context-prior matcher**:
  ```
  posterior(person) ∝ likelihood(voice | person) × prior(person | place, event, recent speakers)
  ```
  Cosine similarity → calibrated likelihood (sharp-temp softmax). Prior boosts people associated with the active location, expected at the active event, or recently heard. An explicit "unknown speaker" candidate keeps mass for new voices.
- **Online assignment** during the conversation drives the Speaker Panel's Unknown / Suggested / Confirmed states.
- **Post-conversation re-clustering** (Tier 2) cleans up labels with full-conversation hindsight. Online seeds; offline corrects.
- **LLM tie-breaker** (`identifySpeakerFromContext`) stays as a fallback when voice + prior are genuinely ambiguous (e.g. siblings with similar voices).

### Audio pipeline

- **AudioWorklet** for mic capture (not the deprecated `ScriptProcessorNode`, which jankes the UI).
- **Web Worker / WebGPU** for VAD + embedding compute so the main thread stays free.
- iPad Safari may force 44.1/48 kHz — resample to 16 kHz before VAD/embedder.

### Suggestions

- **Turn-triggered, not 1.5s polling.** VAD signals turn end → debounce briefly → generate once.
- **Prompt caching on the large persona block** (Anthropic `cache_control: ephemeral`; OpenAI handles repeated prefixes implicitly). Cuts long-prompt latency ~85% and cost ~90%.
- **Retrieve only the relevant memories** (semantic top-K), not the whole user-context bundle.
- **Structured outputs** via tool-use / JSON-mode so suggestions arrive in a guaranteed shape (no free-text parsing).
- **Graceful degradation**: when the AI provider errors or times out, quick phrases + typed-text-to-speech + cached audio still work. The user is never left silent.

### LLMProvider abstraction

One **domain-level** provider interface — methods are app-shaped, not raw chat:

```
generateSuggestions, summarizeConversation, expandUtterance, draftReply,
extractInterests, generateEventPrep, identifySpeakerFromContext,
enrichPersonProfile, detectIntroductions, aiRediarizeTieBreaker
```

Two implementations: **Anthropic** (Claude) and **OpenAI** (GPT). Selectable in Settings. Each call picks the right model tier:

- **Fast model** (Haiku / GPT-mini class) for live suggestions + expand. Latency dominates.
- **Smart model** (Sonnet/Opus / GPT flagship) for summaries, drafts, event prep, profile enrichment. Quality dominates.

API keys live in `process.env` on the server only. Every provider call goes through `/api/*` routes that hold the keys and forward upstream.

### STT

- **ElevenLabs Scribe** to start. Behind an STT provider interface so we can swap.
- Worth a later spike: **Deepgram** (live-streaming latency leader) and **Apple on-device** (once we're inside the Capacitor wrap — zero network, zero per-minute cost).

### TTS

- **ElevenLabs Flash v2.5 over streaming WebSocket** — ~75 ms model latency, plays as it streams. Keeps the user's cloned voice identity (the whole point of the app).
- **Cartesia Sonic 3** behind the same interface as the latency fallback.
- **Pre-synthesise + cache the five quick phrases** ("Yes", "No", "Give me a moment", "Could you repeat that?", "Sorry, who am I speaking with?") as on-device audio — zero network latency on the turns that matter most.
- **Cache TTS output for repeated suggestions** so common replies don't re-synthesise.

## Recommended build order

1. **Clean skeleton** — React/TanStack, single clean schema, LLM/STT/TTS provider interfaces stubbed.
2. **Speaker-ID spike** — VAD + ECAPA on-device + enrollment + context-prior matcher. Validate accuracy in isolation, in the actual room, before wiring the rest. This is the #1 risk.
3. **Live cockpit** — turn-triggered suggestions with prompt caching + structured outputs, streaming Flash TTS with pre-cached quick phrases, AudioWorklet capture, online speaker assignment.
4. **Settings, People, Locations, Events** — rebuilt on the clean schema. Layout unchanged from `Parley_Screens_Annotated.pdf`.
5. **Helpers + Recent** — reuse the provider layer.
6. **Capacitor wrap + edge proxy + on-device backup/export.** Test mic + AudioWorklet + WebGPU on the real device early.

Tier 1 (style-evidence feedback loop), Tier 2 (post-conversation re-diarize + voiceprint rebuild + profile enrichment + introduction detection), and Tier 3 (semantic memory retrieval) all stay as designed in the prototype — they're correct concepts, they just hang off the new engine.

## Reference files in this folder

- `Parley_Approach_and_Options.md` — full rationale for every engine decision above. **Master plan.**
- `Parley_Design_Brief.pdf` — original functional spec from the prototype. Use for _what_ to build (cockpit functions/layout) — ignore the prototype's mean-MFCC / Meyda / Lovable-Gateway tech choices.
- `Parley_Screens_Annotated.pdf` — annotated screen-by-screen UI tour of the cockpit. UX source of truth for `/app/*`.
- `docs/setup.md` — first-time setup, Firebase project + service-account config, admin bootstrap, dev/typecheck/build/deploy.

## Decisions

A running log of choices that closed open questions in the approach doc.

- **21 May 2026 — Capacitor wrap timing — PWA first.** Ship the working web app first; wrap with Capacitor for iPad once the core (speaker-ID + live cockpit) is solid. Test mic + AudioWorklet + WebGPU on the real device as soon as the wrap exists.
- **21 May 2026 — STT — stay on ElevenLabs Scribe.** Revisit Apple on-device only after the Capacitor wrap is in place.
- **21 May 2026 — Backup — encrypted local file export, no cloud backend.** Each user can export their Dexie DB to an encrypted file they save via the Files app / iCloud Drive on their own. No server-side backup.
- **21 May 2026 — Default models.** Provider default is **Claude**. Fast slot = Claude Haiku (live suggestions, expand). Smart slot = Claude Sonnet (summaries, drafts, event prep, profile enrichment). **OpenAI** is the switchable alternative — a mini model in the fast slot, a flagship model in the smart slot. All API keys stay server-side; the client only knows which provider name to send to which `/api/*` route.
- **3 June 2026 — Pivot to multi-user behind a login.** The earlier "single user, no login, local-first only" framing was superseded so Parley can reach more non-speaking people than just James: a real account boundary, a linkable marketing surface, a waitlist, and an admin view. Cockpit data stays local-first (Dexie/IndexedDB), speaker-ID stays on-device, latency-first still wins all ties, and the cockpit UX is unchanged. New surfaces: the public marketing site at `/`, the `/app/*` login-gated cockpit, the `/admin/*` dashboard, and a `/api/waitlist` endpoint. (The original framing of this pivot routed auth and the waitlist through Supabase — see the 3 June entry below, which reversed that.)
- **3 June 2026 — Auth is on-device; no Supabase, no third-party services.** (Superseded later the same day by the Firebase entry below — kept for history.) At the owner's request ("don't have third-party services, build the login myself"), the brief Supabase-auth framing of the pivot above was reversed. Authentication was made fully local: accounts in IndexedDB with PBKDF2-hashed passwords (`src/lib/auth-local.ts`), session in localStorage, client-side route guards, first-account-on-a-device is the admin. What it cost: no central user directory (the admin view saw only the current device's accounts), no cross-device user list, and a waitlist form that didn't persist. What it kept: zero auth config and no auth secrets to manage.
- **3 June 2026 — Adopt Firebase (Auth + Firestore + Storage).** At the owner's request, after trying Supabase and then on-device auth, Parley moves to Google Firebase. Auth is client-side Firebase Auth (email/password); admin is a custom claim, with the first account in the project auto-promoted by `/api/auth/ensure-role`; server-side admin ops + the waitlist use the Firebase Admin SDK (service account in `FIREBASE_SERVICE_ACCOUNT_B64`, server-only). Chosen for what on-device auth couldn't give: a central, cross-device user list, a persisted waitlist, and a path to syncing cockpit data across devices. This replaces and deletes the on-device auth (`src/lib/auth-local.ts` is gone); `@/lib/auth` (Firebase) is canonical. Trade-off recorded: syncing conversation/voiceprint data to Google is the planned **next** step (not built yet), and that move requires the privacy copy to stay truthful — speaker-ID still runs on-device, but account, waitlist, and (future) synced conversation data live in Firebase, so the site must not claim "nothing leaves your device."

## Working agreement

- Don't change the agreed cockpit UX without flagging it. The marketing site and admin dashboard have more design latitude — flag the bigger moves.
- Keep API keys out of client code. Anything prefixed `VITE_` is shipped in the browser bundle and visible to anyone — never put a secret there.
- Cockpit data (conversations, turns, voiceprints, memories) lives on-device (Dexie/IndexedDB) today. Don't wire it to a backend on a whim — Firebase sync for this data is a planned, separately-scoped step; flag it before starting. Accounts and the waitlist do live in Firebase (that's the agreed model).
- Auth is Firebase, and the server (Admin SDK, custom claims) is the trust boundary for admin. Keep the service-account credential server-only (never `VITE_`); don't move admin authorization to a client-only check.
- Keep the privacy/marketing copy truthful as data moves: speaker-ID is on-device, but sign-in and the waitlist are in Firebase, and synced conversation data would be too. Don't reintroduce "nothing leaves your device" claims.
- When in doubt about scope, remember: speaker-ID first, latency always, cockpit data on-device until sync ships.
- Anything _removed_ from the prototype design (MFCC, Lovable, 9-version schema, 1.5s polling, ScriptProcessorNode, `synthesizeSpeech` returning a full base64 MP3) is a deliberate downgrade-then-replace, not a regression. Don't re-add without asking.
