import { useEffect, useMemo, useRef, useState } from "react";
import { Link, createFileRoute } from "@tanstack/react-router";

import {
  AdminApiError,
  fetchAdminConversation,
  fetchUser,
  playAudioFromAdminUrl,
  relativeTime,
  stopAdminAudio,
} from "@/lib/admin";
import type { AdminConversationBundle } from "@/lib/admin";

/**
 * Admin → user → conversation viewer. The central debugging surface for
 * speaker-ID and suggestion-quality work: reconstructs who said what during
 * a single conversation, what suggestions Parley offered after each turn,
 * which were tapped, and which voiceprint contributions were captured.
 *
 * Deep-linkable from the activity log, the Conversations table on the user
 * page, the command palette — anywhere that can name a (uid, conversationId).
 */

export const Route = createFileRoute("/admin/users/$userId/conversations/$conversationId")({
  component: AdminConversationPage,
});

function AdminConversationPage() {
  const { userId, conversationId } = Route.useParams();
  const [bundle, setBundle] = useState<AdminConversationBundle | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<AdminApiError | null>(null);
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setBundle(null);
    fetchAdminConversation(userId, conversationId, reloadKey > 0 ? { force: true } : undefined)
      .then((data) => {
        if (!cancelled) setBundle(data);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(
            err instanceof AdminApiError
              ? err
              : new AdminApiError(0, "Couldn't load this conversation."),
          );
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [userId, conversationId, reloadKey]);

  // Best-effort fetch of the user's email for the back-link label. The
  // fetchUser cache deduplicates between the user-detail page and this one,
  // so this is usually free.
  useEffect(() => {
    let cancelled = false;
    fetchUser(userId)
      .then((u) => {
        if (!cancelled && u) setUserEmail(u.email);
      })
      .catch(() => {
        // best-effort; back-link falls back to a generic label
      });
    return () => {
      cancelled = true;
    };
  }, [userId]);

  // Stop any in-flight audio playback when navigating away.
  useEffect(() => {
    return () => {
      stopAdminAudio();
    };
  }, []);

  const backLabel = userEmail ? `← Back to ${userEmail}'s profile` : "← Back to user profile";

  return (
    <div className="mx-auto max-w-screen-2xl px-5 py-5">
      <Link
        to="/admin/users/$userId"
        params={{ userId }}
        className="text-sm font-medium text-[var(--teal-dark)] hover:underline"
      >
        {backLabel}
      </Link>

      {loading ? (
        <LoadingSkeleton />
      ) : error || !bundle ? (
        <NotFoundCard error={error} onReload={() => setReloadKey((k) => k + 1)} />
      ) : (
        <ConversationView bundle={bundle} />
      )}
    </div>
  );
}

function LoadingSkeleton() {
  return (
    <div className="mt-6 space-y-4">
      <div className="h-32 rounded-2xl bg-[var(--sand-2)]/60 animate-pulse" />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_18rem]">
        <div className="space-y-2">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="h-16 rounded-xl bg-[var(--sand-2)]/60 animate-pulse" />
          ))}
        </div>
        <div className="h-64 rounded-2xl bg-[var(--sand-2)]/60 animate-pulse" />
      </div>
    </div>
  );
}

function NotFoundCard({ error, onReload }: { error: AdminApiError | null; onReload: () => void }) {
  const is503 = error?.status === 503;
  const is404 = error?.status === 404 || !error;
  return (
    <div className="mt-6 rounded-2xl border border-[var(--line)] bg-white p-6">
      <h2 className="text-base font-semibold">
        {is503
          ? "Admin features aren't configured yet"
          : is404
            ? "Conversation not found"
            : "Couldn't load this conversation"}
      </h2>
      <p className="mt-2 text-sm text-[var(--ink-soft)]">
        {is503
          ? error?.message
          : is404
            ? "Maybe this conversation hasn't synced yet. Cloud sync is write-behind, so a freshly-ended call can take a moment to land in Firestore."
            : (error?.message ?? "Something went wrong.")}
      </p>
      <button
        type="button"
        onClick={onReload}
        className="mt-4 inline-flex items-center rounded-md border border-[var(--line)] bg-white px-3 py-1.5 text-sm font-medium hover:bg-[var(--sand-2)]"
      >
        Reload
      </button>
    </div>
  );
}

// --------------------------------------------------------------------------
// Main rendered view — header card + timeline + sidebar
// --------------------------------------------------------------------------

type ResolvedPerson = {
  id: string;
  name: string;
  colorIndex: number;
};

