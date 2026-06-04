import { useEffect, useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";

import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Button } from "@/components/ui/button";
import {
  AdminApiError,
  fetchWaitlist,
  markWaitlistEntry,
  relativeTime,
  type WaitlistAction,
  type WaitlistEntry,
} from "@/lib/admin";
import { cn } from "@/lib/cn";

/**
 * Admin → Waitlist. Lists every signup from the marketing form so the owner
 * can mark them onboarded / archived / deleted. Data lives in the Firestore
 * `waitlist` collection and is fetched via `/api/admin/waitlist` (server-only
 * service account; the collection is server-write-only per the security rules).
 */

export const Route = createFileRoute("/admin/waitlist")({
  component: AdminWaitlistPage,
});

type PendingAction = {
  id: string;
  email: string;
  action: WaitlistAction;
};

function AdminWaitlistPage() {
  const [entries, setEntries] = useState<WaitlistEntry[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<AdminApiError | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchWaitlist()
      .then((list) => {
        if (!cancelled) {
          setEntries(list);
          setError(null);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(
            err instanceof AdminApiError
              ? err
              : new AdminApiError(0, "Couldn't load the waitlist."),
          );
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const counts = useMemo(() => {
    const list = entries ?? [];
    let onboarded = 0;
    let archived = 0;
    let fresh = 0;
    for (const e of list) {
      if (e.status === "onboarded") onboarded += 1;
      else if (e.status === "archived") archived += 1;
      else fresh += 1;
    }
    return { total: list.length, onboarded, archived, fresh };
  }, [entries]);

  async function performAction(p: PendingAction) {
    setBusy(true);
    try {
      await markWaitlistEntry(p.id, p.action);
      // Optimistic local update so the UI reacts immediately, then refresh
      // to pick up any concurrent admin's changes.
      setEntries((prev) => {
        if (!prev) return prev;
        if (p.action === "delete") {
          return prev.filter((e) => e.id !== p.id);
        }
        return prev.map((e) =>
          e.id === p.id
            ? {
                ...e,
                status: p.action === "onboarded" ? "onboarded" : "archived",
                onboardedAt:
                  p.action === "onboarded"
                    ? new Date().toISOString()
                    : e.onboardedAt,
              }
            : e,
        );
      });
      try {
        const fresh = await fetchWaitlist({ force: true });
        setEntries(fresh);
      } catch {
        // Optimistic state is good enough — silent refresh failure is fine.
      }
    } catch (err) {
      setError(
        err instanceof AdminApiError
          ? err
          : new AdminApiError(0, "Couldn't update entry."),
      );
    } finally {
      setBusy(false);
      setPending(null);
    }
  }

  const header = (
    <div className="flex flex-wrap items-baseline justify-between gap-3">
      <h1 className="text-3xl font-semibold tracking-tight">Waitlist</h1>
      {entries && entries.length > 0 ? (
        <p className="text-sm text-[var(--ink-soft)]">
          {counts.total.toLocaleString()} total ·{" "}
          {counts.fresh.toLocaleString()} new ·{" "}
          {counts.onboarded.toLocaleString()} onboarded
        </p>
      ) : null}
    </div>
  );

  if (loading) {
    return (
      <div className="mx-auto max-w-screen-2xl px-5 py-5">
        {header}
        <div className="mt-6 rounded-2xl border border-[var(--line)] bg-white p-3">
          <RowSkeletons rows={5} />
        </div>
      </div>
    );
  }

  if (error && !entries) {
    return (
      <div className="mx-auto max-w-screen-2xl px-5 py-5">
        {header}
        <ErrorCard error={error} />
      </div>
    );
  }

  const list = entries ?? [];

  return (
    <div className="mx-auto max-w-screen-2xl px-5 py-5">
      {header}

      {error ? (
        <div className="mt-4 rounded-2xl border border-[var(--coral)]/40 bg-[var(--coral)]/10 p-4 text-sm text-[var(--ink)]">
          {error.message}
        </div>
      ) : null}

      <div className="mt-4 rounded-2xl border border-[var(--line)] bg-white p-3">
        {list.length === 0 ? (
          <EmptyState />
        ) : (
          <WaitlistTable
            entries={list}
            expanded={expanded}
            onToggleExpand={(id) =>
              setExpanded((prev) => {
                const next = new Set(prev);
                if (next.has(id)) next.delete(id);
                else next.add(id);
                return next;
              })
            }
            onAction={(id, email, action) =>
              setPending({ id, email, action })
            }
            disabled={busy}
          />
        )}
      </div>

      <ConfirmDialog
        open={pending !== null}
        onOpenChange={(o) => {
          if (!o) setPending(null);
        }}
        title={confirmTitle(pending)}
        description={confirmDescription(pending)}
        confirmLabel={confirmLabel(pending)}
        destructive={pending?.action === "delete"}
        onConfirm={() => {
          if (pending) void performAction(pending);
        }}
      />
    </div>
  );
}

function confirmTitle(p: PendingAction | null): string {
  if (!p) return "";
  if (p.action === "delete") return "Delete waitlist entry?";
  if (p.action === "onboarded") return "Mark as onboarded?";
  return "Archive waitlist entry?";
}

function confirmDescription(p: PendingAction | null): string | undefined {
  if (!p) return undefined;
  if (p.action === "delete") {
    return `This permanently removes ${p.email} from the waitlist. There's no undo.`;
  }
  if (p.action === "onboarded") {
    return `Mark ${p.email} as onboarded and stamp the date.`;
  }
  return `Archive ${p.email}. They'll still show up in the list but tagged archived.`;
}

function confirmLabel(p: PendingAction | null): string {
  if (!p) return "Confirm";
  if (p.action === "delete") return "Delete";
  if (p.action === "onboarded") return "Mark onboarded";
  return "Archive";
}

// --------------------------------------------------------------------------
// Sub-components
// --------------------------------------------------------------------------

function WaitlistTable({
  entries,
  expanded,
  onToggleExpand,
  onAction,
  disabled,
}: {
  entries: WaitlistEntry[];
  expanded: Set<string>;
  onToggleExpand: (id: string) => void;
  onAction: (id: string, email: string, action: WaitlistAction) => void;
  disabled: boolean;
}) {
  return (
    <table className="w-full border-separate border-spacing-0 text-sm">
      <thead>
        <tr>
          <Th>Date</Th>
          <Th>Name</Th>
          <Th>Email</Th>
          <Th>About</Th>
          <Th>Status</Th>
          <Th>Actions</Th>
        </tr>
      </thead>
      <tbody>
        {entries.map((e) => {
          const isExpanded = expanded.has(e.id);
          return (
            <tr key={e.id}>
              <Td>
                <span
                  title={fmtAbsolute(e.createdAt)}
                  className="cursor-help"
                >
                  {relativeTime(e.createdAt)}
                </span>
              </Td>
              <Td>{e.name || <Muted>—</Muted>}</Td>
              <Td>
                <a
                  href={`mailto:${e.email}`}
                  className="text-[var(--teal-dark)] hover:underline"
                >
                  {e.email}
                </a>
              </Td>
              <Td>
                {e.about ? (
                  <button
                    type="button"
                    onClick={() => onToggleExpand(e.id)}
                    className={cn(
                      "text-left",
                      isExpanded
                        ? "whitespace-pre-wrap text-[var(--ink)]"
                        : "block max-w-md truncate text-[var(--ink)] hover:underline",
                    )}
                    title={isExpanded ? "Click to collapse" : "Click to expand"}
                  >
                    {e.about}
                  </button>
                ) : (
                  <Muted>—</Muted>
                )}
              </Td>
              <Td>
                <StatusBadge status={e.status} />
              </Td>
              <Td>
                <div className="flex flex-wrap items-center gap-1.5">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={disabled || e.status === "onboarded"}
                    onClick={() => onAction(e.id, e.email, "onboarded")}
                  >
                    Mark onboarded
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={disabled || e.status === "archived"}
                    onClick={() => onAction(e.id, e.email, "archive")}
                  >
                    Archive
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={disabled}
                    onClick={() => onAction(e.id, e.email, "delete")}
                    className="text-[var(--coral)] hover:text-[var(--coral)]"
                  >
                    Delete
                  </Button>
                </div>
              </Td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function StatusBadge({ status }: { status: string | null }) {
  if (status === "onboarded") {
    return (
      <span className="inline-flex items-center rounded-full bg-[var(--teal)]/10 px-2 py-0.5 text-xs font-medium text-[var(--teal-dark)]">
        onboarded
      </span>
    );
  }
  if (status === "archived") {
    return (
      <span className="inline-flex items-center rounded-full bg-[var(--sand-2)] px-2 py-0.5 text-xs font-medium text-[var(--ink-soft)]">
        archived
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded-full bg-[var(--sun)]/20 px-2 py-0.5 text-xs font-medium text-[var(--ink)]">
      new
    </span>
  );
}

function ErrorCard({ error }: { error: AdminApiError }) {
  const is503 = error.status === 503;
  return (
    <div className="mt-6 rounded-2xl border border-[var(--line)] bg-white p-6">
      <h2 className="text-base font-semibold">
        {is503 ? "Admin features aren't configured yet" : "Couldn't load the waitlist"}
      </h2>
      <p className="mt-2 text-sm text-[var(--ink-soft)]">{error.message}</p>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="py-12 text-center">
      <p className="text-sm font-medium">No waitlist signups yet.</p>
      <p className="mt-2 text-sm text-[var(--ink-soft)]">
        When someone fills in the waitlist form on the marketing site, they'll appear here.
      </p>
    </div>
  );
}

function RowSkeletons({ rows }: { rows: number }) {
  return (
    <div className="flex flex-col gap-2">
      {Array.from({ length: rows }).map((_, i) => (
        <div
          key={i}
          className="h-12 bg-[var(--sand-2)]/60 rounded-md animate-pulse"
        />
      ))}
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th className="bg-muted/40 text-left font-medium px-3 py-2 border-b border-[var(--line)]">
      {children}
    </th>
  );
}

function Td({ children }: { children: React.ReactNode }) {
  return <td className="px-3 py-2 border-b border-[var(--line)] align-top">{children}</td>;
}

function Muted({ children }: { children: React.ReactNode }) {
  return <span className="text-[var(--ink-soft)]">{children}</span>;
}

function fmtAbsolute(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
