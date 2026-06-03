import { Link, createFileRoute } from "@tanstack/react-router";

import { getOverview } from "@/lib/admin";
import type { AdminUser, WaitlistEntry } from "@/lib/admin";

export const Route = createFileRoute("/admin/")({
  loader: async () => getOverview(),
  component: AdminOverview,
});

function AdminOverview() {
  const { userCount, waitlistCount, recentUsers, recentWaitlist } = Route.useLoaderData();

  return (
    <div className="mx-auto max-w-6xl px-5 py-8">
      <h1 className="text-3xl font-semibold tracking-tight">Overview</h1>

      <div className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-3">
        <StatCard label="Users" value={fmtCount(userCount)} />
        <StatCard
          label="Conversations (last 7 days)"
          value="Not yet tracked"
          note="Conversation counts live in each user's on-device storage (Dexie), not Supabase."
        />
        <StatCard label="Waitlist" value={fmtCount(waitlistCount)} />
      </div>

      <section className="mt-10">
        <div className="flex items-baseline justify-between">
          <h2 className="text-xl font-semibold tracking-tight">Recent signups</h2>
          <Link
            to="/admin/users"
            className="text-sm font-medium text-[var(--teal-dark)] hover:underline"
          >
            View all
          </Link>
        </div>
        <div className="mt-3 rounded-2xl border border-[var(--line)] bg-white p-3">
          {recentUsers.length === 0 ? (
            <EmptyRow message="No users yet." />
          ) : (
            <UsersTable users={recentUsers} />
          )}
        </div>
      </section>

      <section className="mt-10">
        <div className="flex items-baseline justify-between">
          <h2 className="text-xl font-semibold tracking-tight">Recent waitlist</h2>
          <Link
            to="/admin/usage"
            className="text-sm font-medium text-[var(--teal-dark)] hover:underline"
          >
            View all
          </Link>
        </div>
        <div className="mt-3 rounded-2xl border border-[var(--line)] bg-white p-3">
          {recentWaitlist.length === 0 ? (
            <EmptyRow message="No waitlist signups yet." />
          ) : (
            <WaitlistTable rows={recentWaitlist} />
          )}
        </div>
      </section>
    </div>
  );
}

function fmtCount(n: number | null | undefined): string {
  return typeof n === "number" ? n.toLocaleString() : "—";
}

function StatCard({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note?: string;
}) {
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

function UsersTable({ users }: { users: AdminUser[] }) {
  return (
    <table className="w-full border-separate border-spacing-0 text-sm">
      <thead>
        <tr>
          <Th>Email</Th>
          <Th>Signed up</Th>
          <Th>Last seen</Th>
          <Th>Admin</Th>
        </tr>
      </thead>
      <tbody>
        {users.map((u) => (
          <tr key={u.id}>
            <Td>{u.email ?? <span className="text-[var(--ink-soft)]">(no email)</span>}</Td>
            <Td>{fmtDate(u.created_at)}</Td>
            <Td>{fmtDate(u.last_sign_in_at)}</Td>
            <Td>{u.is_admin ? <AdminBadge /> : null}</Td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function WaitlistTable({ rows }: { rows: WaitlistEntry[] }) {
  return (
    <table className="w-full border-separate border-spacing-0 text-sm">
      <thead>
        <tr>
          <Th>Email</Th>
          <Th>Name</Th>
          <Th>About</Th>
          <Th>Joined</Th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={String(r.id)}>
            <Td>{r.email ?? <span className="text-[var(--ink-soft)]">—</span>}</Td>
            <Td>{r.name ?? <span className="text-[var(--ink-soft)]">—</span>}</Td>
            <Td>
              <span className="line-clamp-2 max-w-md text-[var(--ink-soft)]">
                {r.about ?? "—"}
              </span>
            </Td>
            <Td>{fmtDate(r.created_at)}</Td>
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