function ConversationView({ bundle }: { bundle: AdminConversationBundle }) {
  const { conversation, segments, suggestions, contributions, people } = bundle;

  const peopleById = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of people) {
      const id = readString(p.id);
      const name = readString(p.name);
      if (id && name) map.set(id, name);
    }
    return map;
  }, [people]);

  const voiceSampleCountsByPerson = useMemo(() => {
    // Count voiceprint contributions captured *during this conversation* per
    // person. The endpoint scopes voiceprintContributions to this
    // conversationId, so this is "samples added by this call" — exactly what
    // the operator needs when judging whether the speaker-ID matcher had
    // enough recent voice evidence to make a confident match.
    const counts = new Map<string, number>();
    for (const c of contributions) {
      const personId = readString(c.personId);
      if (personId) counts.set(personId, (counts.get(personId) ?? 0) + 1);
    }
    return counts;
  }, [contributions]);

  // Stable color assignment per person, deterministic by sorted order so the
  // same person always gets the same dot color across re-renders.
  const personColorByName = useMemo(() => {
    const distinctNames = new Set<string>();
    for (const s of segments) {
      const personId = readString(s.personId);
      const personName = personId ? (peopleById.get(personId) ?? null) : null;
      const label = readString(s.speakerLabel);
      const display = personName ?? label ?? "Unknown";
      distinctNames.add(display);
    }
    const sorted = Array.from(distinctNames).sort();
    const map = new Map<string, number>();
    sorted.forEach((name, i) => map.set(name, i));
    return map;
  }, [segments, peopleById]);

  // Group suggestions under their triggering segment id for the sidebar.
  const suggestionsByTrigger = useMemo(() => {
    const map = new Map<string, Array<Record<string, unknown>>>();
    for (const s of suggestions) {
      const trig = readString(s.triggeringSegmentId);
      if (!trig) continue;
      const list = map.get(trig);
      if (list) list.push(s);
      else map.set(trig, [s]);
    }
    return map;
  }, [suggestions]);

  // Unique resolved person entries for the right-sidebar people list.
  const peopleInConversation = useMemo<ResolvedPerson[]>(() => {
    const seen = new Set<string>();
    const out: ResolvedPerson[] = [];
    for (const s of segments) {
      const personId = readString(s.personId);
      const personName = personId ? (peopleById.get(personId) ?? null) : null;
      const label = readString(s.speakerLabel);
      const display = personName ?? label ?? "Unknown";
      const key = personId ?? `label:${display}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        id: personId ?? display,
        name: display,
        colorIndex: personColorByName.get(display) ?? 0,
      });
    }
    return out;
  }, [segments, peopleById, personColorByName]);

  const startedAt = toMillis(conversation.startedAt);
  const endedAt = toMillis(conversation.endedAt);

  const durationLabel = useMemo(() => {
    if (startedAt == null) return null;
    const end = endedAt ?? Date.now();
    const seconds = Math.max(0, Math.round((end - startedAt) / 1000));
    return formatDuration(seconds);
  }, [startedAt, endedAt]);

  const placeId = readString(conversation.placeId);
  const eventId = readString(conversation.eventId);
  // The endpoint doesn't bundle places/events, so we surface their ids when
  // present and a friendly fallback when absent. Resolving these to names
  // would need a second fetch — kept simple here; the user-detail page is
  // one click away for that.
  const summary = readString(conversation.summary);
  const personIds: string[] = Array.isArray(conversation.personIds)
    ? conversation.personIds.filter((x): x is string => typeof x === "string")
    : [];
  const participants = personIds
    .map((id) => peopleById.get(id) ?? null)
    .filter((n): n is string => Boolean(n));

  return (
    <div className="mt-6 space-y-6">
      <HeaderCard
        startedAt={startedAt}
        endedAt={endedAt}
        durationLabel={durationLabel}
        placeId={placeId}
        eventId={eventId}
        participants={participants}
        summary={summary}
      />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_18rem]">
        <Timeline
          segments={segments}
          conversationStartedAt={startedAt}
          peopleById={peopleById}
          personColorByName={personColorByName}
          suggestionsByTrigger={suggestionsByTrigger}
        />
        <PeopleSidebar
          people={peopleInConversation}
          personColorByName={personColorByName}
          voiceSampleCountsByPerson={voiceSampleCountsByPerson}
          contributions={contributions}
          peopleById={peopleById}
        />
      </div>
    </div>
  );
}

function HeaderCard({
  startedAt,
  endedAt,
  durationLabel,
  placeId,
  eventId,
  participants,
  summary,
}: {
  startedAt: number | null;
  endedAt: number | null;
  durationLabel: string | null;
  placeId: string | null;
  eventId: string | null;
  participants: string[];
  summary: string | null;
}) {
  const title = startedAt
    ? `Conversation on ${relativeTime(new Date(startedAt))}${durationLabel ? ` · ${durationLabel}` : ""}`
    : "Conversation";

  const visibleParticipants = participants.slice(0, 5);
  const overflowCount = Math.max(0, participants.length - visibleParticipants.length);

  return (
    <div className="rounded-2xl border border-[var(--line)] bg-white p-6">
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>

      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-sm text-[var(--ink-soft)]">
        <span>{placeId ? `Place ${placeId}` : "No place"}</span>
        <span>·</span>
        <span>{eventId ? `Event ${eventId}` : "No event"}</span>
        <span>·</span>
        <span>
          {participants.length === 0 ? (
            "No confirmed participants"
          ) : (
            <>
              {visibleParticipants.join(", ")}
              {overflowCount > 0 ? ` + ${overflowCount} more` : ""}
            </>
          )}
        </span>
      </div>

      <div className="mt-3 grid grid-cols-1 gap-2 text-xs text-[var(--ink-soft)] sm:grid-cols-2">
        <div>
          <span className="font-medium text-[var(--ink)]">Started: </span>
          {startedAt ? fmtDateTime(new Date(startedAt).toISOString()) : "—"}
        </div>
        <div>
          <span className="font-medium text-[var(--ink)]">Ended: </span>
          {endedAt ? fmtDateTime(new Date(endedAt).toISOString()) : "Still in progress"}
        </div>
      </div>

      {summary ? (
        <blockquote className="mt-4 border-l-2 border-[var(--teal)] bg-[var(--sand-2)]/40 p-3 text-sm italic text-[var(--ink-soft)]">
          {summary}
        </blockquote>
      ) : null}
    </div>
  );
}

// --------------------------------------------------------------------------
// Timeline — vertical list of transcript segments + nested suggestion panels
// --------------------------------------------------------------------------

function Timeline({
  segments,
  conversationStartedAt,
  peopleById,
  personColorByName,
  suggestionsByTrigger,
}: {
  segments: Array<Record<string, unknown>>;
  conversationStartedAt: number | null;
  peopleById: Map<string, string>;
  personColorByName: Map<string, number>;
  suggestionsByTrigger: Map<string, Array<Record<string, unknown>>>;
}) {
  if (segments.length === 0) {
    return (
      <div className="rounded-2xl border border-[var(--line)] bg-white p-6">
        <p className="text-sm text-[var(--ink-soft)]">
          No transcript segments synced for this conversation yet.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-[var(--line)] bg-white">
      <ul className="divide-y divide-[var(--line)]">
        {segments.map((seg, i) => (
          <li key={readString(seg.id) ?? i}>
            <SegmentRow
              segment={seg}
              conversationStartedAt={conversationStartedAt}
              peopleById={peopleById}
              personColorByName={personColorByName}
            />
            <SuggestionsForSegment
              segmentId={readString(seg.id)}
              suggestionsByTrigger={suggestionsByTrigger}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}

function SegmentRow({
  segment,
  conversationStartedAt,
  peopleById,
  personColorByName,
}: {
  segment: Record<string, unknown>;
  conversationStartedAt: number | null;
  peopleById: Map<string, string>;
  personColorByName: Map<string, number>;
}) {
  const personId = readString(segment.personId);
  const personName = personId ? (peopleById.get(personId) ?? null) : null;
  const label = readString(segment.speakerLabel);
  const speakerKind = readString(segment.speakerKind);
  const isSelf = speakerKind === "self";
  const displayName = personName ?? label ?? "Unknown";
  const knownPerson = Boolean(personName);
  const colorIndex = personColorByName.get(displayName) ?? 0;
  const text = readString(segment.text);
  const status = readString(segment.status);
  const isPartial = status === "partial";
  const confidence = readNumber(segment.confidence);

  const startedAt = toMillis(segment.startedAt);
  const relTimeLabel =
    startedAt != null && conversationStartedAt != null
      ? formatRelativeOffset(startedAt - conversationStartedAt)
      : null;

  return (
    <div className="grid grid-cols-[10rem_1fr_5rem] gap-4 px-4 py-3">
      <div className="flex items-start gap-2 pt-0.5">
        <span
          className="mt-1 inline-block h-2.5 w-2.5 shrink-0 rounded-full"
          style={{ backgroundColor: speakerColor(colorIndex) }}
          aria-hidden="true"
        />
        <div className="min-w-0">
          <span
            className={
              knownPerson || isSelf
                ? "block truncate text-sm font-medium text-[var(--ink)]"
                : "block truncate text-sm font-medium text-[var(--ink-soft)]"
            }
            title={displayName}
          >
            {displayName}
          </span>
          {isSelf ? (
            <span className="mt-0.5 inline-flex items-center rounded-full bg-[var(--teal)]/10 px-1.5 py-0.5 text-[10px] font-semibold text-[var(--teal-dark)]">
              Me
            </span>
          ) : null}
        </div>
      </div>

      <div className="min-w-0">
        <p className="text-base leading-relaxed text-[var(--ink)] break-words">
          {text ?? <span className="text-[var(--ink-soft)]">[empty]</span>}
        </p>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          {isPartial ? (
            <span className="inline-flex items-center rounded-full bg-[var(--amber)]/20 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--ink)]">
              partial
            </span>
          ) : null}
        </div>
      </div>

      <div className="flex flex-col items-end gap-1 text-right text-xs text-[var(--ink-soft)]">
        {relTimeLabel ? <span className="tabular-nums">{relTimeLabel}</span> : null}
        {confidence != null ? (
          <span
            className="inline-flex items-center rounded-full bg-[var(--sand-2)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--ink-soft)]"
            title="Posterior probability that the speaker is the matched person."
          >
            {confidence.toFixed(2)}
          </span>
        ) : null}
      </div>
    </div>
  );
}

function SuggestionsForSegment({
  segmentId,
  suggestionsByTrigger,
}: {
  segmentId: string | null;
  suggestionsByTrigger: Map<string, Array<Record<string, unknown>>>;
}) {
  if (!segmentId) return null;
  const list = suggestionsByTrigger.get(segmentId);
  if (!list || list.length === 0) return null;

  return (
    <div className="px-4 pb-4 pl-[10.5rem]">
      <div className="rounded-xl border border-[var(--line)] bg-[var(--sand)]/40 p-3">
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--ink-soft)]">
          Suggestions after this turn ({list.length})
        </p>
        <ul className="flex flex-col gap-2">
          {list.map((s, i) => (
            <SuggestionChip key={readString(s.id) ?? i} suggestion={s} />
          ))}
        </ul>
      </div>
    </div>
  );
}

function SuggestionChip({ suggestion }: { suggestion: Record<string, unknown> }) {
  const text = readString(suggestion.text);
  const category = readString(suggestion.category);
  const selected = typeof suggestion.selected === "boolean" ? suggestion.selected : false;
  const ignored = typeof suggestion.ignored === "boolean" ? suggestion.ignored : false;
  const editedTo = readString(suggestion.editedTo);
  const displacedAt = toMillis(suggestion.displacedAt);

  const wrapperCls = selected
    ? "rounded-lg border border-[var(--teal)]/30 bg-[var(--teal)]/10 p-2.5"
    : "rounded-lg border border-[var(--line)] bg-[var(--sand-2)]/60 p-2.5";

  return (
    <li className={wrapperCls}>
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="text-sm text-[var(--ink)]">{text ?? "—"}</span>
        {category ? (
          <span className="inline-flex items-center rounded-full bg-white px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--ink-soft)] ring-1 ring-[var(--line)]">
            {category}
          </span>
        ) : null}
        {selected ? (
          <span className="inline-flex items-center rounded-full bg-[var(--teal)]/20 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--teal-dark)]">
            Tapped
          </span>
        ) : null}
        {ignored ? (
          <span className="inline-flex items-center rounded-full bg-[var(--sand-2)] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--ink-soft)]">
            Ignored
          </span>
        ) : null}
        {displacedAt != null ? (
          <span className="inline-flex items-center rounded-full bg-[var(--sand-2)] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--ink-soft)]">
            Replaced
          </span>
        ) : null}
      </div>
      {editedTo ? (
        <p className="mt-1 text-xs italic text-[var(--ink-soft)]">
          Edited to: <span className="text-[var(--ink)] not-italic">{editedTo}</span>
        </p>
      ) : null}
    </li>
  );
}

// --------------------------------------------------------------------------
// Sidebar — people in this conversation + their voice contributions
// --------------------------------------------------------------------------

function PeopleSidebar({
  people,
  personColorByName,
  voiceSampleCountsByPerson,
  contributions,
  peopleById,
}: {
  people: ResolvedPerson[];
  personColorByName: Map<string, number>;
  voiceSampleCountsByPerson: Map<string, number>;
  contributions: Array<Record<string, unknown>>;
  peopleById: Map<string, string>;
}) {
  return (
    <aside className="space-y-4 lg:sticky lg:top-20 lg:self-start">
      <div className="rounded-2xl border border-[var(--line)] bg-white p-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-[var(--ink-soft)]">
          People in this conversation
        </h2>
        {people.length === 0 ? (
          <p className="mt-3 text-sm text-[var(--ink-soft)]">No speakers identified.</p>
        ) : (
          <ul className="mt-3 flex flex-col gap-2">
            {people.map((p) => {
              const sampleCount = voiceSampleCountsByPerson.get(p.id) ?? 0;
              return (
                <li key={p.id} className="flex items-center justify-between gap-2 text-sm">
                  <span className="flex items-center gap-2 min-w-0">
                    <span
                      className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
                      style={{
                        backgroundColor: speakerColor(
                          personColorByName.get(p.name) ?? p.colorIndex,
                        ),
                      }}
                      aria-hidden="true"
                    />
                    <span className="truncate text-[var(--ink)]">{p.name}</span>
                  </span>
                  <span className="shrink-0 text-xs text-[var(--ink-soft)]">
                    {sampleCount} sample{sampleCount === 1 ? "" : "s"}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <ContributionsPanel contributions={contributions} peopleById={peopleById} />
    </aside>
  );
}

function ContributionsPanel({
  contributions,
  peopleById,
}: {
  contributions: Array<Record<string, unknown>>;
  peopleById: Map<string, string>;
}) {
  return (
    <div className="rounded-2xl border border-[var(--line)] bg-white p-4">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-[var(--ink-soft)]">
        Voiceprint contributions ({contributions.length})
      </h2>
      <p className="mt-1 text-xs text-[var(--ink-soft)]">
        Audio captured during this conversation that fed the speaker-ID model.
      </p>
      {contributions.length === 0 ? (
        <p className="mt-3 text-sm text-[var(--ink-soft)]">
          No contributions tied to this conversation yet.
        </p>
      ) : (
        <ul className="mt-3 flex flex-col divide-y divide-[var(--line)]">
          {contributions.map((c, i) => (
            <ContributionRow key={readString(c.id) ?? i} contribution={c} peopleById={peopleById} />
          ))}
        </ul>
      )}
    </div>
  );
}

function ContributionRow({
  contribution,
  peopleById,
}: {
  contribution: Record<string, unknown>;
  peopleById: Map<string, string>;
}) {
  const personId = readString(contribution.personId);
  const personName = personId ? (peopleById.get(personId) ?? null) : null;
  const source = readString(contribution.source);
  const duration = readNumber(contribution.durationSec);
  const previewText = readString(contribution.previewText);
  const audio = readAudioRef(contribution);

  return (
    <li className="py-2.5 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="text-sm font-medium text-[var(--ink)]">
          {personName ?? personId ?? "Unknown person"}
        </span>
        {source ? <SourceBadge source={source} /> : null}
      </div>
      <div className="mt-0.5 text-[11px] text-[var(--ink-soft)]">
        {duration != null ? `${duration.toFixed(1)}s` : ""}
        {audio ? ` · ${fmtBytes(audio.sizeBytes)}` : ""}
      </div>
      {previewText ? (
        <p className="mt-1 truncate text-xs italic text-[var(--ink-soft)]">"{previewText}"</p>
      ) : null}
      {audio?.storagePath ? (
        <div className="mt-2">
          <ListenButton storagePath={audio.storagePath} durationSec={duration} />
        </div>
      ) : null}
    </li>
  );
}

function SourceBadge({ source }: { source: string }) {
  const palette: Record<string, string> = {
    enrollment: "bg-[#3b82f6]/10 text-[#1d4ed8]",
    conversation: "bg-[var(--sand-2)] text-[var(--ink-soft)]",
    rediarize: "bg-[var(--teal)]/10 text-[var(--teal-dark)]",
  };
  const cls = palette[source] ?? "bg-[var(--sand-2)] text-[var(--ink-soft)]";
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${cls}`}
    >
      {source}
    </span>
  );
}

