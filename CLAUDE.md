# Parley — AAC Reply Copilot for James

This file orients Claude Code on the project. Read it first, then `Parley_Approach_and_Options.md` for the full reasoning. The screen tour (`Parley_Screens_Annotated.pdf`) and design brief (`Parley_Design_Brief.pdf`) describe the _prototype_ and pin the locked UX — rebuild the engine, not the UX.

## What this is

Parley is an iPad-first AAC (Augmentative and Alternative Communication) copilot for James, a non-verbal man with cerebral palsy and impaired motor control. It listens to a conversation, transcribes in real time, identifies who is speaking, and offers tappable, contextually-aware reply suggestions that James speaks aloud via TTS in a cloned version of his own voice.

A prototype was built in Lovable but is too slow and unreliable. This is a clean rebuild. The functional design (cockpit layout, mood selector, quick phrases, speaker panel states, helper tabs, settings tabs) is sound and stays as designed. The _engine_ is what changes.

## Hard context (decided, do not relitigate without asking)

- **One dedicated iPad, one user (James).** Single-user. No multi-tenant accounts, no row-level security, no cross-device sync machinery, no Supabase auth. Local-first.
- **Top priority: speaker-ID accuracy.** This is the most-broken part of the prototype (mean-MFCC + cosine was the root cause, not a threshold problem). Fix it first.
- **Latency matters intensely.** James feels every extra second. Suggestions land within 1–2s of a speaker finishing.
- **The UI layout and feature set are already designed and liked** — see `Parley_Screens_Annotated.pdf` and `Parley_Design_Brief.pdf`. Rebuild the engine, not the UX.
- **API keys never live in the iPad client.** They sit behind a small server function (TanStack Start `createServerFn`). Provider switching is a settings change, not a key swap.
- **Vendor-neutral.** Drop Lovable Gateway, Lovable Cloud, and Supabase from the rebuild.
- **We pair on this.** Claude writes most code; the human edits, runs, and deploys. Prefer clean, conventional patterns over clever ones.

## Target architecture

### Frontend

- **React 19 + TanStack Start v1**, Tailwind v4 with the existing Slate & Sun oklch palette.
- **Local-first with Dexie/IndexedDB** — but a **single clean schema**, not the prototype's 9 versions. Add tables (people, voiceprints, conversations, turns, suggestions, suggestions_log, memories, follow_ups, style_profile, james_profile, locations, events, document blobs, settings) as the features that need them land.
- **Local-first PWA wrapped with Capacitor** as a native iPad app. Full-screen, reliable mic, on-device IndexedDB. Hosting is a thin Vercel/Cloudflare edge proxy for the keyed API calls only.

### Speaker ID (build this first)

- **Silero VAD** (ONNX) for clean segmentation. Replaces energy-based silence detection.
- **ECAPA-TDNN (or ECAPA2)** exported to ONNX, run via **ONNX Runtime Web + WebGPU**. ~192-dim speaker embeddings, on-device. Replaces the prototype's mean-MFCC + cosine.
- **Enrollment** per known person — multiple short, clean samples captured _in the room James uses_ (not long studio takes). Centroid = mean of enrolled embeddings.
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
- **Retrieve only the relevant memories** (semantic top-K), not the whole James-context bundle.
- **Structured outputs** via tool-use / JSON-mode so suggestions arrive in a guaranteed shape (no free-text parsing).
- **Graceful degradation**: when the AI provider errors or times out, quick phrases + typed-text-to-speech + cached audio still work. James is never left silent.

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

- **ElevenLabs Flash v2.5 over streaming WebSocket** — ~75 ms model latency, plays as it streams. Keeps James's cloned voice identity (the whole point of the app).
- **Cartesia Sonic 3** behind the same interface as the latency fallback.
- **Pre-synthesise + cache the five quick phrases** ("Yes", "No", "Give me a moment", "Could you repeat that?", "Sorry, who am I speaking with?") as on-device audio — zero network latency on the turns that matter most.
- **Cache TTS output for repeated suggestions** so common replies don't re-synthesise.

## Recommended build order

1. **Clean skeleton** — React/TanStack, single clean schema, LLM/STT/TTS provider interfaces stubbed, vendor-neutral (no Lovable Gateway / Cloud / Supabase / Cloudflare wrangler).
2. **Speaker-ID spike** — VAD + ECAPA on-device + enrollment + context-prior matcher. Validate accuracy in isolation, in the actual room, before wiring the rest. This is the #1 risk.
3. **Live cockpit** — turn-triggered suggestions with prompt caching + structured outputs, streaming Flash TTS with pre-cached quick phrases, AudioWorklet capture, online speaker assignment.
4. **Settings, People, Locations, Events** — rebuilt on the clean schema. Layout unchanged from `Parley_Screens_Annotated.pdf`.
5. **Helpers + Recent** — reuse the provider layer.
6. **Capacitor wrap + edge proxy + on-device backup/export.** Test mic + AudioWorklet + WebGPU on the real device early.

Tier 1 (style-evidence feedback loop), Tier 2 (post-conversation re-diarize + voiceprint rebuild + profile enrichment + introduction detection), and Tier 3 (semantic memory retrieval) all stay as designed in the prototype — they're correct concepts, they just hang off the new engine.

## Reference files in this folder

- `Parley_Approach_and_Options.md` — full rationale for every decision above. **Master plan.**
- `Parley_Design_Brief.pdf` — original functional spec from the prototype. Use for _what_ to build (functions/layout) — ignore the prototype's mean-MFCC / Meyda / Lovable-Gateway / Supabase tech choices.
- `Parley_Screens_Annotated.pdf` — annotated screen-by-screen UI tour. UX source of truth.

## Decisions

These were open in the approach doc; resolved on 21 May 2026:

- **Capacitor wrap timing — PWA first.** Ship the working web app first; wrap with Capacitor for iPad once the core (speaker-ID + live cockpit) is solid. Test mic + AudioWorklet + WebGPU on the real device as soon as the wrap exists.
- **STT — stay on ElevenLabs Scribe.** Revisit Apple on-device only after the Capacitor wrap is in place.
- **Backup — encrypted local file export, no cloud backend.** Single-user means we can export Dexie to an encrypted file the user saves via the Files app / iCloud Drive on their own. No server-side backup.
- **Default models.** Provider default is **Claude**. Fast slot = Claude Haiku (live suggestions, expand). Smart slot = Claude Sonnet (summaries, drafts, event prep, profile enrichment). **OpenAI** is the switchable alternative — a mini model in the fast slot, a flagship model in the smart slot. All API keys stay server-side; the client only knows which provider name to send to which `/api/*` route.

## Working agreement

- Don't change the agreed UX without flagging it.
- Keep API keys out of client code.
- When in doubt about scope, remember: single user, speaker-ID first, latency always.
- Anything _removed_ from the prototype design (MFCC, Lovable, Supabase, 9-version schema, 1.5s polling, ScriptProcessorNode, `synthesizeSpeech` returning a full base64 MP3) is a deliberate downgrade-then-replace, not a regression. Don't re-add without asking.
