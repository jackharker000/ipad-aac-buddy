import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "@tanstack/react-router";

import {
  AdminApiError,
  fetchUsers,
  type AdminUserRecord,
} from "@/lib/admin";
import { cn } from "@/lib/cn";

/**
 * Cmd-K user search palette. A simple controlled modal — the trigger lives in
 * the admin header, plus a global ⌘K / Ctrl-K keybinding bound in
 * `src/routes/admin.tsx`. Filters the full users list by email substring,
 * arrow-keys move the selection, Enter navigates to the user detail page,
 * Escape closes.
 *
 * Implemented with a plain Portal + backdrop rather than Radix Dialog so the
 * Tab key stays usable inside the input without an alert-dialog focus trap
 * fighting us. The accessibility tradeoff is small for an admin-only tool that
 * never appears in the cockpit UX.
 */
export function CommandPalette({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [users, setUsers] = useState<AdminUserRecord[] | null>(null);
  const [error, setError] = useState<AdminApiError | null>(null);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);

  // Load (cached) users when the palette opens. The shared 30s cache in
  // `lib/admin.ts` means re-opening the palette is instant for the dev who
  // just visited /admin/users.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    fetchUsers()
      .then((list) => {
        if (!cancelled) {
          setUsers(list);
          setError(null);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(
            err instanceof AdminApiError
              ? err
              : new AdminApiError(0, "Couldn't load users."),
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  // Reset transient state every time the palette opens, and focus the input on
  // the next tick so the autofocus survives the portal mount.
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActiveIndex(0);
    const t = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(t);
  }, [open]);

  const filtered = useMemo(() => {
    const list = users ?? [];
    const q = query.trim().toLowerCase();
    if (!q) return list.slice(0, 20);
    return list
      .filter((u) => (u.email ?? "").toLowerCase().includes(q))
      .slice(0, 50);
  }, [users, query]);

  // Clamp the highlight when the filter shrinks the visible list.
  useEffect(() => {
    if (activeIndex >= filtered.length) {
      setActiveIndex(Math.max(0, filtered.length - 1));
    }
  }, [filtered.length, activeIndex]);

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => Math.min(filtered.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const picked = filtered[activeIndex];
      if (picked) {
        onOpenChange(false);
        navigate({ to: "/admin/users/$userId", params: { userId: picked.uid } });
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      onOpenChange(false);
    }
  }

  if (!open) return null;
  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Search users"
      className="fixed inset-0 z-50 flex items-start justify-center p-4 sm:pt-[10vh]"
    >
      <button
        type="button"
        aria-label="Close"
        onClick={() => onOpenChange(false)}
        className="absolute inset-0 cursor-default bg-[var(--ink)]/40 backdrop-blur-sm"
      />
      <div
        className={cn(
          "relative w-full max-w-xl overflow-hidden rounded-2xl border border-[var(--line)] bg-white shadow-2xl shadow-[var(--ink)]/15",
        )}
      >
        <input
          ref={inputRef}
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Search users by email…"
          className="w-full border-0 p-4 text-base text-[var(--ink)] placeholder:text-[var(--ink-soft)] focus:outline-none focus:ring-0"
        />
        <div className="border-t border-[var(--line)]">
          {error ? (
            <PaletteMessage>{error.message}</PaletteMessage>
          ) : users === null ? (
            <PaletteMessage>Loading users…</PaletteMessage>
          ) : filtered.length === 0 ? (
            <PaletteMessage>No users match.</PaletteMessage>
          ) : (
            <ul
              role="listbox"
              aria-label="Matching users"
              className="max-h-[50vh] overflow-y-auto"
            >
              {filtered.map((u, i) => {
                const active = i === activeIndex;
                return (
                  <li
                    key={u.uid}
                    role="option"
                    aria-selected={active}
                    onMouseEnter={() => setActiveIndex(i)}
                    onClick={() => {
                      onOpenChange(false);
                      navigate({
                        to: "/admin/users/$userId",
                        params: { userId: u.uid },
                      });
                    }}
                    className={cn(
                      "flex cursor-pointer items-center justify-between gap-3 px-4 py-2.5 text-sm",
                      active
                        ? "bg-[var(--sand-2)]"
                        : "hover:bg-[var(--sand-2)]",
                    )}
                  >
                    <span className="truncate text-[var(--ink)]">
                      {u.email ?? <span className="italic text-[var(--ink-soft)]">no email</span>}
                    </span>
                    {u.is_admin ? (
                      <span className="rounded-full bg-[var(--teal)]/10 px-2 py-0.5 text-xs font-medium text-[var(--teal-dark)]">
                        admin
                      </span>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        <div className="flex items-center justify-between border-t border-[var(--line)] bg-[var(--sand-2)]/60 px-4 py-2 text-xs text-[var(--ink-soft)]">
          <span>↑↓ navigate · ↵ open · esc close</span>
          <span>
            {filtered.length > 0
              ? `${filtered.length} ${filtered.length === 1 ? "match" : "matches"}`
              : ""}
          </span>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function PaletteMessage({ children }: { children: React.ReactNode }) {
  return (
    <p className="px-4 py-6 text-center text-sm text-[var(--ink-soft)]">{children}</p>
  );
}