// --------------------------------------------------------------------------
// Listen button — reuses the shared `playAudioFromAdminUrl` helper from
// src/lib/admin.ts, so triggering one clip pauses any other. Mirrors the
// listener in users.$userId.tsx but trimmed for the sidebar's narrow width.
// --------------------------------------------------------------------------

function ListenButton({
  storagePath,
  durationSec,
}: {
  storagePath: string;
  durationSec: number | null;
}) {
  const [state, setState] = useState<"idle" | "loading" | "playing" | "error">("idle");
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState<number>(durationSec ?? 0);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    return () => {
      audioRef.current?.pause();
      audioRef.current = null;
    };
  }, []);

  async function onClick() {
    if (state === "playing") {
      audioRef.current?.pause();
      audioRef.current = null;
      setState("idle");
      return;
    }
    setState("loading");
    try {
      const audio = await playAudioFromAdminUrl(storagePath);
      audioRef.current = audio;
      setState("playing");
      setPosition(audio.currentTime || 0);
      if (Number.isFinite(audio.duration) && audio.duration > 0) {
        setDuration(audio.duration);
      }
      const onTime = () => {
        if (audioRef.current === audio) setPosition(audio.currentTime);
      };
      const onMeta = () => {
        if (audioRef.current === audio && Number.isFinite(audio.duration)) {
          setDuration(audio.duration);
        }
      };
      audio.addEventListener("timeupdate", onTime);
      audio.addEventListener("loadedmetadata", onMeta);
      audio.addEventListener("ended", () => {
        if (audioRef.current === audio) {
          audioRef.current = null;
          setState("idle");
          setPosition(0);
        }
      });
      audio.addEventListener("pause", () => {
        if (audioRef.current === audio && !audio.ended) {
          setState("idle");
        }
      });
    } catch (err) {
      console.error("[admin/conversation] audio playback failed", err);
      setState("error");
    }
  }

  const totalLabel = duration > 0 ? fmtClock(duration) : null;
  const label =
    state === "playing"
      ? `Pause · ${fmtClock(position)}${totalLabel ? `/${totalLabel}` : ""}`
      : state === "loading"
        ? "Loading…"
        : state === "error"
          ? "Try again"
          : `Listen${totalLabel ? ` · ${totalLabel}` : ""}`;
  const progressPct = duration > 0 ? Math.min(100, (position / duration) * 100) : 0;

  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        onClick={onClick}
        disabled={state === "loading"}
        className="inline-flex w-fit items-center rounded-md border border-[var(--line)] px-2 py-1 text-xs font-medium hover:bg-[var(--sand-2)] disabled:opacity-50"
      >
        {label}
      </button>
      <div className="h-1 w-32 overflow-hidden rounded-full bg-[var(--sand-2)]" aria-hidden="true">
        <div
          className="h-full bg-[var(--teal)] transition-[width] duration-100 ease-linear"
          style={{ width: `${progressPct}%` }}
        />
      </div>
    </div>
  );
}

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

