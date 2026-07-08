# Architecture

Technical map of Parley for contributors. Accuracy over completeness — if a
feature described in an older planning doc isn't actually wired up in the
code, it's called out here as **planned**, not shipped. See `CLAUDE.md` for
the priorities and constraints that should guide any change.

## Live path — data flow

The live cockpit (`src/routes/index.tsx`) drives one conversation end to end:

```
mic (getUserMedia)
  -> AudioContext + ScriptProcessorNode capture      [src/lib/voiceprint.ts]
  -> mean-MFCC feature extraction (Meyda)            [src/lib/voiceprint.ts]
  -> cosine-similarity match against stored           [src/lib/voiceprint.ts:
     per-person voiceprint centroids                    bestMatch, cosineSim]
  -> speaker label attached to transcript segment
  -> ElevenLabs Scribe realtime STT (WebSocket,        [createScribeToken,
     token minted server-side)                          aac.functions.ts]
  -> turn boundary -> generateSuggestions server fn    [aac.functions.ts]
       - builds ConversationContext (people/place/       [src/lib/context.ts]
         event/profile/style/retrieved memories)
       - calls the LLM fallback chain (chatCompletion)  [aac.functions.ts]
  -> tappable suggestion chips rendered in the cockpit
  -> tap -> synthesizeSpeech server fn -> ElevenLabs     [aac.functions.ts]
     TTS (non-streaming REST, eleven_turbo_v2_5) ->
     base64 MP3 played back
```

**Important divergence from the original engine-rebuild plan** (the plan
described in the superseded `Parley_*` docs and the repo's own `CLAUDE.md`
"Target architecture" section): the on-device WavLM/ONNX speaker-embedding
pipeline, Silero VAD, and AudioWorklet capture described there are **not
implemented**. The dependencies (`onnxruntime-web`, `@ricky0123/vad-web`,
`@huggingface/transformers`) are present in `package.json` and excluded from
Vite's dep pre-bundling, but nothing in `src/` imports or calls them today.
Speaker ID currently runs on **mean-MFCC vectors (via Meyda) + cosine
similarity**, and mic capture uses a plain `AudioContext` +
`ScriptProcessorNode` (explicitly chosen over `AudioWorklet` in-code as "deprecated but reliable on iOS Safari"). TTS is a single non-streaming
ElevenLabs REST call, not a streaming WebSocket, and there is no Cartesia
fallback wired in despite a `CARTESIA_API_KEY` slot in `.env.example`.
Per `CLAUDE.md`'s own framing, this stack is the prime suspect for the
speaker-ID and latency problems the project set out to fix — see
`src/routes/spike.speaker-id.tsx`-style measurement work (if present) before
trusting it further.

Key modules for the speaker-ID path:

- **`src/lib/voiceprint.ts`** — `VoiceCapture` class (mic capture + periodic
  MFCC), `computeMfccMean`, `cosineSim`/`discriminativeSim`, `bestMatch`
  (matches a new utterance against stored `Voiceprint` centroids, including
  multi-modal `sub_centroids`), `mergeIntoCentroid` (running-mean centroid
  update, gated by `CENTROID_UPDATE_THRESHOLD`), and
  `rebuildVoiceprintFromContributions` (offline centroid rebuild with a
  drift safety guard).
- **`src/lib/rediarize.ts`** — pure, dependency-free cosine k-means
  (`kmeansRediarize`) used by the post-conversation re-diarization pass to
  re-cluster a whole conversation's utterances against seeded voiceprint
  centroids, flagging ambiguous (close-call) segments for an LLM tie-breaker.
- **`src/lib/speaker-id.ts`** — small helper that relabels raw speaker tags
  (`__james_self__`, diarizer labels) with resolved person names for prompts;
  not a matcher/classifier itself.
- **`src/lib/post-conversation.ts`** — orchestrates the offline pass: reads
  transcript + `segment_mfccs`, calls `kmeansRediarize`, resolves ambiguous
  segments via `aiRediarizeTieBreaker` (an LLM call), writes back
  `TranscriptSegment.person_id`/`confidence` and rebuilds voiceprints.
- **`src/lib/aac.functions.ts`** — server functions, including
  `aiRediarizeTieBreaker`, `identifySpeakerFromContext`, and
  `detectIntroductions`, which give the LLM a role in speaker attribution
  when voice-similarity alone is ambiguous.

There is no separate `matcher.ts` with a `computePrior` Bayesian
place/event/recent-speaker prior in the current tree, despite that being the
plan in `CLAUDE.md`; the live match is voiceprint cosine-similarity only
(`bestMatch`), with LLM context as a fallback/tie-breaker rather than a
calibrated posterior.

## Data model

### Dexie (client-side, `src/lib/db.ts`), database `aac_copilot`

Local-first source of truth during a conversation. One flat, versioned
schema (currently at Dexie schema version 11):

