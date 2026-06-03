import { Link, createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

import { Button } from "@/components/ui/button";
import { listUsers } from "@/lib/admin";
import type { AdminUser } from "@/lib/admin";

const UsersSearch = z.object({
  page: z.number().int().min(1).catch(1).default(1),
  perPage: z.number().int().min(1).max(200).catch(25).default(25),
});

export const Route = createFileRoute("/admin/users")({
  validateSearch: UsersSearch,
  loaderDeps: ({ search }) => ({ page: search.page, perPage: search.perPage }),
  loader: async ({ deps }) =>
    listUsers({ data: { page: deps.page, perPage: deps.perPage } }),
  component: AdminUsersPage,
});

function AdminUsersPage() {
  const { users, total, page, perPage } = Route.useLoaderData();

  const start = users.length === 0 ? 0 : (page - 1) * perPage + 1;
  const end = (page - 1) * perPage + users.length;
  const hasPrev = page > 1;
  // When `total` isn't returned, fall back to "got a full page => probably more".
  const hasNext = total != null ? end < total : users.length === perPage;

  return (
    <div className="mx-auto max-w-6xl px-5 py-8">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="text-3xl font-semibold tracking-tight">Users</h1>
        <p className="text-sm text-[var(--ink-soft)]">
          {users.length === 0
            ? "No users to show"
            : total != null
              ? `Showing ${start}–${end} of ${total.toLocaleString()}`
              : `Showing ${start}–${end}`}
        </p>
      </div>

      <div className="mt-6 rounded-2xl border border-[var(--line)] bg-white p-3">
        {users.length === 0 ? (
          <EmptyState />
        ) : (
          <UsersTable users={users} />
        )}
      </div>

      <div className="mt-4 flex items-center justify-between gap-3">
        <span className="text-xs text-[var(--ink-soft)]">
          Page {page}
          {total != null ? ` of ${Math.max(1, Math.ceil(total / perPage))}` : ""}
        </span>
        <div className="flex items-center gap-2">
          <Link
            to="/admin/users"
            search={{ page: Math.max(1, page - 1), perPage }}
            disabled={!hasPrev}
          >
            <Button variant="outline" size="sm" disabled={!hasPrev}>
              Prev
            </Button>
          </Link>
          <Link
            to="/admin/users"
            search={{ page: page + 1, perPage }}
            disabled={!hasNext}
          >
            <Button variant="outline" size="sm" disabled={!hasNext}>
              Next
            </Button>
          </Link>
        </div>
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="py-12 text-center">
      <p className="text-sm font-medium">No users yet</p>
      <p className="mt-1 text-sm text-[var(--ink-soft)]">
        No users yet — invite someone to sign up.
      </p>
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

function UsersTable({ users }: { users: AdminUser[] }) {
  return (
    <table className="w-full border-separate border-spacing-0 text-sm">
      <thead>
        <tr>
          <Th>Email</Th>
          <Th>Signed up</Th>
          <Th>Last seen</Th>
          <Th>Provider</Th>
          <Th>Admin</Th>
          <Th>Actions</Th>
        </tr>
      </thead>
      <tbody>
        {users.map((u) => (
          <tr key={u.id}>
            <Td>{u.email ?? <span className="text-[var(--ink-soft)]">(no email)</span>}</Td>
            <Td>{fmtDate(u.created_at)}</Td>
            <Td>{fmtDate(u.last_sign_in_at)}</Td>
            <Td>{u.provider ?? <span className="text-[var(--ink-soft)]">—</span>}</Td>
            <Td>{u.is_admin ? <AdminBadge /> : null}</Td>
            <Td>
              <Link to="/admin/users/$userId" params={{ userId: u.id }}>
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
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}