// A small palette cycled per speaker so each one has a stable dot color.
const SPEAKER_COLORS = [
  "#0E7C73", // teal
  "#E8745B", // coral
  "#E8A23A", // amber
  "#3b82f6", // blue
  "#8b5cf6", // violet
  "#10b981", // emerald
  "#f97316", // orange
  "#ec4899", // pink
];

function speakerColor(index: number): string {
  return SPEAKER_COLORS[index % SPEAKER_COLORS.length];
}

function readString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function readNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function toMillis(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Date.parse(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function readAudioRef(row: Record<string, unknown>): {
  storagePath: string;
  sizeBytes: number | null;
} | null {
  // The sync engine swaps Blob fields for `{ storagePath, sizeBytes }`. The
  // contribution row carries that under `audio` (the on-device field name).
  const audio = row.audio;
  if (audio && typeof audio === "object") {
    const storagePath = readString((audio as Record<string, unknown>).storagePath);
    if (storagePath) {
      return {
        storagePath,
        sizeBytes: readNumber((audio as Record<string, unknown>).sizeBytes),
      };
    }
  }
  const topPath = readString(row.storagePath);
  if (topPath) {
    return { storagePath: topPath, sizeBytes: readNumber(row.sizeBytes) };
  }
  return null;
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (mins < 60) return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  return remMins > 0 ? `${hours}h ${remMins}m` : `${hours}h`;
}

function formatRelativeOffset(ms: number): string {
  const sign = ms < 0 ? "-" : "+";
  const total = Math.max(0, Math.floor(Math.abs(ms) / 1000));
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${sign}${mins}:${secs.toString().padStart(2, "0")}`;
}

function fmtClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const total = Math.floor(seconds);
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

function fmtBytes(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString();
}