| Table                                                      | Purpose                                                                                                                                                  |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `people`                                                   | Known people: relationship, interests, style notes, auto-enriched topic/dynamic fields, `status` (`live`/`auto` pending-confirm), voiceprint confidence. |
| `places`                                                   | Named locations with lat/lng + radius, used for context priors.                                                                                          |
| `conversations`                                            | One row per session: participants, place, GPS, summary, highlights, `speaker_map` (label → person_id).                                                   |
| `transcript_segments`                                      | Per-utterance text, speaker label/person, confidence, optional semantic `embedding`, and the captured `mfcc` used later for voiceprint learning.         |
| `suggestions_log`                                          | Every suggestion shown: selected/edited/ignored/spoken, timing, feedback, and the context snippet it replied to — feeds the learning loop.               |
| `suggestion_choices`                                       | One record per suggestion _decision_ (chosen vs. alternatives, or "typed own instead") — the compact signal fed back into the suggestion prompt.         |
| `manual_replies`                                           | Replies James typed/composed himself rather than tapping a suggestion.                                                                                   |
| `memories`                                                 | Extracted facts/preferences/events/todos, scoped to a person/place/conversation, with optional semantic embedding for retrieval.                         |
| `follow_ups`                                               | Open follow-up prompts tied to a person or place.                                                                                                        |
| `settings`                                                 | Singleton: voice id, model tier selection (fast/smart per provider), GPS/cloud-sync toggles, suggestion refresh interval.                                |
| `style_profile`                                            | Singleton distilled style profile (openers, signoffs, formality, humor markers, taboo phrases) used to keep suggestions "sounding like him".             |
| `james_profile`                                            | Singleton user profile (background, personality, humor, communication style, current life context).                                                      |
| `james_documents` / `person_documents` / `event_documents` | Extracted text from uploaded documents, scoped globally / per-person / per-event.                                                                        |
| `events`                                                   | Upcoming events with attendees, key info, AI-prepped points/questions.                                                                                   |
| `voiceprints`                                              | Per-person centroid (mean MFCC) + optional `sub_centroids`, sample count, confidence, last-rebuilt time.                                                 |
| `voiceprint_contributions`                                 | Raw per-utterance MFCC samples feeding voiceprint (re)builds, capped and source-tagged (`manual`/`auto`).                                                |
| `style_evidence_cache`                                     | Cached per-person aggregation of suggestion picks/edits so live refreshes don't re-scan the log every tick.                                              |
| `style_distill_runs`                                       | Run log for the style-profile distillation job.                                                                                                          |
| `profile_proposals`                                        | Queue of LLM-proposed profile edits (per person) awaiting user accept/reject.                                                                            |
| `segment_mfccs`                                            | Per-utterance MFCC vectors persisted for the offline re-diarize pass.                                                                                    |

### Supabase (server-side, `supabase/migrations/20260708120000_multi_tenant_core.sql`)

| Table          | Purpose                                                                                                                                                                                                                    | RLS posture                                                                                                                 |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `profiles`     | One row per auth user: email, display name, `role` (`user`/`admin`), last active. Auto-created on signup via trigger; `role` is frozen against self-escalation (only an existing admin or the service role can change it). | Owner can read/update own row; admins can read all.                                                                         |
| `user_backups` | Full JSON snapshot of a user's Dexie tables (see Sync below), keyed by `user_id`.                                                                                                                                          | **Owner-only** — no admin SELECT policy at all. This holds conversation transcripts, so admins are deliberately locked out. |
| `usage_log`    | One row per external API call: function name, provider, model, token/character counts, estimated cost, latency, success/error. Inserted only via the service-role key (no user INSERT policy).                             | Owner can read own rows; admins can read all rows. Powers the `/admin` usage/cost views.                                    |

## Server functions

All server-side logic is TanStack Start `createServerFn` handlers in
`src/lib/*.functions.ts`, layered with middleware:

- **`requireUserOrLocal`** (`src/lib/server/auth-guard.ts`) — wraps every
  function that spends money or touches user data. If Supabase env vars are
  configured, it validates the request's bearer token and 401s anonymous
  calls; if Supabase isn't configured (local dev), it passes through with a
  `null` userId so the app still runs offline. Also seeds an
  `AsyncLocalStorage`-based request context (`src/lib/server/request-context.ts`)
  with the resolved `userId` and function name, so deep call sites (like the
  chat-completion helper) can attribute usage without threading ids through
  every signature.
- **`requireAdmin`** — same bearer-token validation, plus a role check
  (`profiles.role === 'admin'`) OR email membership in the
  `PARLEY_ADMIN_EMAILS` allow-list (bootstraps the first admin before any DB
  role exists). 501s if Supabase isn't configured at all, 403s a
  non-admin user.

### LLM provider fallback chain (`src/lib/aac.functions.ts`)

