# Parley — Approach & Options

*Planning document — reviewed against the Design Brief & the Annotated Screen Tour. Prepared 21 May 2026.*

This is a decision document, not a build. It captures the recommended architecture for the rebuild of Parley, the reasoning behind each choice, and the open decisions still worth making before any code is written.

## The starting point

Three things shape every recommendation below, based on how you've framed the project:

- **One dedicated iPad, one user (James).** This is the single most freeing constraint. It means we can drop most of the multi-tenant complexity in the current design — Supabase accounts, row-level security, cross-device restore — and replace it with something much simpler, faster, and more private. Less moving machinery is also less to break.
- **You and I pair on the build.** I write most of the code; you edit, run, and deploy. That means the codebase needs to be clean and conventional (no exotic patterns), and we should build in a tool designed for sustained codebase work.
- **Speaker-ID accuracy is the thing to fix first.** The brief's current speaker pipeline is, frankly, the weakest part of the design and almost certainly the root cause of the "fails to identify who's speaking" problem. It gets the most attention below.

The good news: the existing brief is thoughtful and the *functional* design (cockpit layout, mood selector, quick phrases, speaker panel states, the three helper tabs, the settings tabs) is sound. You said you're happy with the functions and layout, and nothing here changes them. What changes is the engine underneath.

---

## 1. Speaker identification — the priority fix

### Why the current approach struggles

The brief's pipeline is: extract 20 MFCC coefficients via Meyda, average them across the utterance, and compare with cosine similarity against stored centroids (threshold 0.82, two consecutive matches at ≥0.80).

The problem is the representation, not the threshold. A **mean of 20 MFCCs is a weak speaker signature.** MFCCs encode *what* is being said (phonetic content) at least as much as *who* is saying it, and averaging them over an utterance throws away the very distribution that separates one voice from another. The result is a representation that drifts with microphone distance, room acoustics, background noise, and even which words happen to be spoken — exactly the conditions of a live room. No threshold tuning rescues a representation this fragile. This is why tuning 0.82 vs 0.80 hasn't fixed it.

### What to use instead: neural speaker embeddings

Replace mean-MFCC with a purpose-built **speaker-embedding model** — an ECAPA-TDNN (or the newer ECAPA2) that outputs a ~192-dimensional vector trained specifically to push different speakers apart and pull the same speaker together, regardless of words or noise. This is the standard modern approach to speaker verification and it is dramatically more robust than hand-rolled MFCC means.

Crucially, this now runs **on-device in the browser**. ONNX Runtime Web ships a WebGPU backend that makes models of this size practical client-side, which keeps James's voice data on the iPad (privacy) and avoids a network round-trip per utterance (speed). A SpeechBrain/pyannote ECAPA model exported to ONNX is a known, working path.

### The full on-device pipeline

1. **Voice activity detection (VAD)** with Silero VAD (ONNX) to find clean speech segments. This replaces energy-based silence detection and is the single biggest quality lever after the embedding model — bad segmentation poisons everything downstream.
2. **Embedding extraction** per segment via the ECAPA model on WebGPU.
3. **Enrollment** per known person: record several short, clean samples *in the actual room James uses*, average their embeddings into that person's stored voiceprint. Enrollment quality dominates real-world accuracy; in-situ samples matter more than long ones.
4. **Matching** via cosine similarity in embedding space — but combined with a context prior (next section), not a bare threshold.
5. **Online assignment** during the conversation with an explicit "this is a new/unknown speaker" option, then **post-conversation re-clustering** (your existing Tier 2 idea, kept) to clean up the labels with full-conversation hindsight.

### The location/context prior — your Bayesian idea, formalised

Your instinct here is exactly right and worth building properly. Instead of identifying a speaker from voice alone, combine the voice match with **who is likely to be present**:

> posterior(person) ∝ likelihood(voice embedding | person) × prior(person | place, event, recent speakers)

The prior comes from signals you already capture:

- **Place** — people commonly seen at this location (you already have `suggestPeopleAtPlace`). At Home, Glenis is the dominant prior, so a borderline voice match resolves to her quickly; a voice that *doesn't* match her flips to "unknown / someone else" rather than being forced onto her.
- **Event attendees** — if an event is selected, its attendee list sharply raises those people's priors.
- **Turn-taking** — the person who just spoke is likely to either continue or alternate with one other speaker; recent speakers get a short-term prior boost.

