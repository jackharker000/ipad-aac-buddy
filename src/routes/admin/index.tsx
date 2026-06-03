import { useEffect, useState } from "react";
import { Link, createFileRoute } from "@tanstack/react-router";

import { AdminApiError, fetchUsers } from "@/lib/admin";
import type { AdminUserRecord } from "@/lib/admin";

export const Route = createFileRoute("/admin/")({
  component: AdminOverview,
});

function AdminOverview() {
  const [users, setUsers] = useState<AdminUserRecord[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<AdminApiError | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchUsers()
      .then((data) => {
        if (!cancelled) {
          setUsers(data);
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
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const banner = (
    <div className="mt-6 rounded-2xl bg-[var(--sand-2)] p-4 text-sm text-[var(--ink-soft)]">
      Accounts are managed in Firebase. This dashboard shows every Parley account across all
      devices.
    </div>
  );

  if (loading) {
    return (
      <div className="mx-auto max-w-6xl px-5 py-8">
        <h1 className="text-3xl font-semibold tracking-tight">Overview</h1>
        {banner}
        <p className="mt-6 text-sm text-[var(--ink-soft)]">Loading…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="mx-auto max-w-6xl px-5 py-8">
        <h1 className="text-3xl font-semibold tracking-tight">Overview</h1>
        {banner}
        <ErrorCard error={error} />
      </div>
    );
  }

  const list = users ?? [];
  const admins = list.filter((u) => u.is_admin).length;

  return (
    <div className="mx-auto max-w-6xl px-5 py-8">
      <h1 className="text-3xl font-semibold tracking-tight">Overview</h1>

      {banner}

      <div className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-3">
        <StatCard label="Total users" value={list.length.toLocaleString()} />
        <StatCard
          label="Conversations (7d)"
          value="Not tracked"
          note="Conversation data is per-device (and syncing is being wired separately)."
        />
        <StatCard label="Admins" value={admins.toLocaleString()} />
      </div>

      <section className="mt-10">
        <div className="flex items-baseline justify-between">
          <h2 className="text-xl font-semibold tracking-tight">Recent users</h2>
          <Link
            to="/admin/users"
            className="text-sm font-medium text-[var(--teal-dark)] hover:underline"
          >
            View all
          </Link>
        </div>
        <div className="mt-3 rounded-2xl border border-[var(--line)] bg-white p-3">
          {list.length === 0 ? (
            <EmptyRow message="No users yet." />
          ) : (
            <RecentUsersTable users={list.slice(0, 10)} />
          )}
        </div>
      </section>
    </div>
  );
}

function ErrorCard({ error }: { error: AdminApiError }) {
  const is503 = error.status === 503;
  return (
    <div className="mt-6 rounded-2xl border border-[var(--line)] bg-white p-6">
      <h2 className="text-base font-semibold">
        {is503 ? "Admin features aren't configured yet" : "Couldn't load users"}
      </h2>
      <p className="mt-2 text-sm text-[var(--ink-soft)]">{error.message}</p>
    </div>
  );
}

function StatCard({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="rounded-2xl border border-[var(--line)] bg-white p-6">
      <div className="text-sm font-medium text-[var(--ink-soft)]">{label}</div>
      <div className="mt-2 text-3xl font-semibold tracking-tight">{value}</div>
      {note ? <p className="mt-2 text-xs italic text-[var(--ink-soft)]">{note}</p> : null}
    </div>
  );
}

function EmptyRow({ message }: { message: string }) {
  return <p className="px-3 py-6 text-center text-sm text-[var(--ink-soft)]">{message}</p>;
}

function AdminBadge() {
  return (
    <span className="inline-flex items-center rounded-full bg-[var(--teal)]/10 px-2 py-0.5 text-xs font-medium text-[var(--teal-dark)]">
      admin
    </span>
  );
}

function RecentUsersTable({ users }: { users: AdminUserRecord[] }) {
  return (
    <table className="w-full border-separate border-spacing-0 text-sm">
      <thead>
        <tr>
          <Th>Email</Th>
          <Th>Created</Th>
          <Th>Last seen</Th>
          <Th>Admin</Th>
        </tr>
      </thead>
      <tbody>
        {users.map((u) => (
          <tr key={u.uid}>
            <Td>{u.email ?? "—"}</Td>
            <Td>{fmtDate(u.createdAt)}</Td>
            <Td>{fmtDate(u.lastSignInAt)}</Td>
            <Td>{u.is_admin ? <AdminBadge /> : null}</Td>
          </tr>
        ))}
      </tbody>
    </table>
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

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}