A single `chatCompletion(model, body)` helper is used by every AI-backed
server function (`generateSuggestions`, `summarizeConversation`,
`expandUtterance`, `draftReply`, `generateEventPrep`, `identifySpeakerFromContext`,
`aiRediarizeTieBreaker`, `enrichPersonProfile`, `detectIntroductions`,
`classifyConversationArc`, `predictMood`, `distillStyleProfile`, etc). All
three providers (Anthropic, OpenAI, Google Gemini) expose an
OpenAI-compatible `/v1/chat/completions` surface, so one call shape works
for all of them.

- **Primary selection:** an explicit `"provider/model"` prefix on the stored
  model id wins (`anthropic/…`, `openai-direct/…`, `gemini/…`); otherwise an
  optional `PARLEY_AI_PROVIDER` env override; otherwise auto-pick.
- **Default order:** **Gemini → Anthropic → OpenAI → Lovable** (legacy
  gateway, kept only if `LOVABLE_API_KEY` is set). Gemini is the default
  primary specifically because its generous free tier means a 429 there
  transparently falls through to Anthropic/OpenAI, so a feature never just
  breaks — it costs a retry.
- **Fallback trigger:** any non-2xx response (not just 429) or a network
  error advances to the next provider in the chain; only the _last_
  provider's failure is surfaced to the caller.
- Every attempt (success or failure, per provider) is logged via `logUsage`
  with token counts and an estimated cost.

Note this differs from `CLAUDE.md`'s stated default ("Claude" as primary,
OpenAI as the switchable alternative) — the shipped default provider is
**Gemini**, with Anthropic/OpenAI as automatic fallbacks, configurable via
`PARLEY_AI_PROVIDER`.

### Usage/cost logging

- **`src/lib/server/usage-log.ts`** — `logUsage()` is fire-and-forget and
  never throws; it writes one row per call to `usage_log` via the
  service-role Supabase client (only path with INSERT rights on that table).
  If `SUPABASE_SERVICE_ROLE_KEY` isn't set, logging is a no-op (warns once).
- **`src/lib/server/pricing.ts`** — `estimateLlmCostUsd` (longest-prefix
  match against a hardcoded per-model $/1M-token rate table for Anthropic/
  OpenAI/Gemini/embeddings) and `estimateTtsCostUsd` (flat per-1k-character
  approximation for ElevenLabs). These are list-price estimates for relative
  spend in the admin dashboard, not invoice-accurate.
- ElevenLabs STT (Scribe) bills per audio-hour; only session _start_ is
  currently logged, not duration — a known gap noted in
  `docs/MULTI_TENANT_SETUP.md`.

## Sync

Local-first: Dexie/IndexedDB is the live source of truth for a conversation
in progress — the UI never blocks on the network. Cross-device sync is
snapshot-based (`src/lib/cloud-sync.ts`):

- On sign-in, `pullForUser(userId)` fetches the user's `user_backups.data`
  JSON blob and bulk-replaces every local Dexie table with it (or, on first
  sign-in with no existing backup, pushes the current local state up).
- After sign-in, Dexie `creating`/`updating`/`deleting` hooks on every synced
  table schedule a debounced (1.5s) full-snapshot push back to
  `user_backups`.
- `flushPush()` forces an immediate push (called before sign-out); `clearLocal()`
  wipes local Dexie on sign-out so the next user starts clean.
- If Supabase isn't configured, sync is a no-op and the app runs purely
  local/anonymous.

**Planned, not yet implemented:** the snapshot currently stores
`user_backups.data` as **plaintext JSON** in Postgres (protected only by RLS

- Postgres at-rest encryption). The documented direction (see
  `docs/MULTI_TENANT_SETUP.md` "Known follow-ups") is client-side AES-GCM
  encryption with a per-device passphrase before upload, so the server only
  ever sees ciphertext — true end-to-end encryption. This is not implemented
  in `cloud-sync.ts` today. Also planned: merging this app into the
  `jackharker000/parley` repo behind an `/app` route (one repo, one domain),
  referenced via `VITE_PARLEY_APP_URL` from the marketing site.

## Security posture

- API keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`,
  `ELEVENLABS_API_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, etc.) are read only from
  server-side `process.env` inside `createServerFn` handlers — never bundled
  to the client. Only `VITE_SUPABASE_URL` / `VITE_SUPABASE_PUBLISHABLE_KEY`
  are intentionally public (Supabase's publishable key is designed to be
  exposed; RLS is the real backstop).
- Every money-spending or user-data server function runs behind
  `requireUserOrLocal`; production deploys with Supabase configured reject
  anonymous calls outright (401).
- Per-user isolation is enforced twice: application-level (server functions
  scope queries to the authenticated `userId`) and database-level (Postgres
  RLS policies on every table — even a leaked publishable key only exposes
  that one user's rows).
- The admin dashboard (`/admin`, `src/lib/admin.functions.ts`, gated by
  `requireAdmin`) is **metrics and cost only** — usage volume, spend, user
  list/roles. It has intentionally no code path to read `user_backups` or
  any conversation transcript; per `CLAUDE.md`, any future transcript-access
  feature must be gated behind explicit per-user consent given that AAC
  users may be vulnerable or minors.
