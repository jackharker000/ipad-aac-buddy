import { useEffect, useState } from "react";
import { Link, createFileRoute } from "@tanstack/react-router";

import { Button } from "@/components/ui/button";
import { AdminApiError, fetchUsers } from "@/lib/admin";
import type { AdminUserRecord } from "@/lib/admin";

export const Route = createFileRoute("/admin/users")({
  component: AdminUsersPage,
});

function AdminUsersPage() {
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

  if (loading) {
    return (
      <div className="mx-auto max-w-6xl px-5 py-8">
        <h1 className="text-3xl font-semibold tracking-tight">Users</h1>
        <p className="mt-6 text-sm text-[var(--ink-soft)]">Loading…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="mx-auto max-w-6xl px-5 py-8">
        <h1 className="text-3xl font-semibold tracking-tight">Users</h1>
        <ErrorCard error={error} />
      </div>
    );
  }

  const list = users ?? [];

  return (
    <div className="mx-auto max-w-6xl px-5 py-8">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="text-3xl font-semibold tracking-tight">Users</h1>
        <p className="text-sm text-[var(--ink-soft)]">
          {list.length === 0
            ? "No users to show"
            : `${list.length.toLocaleString()} total`}
        </p>
      </div>

      <div className="mt-6 rounded-2xl border border-[var(--line)] bg-white p-3">
        {list.length === 0 ? <EmptyState /> : <UsersTable users={list} />}
      </div>
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

function EmptyState() {
  return (
    <div className="py-12 text-center">
      <p className="text-sm font-medium">No users yet.</p>
    </div>
  );
}

function AdminBadge() {
  return (
    <span className="inline-flex items-center rounded-full bg-[var(--teal)]/10 px-2 py-0.5 text-xs font-medium text-[var(--teal-dark)]">
      admin
    </span>
  );
}

function UsersTable({ users }: { users: AdminUserRecord[] }) {
  return (
    <table className="w-full border-separate border-spacing-0 text-sm">
      <thead>
        <tr>
          <Th>Email</Th>
          <Th>Provider</Th>
          <Th>Created</Th>
          <Th>Last seen</Th>
          <Th>Admin</Th>
          <Th>Disabled</Th>
          <Th>Actions</Th>
        </tr>
      </thead>
      <tbody>
        {users.map((u) => (
          <tr key={u.uid}>
            <Td>{u.email ?? "—"}</Td>
            <Td>{u.provider ?? "—"}</Td>
            <Td>{fmtDate(u.createdAt)}</Td>
            <Td>{fmtDate(u.lastSignInAt)}</Td>
            <Td>{u.is_admin ? <AdminBadge /> : null}</Td>
            <Td>{u.disabled ? "Yes" : "No"}</Td>
            <Td>
              <Link to="/admin/users/$userId" params={{ userId: u.uid }}>
                <Button variant="outline" size="sm">
                  View
                </Button>
              </Link>
            </Td>
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