Practically: calibrate cosine similarity into a probability once (a quick one-time fit over James's enrolled speakers), multiply by the context prior, and pick the max — with a confidence score that drives the existing Suggested/Confirmed/Unknown card states. This gives you precisely the behaviour you described: *at home, presume Mum, then validate by fingerprint.*

### Keep the AI fallback

`identifySpeakerFromContext` (LLM reasoning over word choice and references) stays as a tie-breaker when voice + prior are genuinely ambiguous. It's the right tool for "two brothers with similar voices" cases.

---

## 2. Latency — making it feel instant

James feels every extra second, and the current design has three avoidable latency sources.

### Suggestions: stop polling, start reacting

The brief regenerates suggestions **every 1.5 seconds**. That's a cloud LLM call on a timer — wasteful, laggy, and prone to flicker and race conditions. Two changes:

- **Trigger on turn completion**, not a clock. When a speaker finishes (VAD tells us this cleanly), debounce briefly, then generate once. Fewer calls, each more relevant.
- **Shrink the prompt and cache the static part.** The current context object dumps the full James profile plus reference documents (capped at ~60k characters *each*) into every call. That is a latency anchor. Use prompt caching for the large, unchanging persona block — verified to cut long-prompt latency by up to ~85% and cost by ~90% — and use retrieval (you already have `retrieveTopK`) to send only the *relevant* memories, not everything.

With a fast model (Claude Haiku / GPT mini class) plus a cached persona block and turn-triggered generation, suggestions should land well inside your 1–2 second target.

### Text-to-speech: stream it, and switch to a low-latency model

The brief uses ElevenLabs Turbo v2.5 and waits for a full base64 MP3. For the live cockpit, switch to a **streaming, low-latency** path:

- **ElevenLabs Flash v2.5** (~75ms model latency) over WebSocket, playing audio as it streams rather than waiting for the whole clip. (More on whether to keep ElevenLabs at all in §4.)
- **Pre-synthesise and cache the five quick phrases** ("Yes", "No", "Give me a moment"…) as audio on device so they fire with zero network latency — these are the turns where speed matters most.
- Cache TTS output for repeated suggestions.

### The audio pipeline itself

The brief's `VoiceCapture` uses `ScriptProcessorNode`, which is deprecated and runs on the **main thread** — a direct cause of UI jank during recording. Move audio capture to an **AudioWorklet**, and run MFCC/embedding extraction in a **Web Worker** (or WebGPU) so the interface never stutters while listening.

---

## 3. Stability

Beyond latency, a few changes make the app meaningfully harder to break:

- **Structured LLM outputs.** Use tool-use / JSON-mode so `generateSuggestions` returns the 6–9 suggestion objects in a guaranteed shape. Free-text parsing is a common silent-failure source.
- **Simplify the database.** The brief carries a 9-version IndexedDB schema — migration baggage from the prototype. For a single user, start clean with one well-designed schema. Keep Dexie/IndexedDB (it's the right choice for local-first), just without the accumulated versions.
- **Graceful degradation.** If the AI provider is down, the quick phrases, typed-text-to-speech, and cached audio should still work. James should never be left unable to speak because an API timed out.
- **Drop Lovable-specific coupling.** The Lovable AI Gateway and Lovable Cloud tie you to the prototype platform. Going vendor-neutral (your own provider calls, your own backup) removes a class of "it broke and I can't see why" problems and is what makes the Claude/ChatGPT choice in §4 possible.
- **A "style profile distillation failed (AI error 400)" line is visible in your own System screenshot** — a sign the current background pipeline is silently erroring. A clean rebuild with structured outputs and explicit error surfacing addresses this directly.

---

## 4. AI models and the voice stack

### Letting you choose Claude or ChatGPT (and why it's easy)

Build every AI call behind a single **provider interface** — one set of methods (`generateSuggestions`, `summarize`, `expandUtterance`, `draftReply`, …) with two implementations: one for the Anthropic Messages API, one for the OpenAI API. A dropdown in Settings picks the active provider, and you already designed per-task model overrides (fast model vs smart model), which fits this perfectly.

Two important notes:

- **API keys can never live in the iPad client.** They must sit behind a small server function (the TanStack `createServerFn` pattern you already use). This shapes the hosting decision in §6.
- A sensible default: a **fast model** (Haiku / GPT-mini class) with prompt caching for live suggestions, and a **smart model** (Sonnet / GPT-flagship class) for summaries, drafts, and event prep where quality beats speed.

### STT (speech-to-text)

ElevenLabs Scribe is a fine choice and worth keeping for now. Two alternatives worth knowing:

- **Deepgram** — frequently the latency/cost leader for live streaming captions; worth a head-to-head if Scribe ever feels slow.
- **Apple's on-device speech recognition** — *if* we go native (§6), this runs entirely on the iPad with zero network latency and no per-minute cost. For a single device prioritising speed, this is genuinely attractive and worth a spike.

### TTS (text-to-speech)

**Recommendation: keep ElevenLabs**, but switch the live path to Flash v2.5 + streaming. Here's the reasoning: this app's whole premise is that suggestions sound *like James* — a cloned, personal voice. Voice-clone quality and identity are exactly where ElevenLabs is strongest, and that matters more here than shaving the last few milliseconds.

That said, **Cartesia Sonic 3** is the current latency leader (~40–90ms time-to-first-audio, also clones voices, also streams over WebSocket). If, after testing, ElevenLabs Flash still feels too slow on James's connection, Cartesia is the alternative to try — so it's worth putting TTS behind a small provider interface too, the same way as the LLM, so swapping is a config change rather than a rewrite.

---

## 5. Where to build it — Cowork vs Claude Code

You asked which to use and whether you can flip between them. Straight answer:

- **This is a real software project** — a React/TanStack codebase, server functions, ONNX models, a build pipeline, deployment. That is squarely **Claude Code's** domain: it's built for sustained work in a repo, running a dev server, git, tests, and iterating across many files. Since you chose "we pair on it" and are comfortable in a terminal, Claude Code is the right primary tool for the build.
- **Cowork (where we are now)** is best for the planning, research, specs, and one-off assets — like this document. It can write code, but it isn't optimised for living inside a repo day to day.
- **Yes, you can flip between them**, and they can share the same folder on disk. The thing that *doesn't* transfer automatically is context/memory. So the trick is to keep a **`CLAUDE.md` (or this doc) committed in the repo as the shared source of truth** — both tools read it, and you stay coherent across them.

Suggested split: finalise the plan here → build in Claude Code with this folder as the project root → come back to Cowork for research, content, or asset tasks as needed.

---

## 6. Hosting — fast on James's iPad

Given one iPad and a latency priority, here's the spectrum, worst-to-best fit:

- **Plain web app in Safari** — works, but you get browser chrome, less reliable mic/background behaviour, and no app-like feel. Fine for testing, not ideal as the daily tool.
- **Recommended: a local-first PWA wrapped natively with Capacitor.** You keep the single React codebase, but ship it as a real installable iPad app: full-screen, reliable microphone access, AudioWorklet + WebGPU available, the speaker-embedding model bundled in, and the data living on-device in IndexedDB. Only the unavoidable calls (LLM, TTS, STT token) go to the network. This is the sweet spot for "fast on James's iPad."
- **A small cloud proxy for the secret-key calls.** Host the static app + a thin serverless function (Vercel / Cloudflare) that holds the API keys and forwards LLM/TTS/STT requests. Edge hosting keeps that hop short. This is the minimum backend you need given §4's key-safety rule.
- **Optional "home mode" — a tiny local server on a Mac/mini-PC** on the home network holding the keys, with the iPad connecting over LAN. Lowest possible network latency and keys never touch the cloud. Downside: needs the machine on, and doesn't travel outside the house. Worth considering later if home is where James mostly is.

On **fully local / offline**: speaker ID and VAD *should* run fully on-device (and will, per §1). STT *can* be on-device if we go native with Apple's recogniser. The LLM and the cloned-voice TTS realistically stay in the cloud for now — on-device models can't yet match them for this use case on an iPad — so a small always-available proxy is the pragmatic floor.

**Net recommendation:** local-first PWA → Capacitor native wrapper → thin edge proxy for keyed calls → speaker ID & VAD fully on-device. Revisit "home mode" and on-device STT as enhancements.

---

## Recommended build order

A rough sequence that front-loads your priority and de-risks the hard parts early:

1. **Clean project skeleton** in Claude Code — React/TanStack, clean single-version schema, provider interfaces stubbed (LLM + TTS), vendor-neutral.
2. **Speaker-ID spike first** — VAD + ECAPA embeddings on-device, enrollment flow, the context-prior matcher. Prove the accuracy gain in isolation before wiring the rest, since it's the #1 risk and priority.
3. **Live cockpit** — turn-triggered suggestions, prompt caching, streaming TTS with cached quick phrases, AudioWorklet capture.
4. **Settings, People, Locations, Events** — rebuilt on the clean schema (layout unchanged from your screens).
5. **Helpers + Recent** — reuse the same provider layer.
6. **Capacitor wrap + edge proxy + on-device backup/export.**

---

## Open decisions before building

A few things worth deciding (or deferring deliberately):

- **Native wrap now or later?** Capacitor adds setup. We could ship the PWA first and wrap once the core works. Recommend: build PWA-first, wrap early enough to test mic/audio behaviour on the real device.
- **STT: stay on Scribe, or spike Apple on-device?** Only relevant if we go native; worth a short test given your latency priority.
- **Backup strategy for a single user.** Drop Supabase entirely and use simple encrypted file export / iCloud, or keep a minimal cloud backup? Single-user means we can go very light here.
- **Default models.** Which Claude and which OpenAI models to default the fast/smart slots to — easy to change, worth picking sensible starting points.

---

*Sources for the technical claims (on-device speaker embeddings, TTS latency, prompt caching) are listed in the chat message accompanying this document.*
