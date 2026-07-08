# Parley

Parley is an iPad-first AAC (Augmentative and Alternative Communication) reply
copilot. It listens to a live conversation, transcribes it in real time,
identifies who's speaking, and surfaces tappable, contextually-aware reply
suggestions — spoken aloud through a cloned version of the user's own voice.
It was built for **James**, a non-speaking man with cerebral palsy and
impaired motor control, and he remains the flagship user. Parley is now a
multi-tenant, login-gated product at **parley.help**, open to other
non-speaking people and AAC users beyond James.

> See [`CLAUDE.md`](./CLAUDE.md) for the full project constitution — the
> constraints and priorities below are non-negotiable and override any advice
> that conflicts with them: **speaker-ID accuracy first, latency always,
> never regress AI suggestion or transcription quality vs. the original
> build, and prefer deleting/simplifying over adding.**

## Stack

- **Frontend:** React 19 + TanStack Start / TanStack Router, Tailwind 4,
  Radix UI / shadcn components.
- **Local data:** Dexie 4 (IndexedDB) — local-first; the on-device database is
  the source of truth during a live conversation.
- **Auth & backend:** Supabase (Postgres auth + Row-Level Security). Every
  user's rows are isolated at the database layer.
- **STT:** ElevenLabs Scribe (realtime).
- **TTS:** ElevenLabs (`eleven_turbo_v2_5`).
- **LLM:** provider-agnostic chat layer with an automatic fallback chain —
  Gemini (default) → Anthropic (Claude) → OpenAI (GPT), selectable per-tier
  in Settings. A request only fails if every configured provider fails.
- **Build/deploy:** Vite 7 + Nitro 3, deployed to Vercel. Package manager:
  Bun.

## Quickstart

```sh
bun install
cp .env.example .env   # fill in the keys you have; see below
bun run dev
```

Useful scripts (see `package.json`):

| Script                    | What it does                                                        |
| ------------------------- | ------------------------------------------------------------------- |
| `bun run dev`             | Start the Vite dev server                                           |
| `bun run build`           | Production build                                                    |
| `bun run preview`         | Preview a production build locally                                  |
| `bun run typecheck`       | `tsc --noEmit`                                                      |
| `bun run lint`            | ESLint                                                              |
| `bun run format`          | Prettier write                                                      |
| `bun run copy-vad-assets` | Copies VAD model assets into `public/` (also runs on `postinstall`) |

**Environment variables:** copy `.env.example` and fill in what you need.
At minimum you'll want one LLM provider key (`GEMINI_API_KEY` /
`ANTHROPIC_API_KEY` / `OPENAI_API_KEY`) and `ELEVENLABS_API_KEY` for
STT/TTS. Without any Supabase env vars set, a **dev** build runs local-first
and anonymous (no login) so the engine can be hacked on offline; a
**production** build with no Supabase config shows a "not configured" notice
instead of silently running an unauthenticated multi-user deploy. Full
multi-tenant setup (Supabase project, migration, admin bootstrap) is in
[`docs/MULTI_TENANT_SETUP.md`](./docs/MULTI_TENANT_SETUP.md) — this README
doesn't duplicate it.

## Screens

| Route       | Purpose                                                                                                                                         |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `/`         | Live cockpit — mic capture, live transcript, speaker panel, mood selector, quick phrases, and AI reply suggestions for the active conversation. |
| `/recent`   | Browsable history of past conversations (searchable, filterable by person/place).                                                               |
| `/helpers`  | Draft-composition helpers (email, message, Facebook post) built on the same AI provider layer.                                                  |
| `/settings` | Voice, AI model/provider tier selection, people, places, events, James's profile, and account/sign-out.                                         |
| `/admin`    | Metrics-only admin dashboard (see below) — gated to admins.                                                                                     |

## Auth & multi-tenancy

Parley is login-gated: every visitor signs in via Supabase Auth, and every
account's data is isolated both server-side (Postgres Row-Level Security on
`profiles`, `user_backups`, `usage_log`) and client-side (a per-user Dexie
snapshot pulled/pushed on sign-in/every local write). Every external API call
(LLM/STT/TTS) is logged to `usage_log` with an estimated cost, which powers
the admin dashboard. The admin dashboard is **metrics and cost only** —
admins have no access to user conversation transcripts or backups; that is a
deliberate design choice given how sensitive AAC conversation data is.

Full setup instructions (Supabase project, running the migration, environment
variables, bootstrapping the first admin) live in
[`docs/MULTI_TENANT_SETUP.md`](./docs/MULTI_TENANT_SETUP.md).

## Project constitution

[`CLAUDE.md`](./CLAUDE.md) is the source of truth for priorities and hard
constraints on this project. In short: **speaker-ID accuracy is the top
priority**, **latency matters intensely** (suggestions within ~1-2s of a
speaker finishing), **never regress AI suggestion or transcription quality**,
and **prefer simpler over cleverer** — this codebase is considered over-built
relative to what actually works, not under-built. Read it before making
architectural changes.

See also [`ARCHITECTURE.md`](./ARCHITECTURE.md) for a deeper technical map.
