import { Link, createFileRoute } from "@tanstack/react-router";

import { Button } from "@/components/ui/button";
import { getUserById } from "@/lib/admin";
import type { AdminUser } from "@/lib/admin";

export const Route = createFileRoute("/admin/users/$userId")({
  loader: async ({ params }) => getUserById({ data: { userId: params.userId } }),
  component: AdminUserDetailPage,
});

function AdminUserDetailPage() {
  const { user } = Route.useLoaderData();

  return (
    <div className="mx-auto max-w-6xl px-5 py-8">
      <Link
        to="/admin/users"
        className="text-sm font-medium text-[var(--teal-dark)] hover:underline"
      >
        ← Back to users
      </Link>
      <h1 className="mt-2 text-3xl font-semibold tracking-tight">
        User {user.email ?? user.id}
      </h1>

      <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <InfoCard user={user} />
        <MetadataCard user={user} />
      </div>

      <DangerZone />
    </div>
  );
}

function InfoCard({ user }: { user: AdminUser }) {
  return (
    <div className="rounded-2xl border border-[var(--line)] bg-white p-6">
      <h2 className="text-base font-semibold">Account</h2>
      <dl className="mt-4 grid grid-cols-[140px_1fr] gap-y-2 text-sm">
        <Dt>ID</Dt>
        <Dd className="font-mono text-xs">{user.id}</Dd>

        <Dt>Email</Dt>
        <Dd>{user.email ?? <span className="text-[var(--ink-soft)]">(no email)</span>}</Dd>

        <Dt>Created</Dt>
        <Dd>{fmtDateTime(user.created_at)}</Dd>

        <Dt>Last sign in</Dt>
        <Dd>{fmtDateTime(user.last_sign_in_at)}</Dd>

        <Dt>Email confirmed</Dt>
        <Dd>{fmtDateTime(user.email_confirmed_at)}</Dd>

        <Dt>Provider</Dt>
        <Dd>{user.provider ?? <span className="text-[var(--ink-soft)]">—</span>}</Dd>

        <Dt>Admin</Dt>
        <Dd>
          {user.is_admin ? (
            <span className="inline-flex items-center rounded-full bg-[var(--teal)]/10 px-2 py-0.5 text-xs font-medium text-[var(--teal-dark)]">
              admin
            </span>
          ) : (
            <span className="text-[var(--ink-soft)]">no</span>
          )}
        </Dd>
      </dl>
    </div>
  );
}

function MetadataCard({ user }: { user: AdminUser }) {
  return (
    <div className="rounded-2xl border border-[var(--line)] bg-white p-6">
      <h2 className="text-base font-semibold">Metadata</h2>

      <h3 className="mt-4 text-xs font-medium uppercase tracking-wider text-[var(--ink-soft)]">
        app_metadata
      </h3>
      <KvTable obj={user.app_metadata} />

      <h3 className="mt-6 text-xs font-medium uppercase tracking-wider text-[var(--ink-soft)]">
        user_metadata
      </h3>
      <KvTable obj={user.user_metadata} />
    </div>
  );
}

function KvTable({ obj }: { obj: Record<string, unknown> }) {
  const entries = Object.entries(obj ?? {});
  if (entries.length === 0) {
    return <p className="mt-2 text-sm text-[var(--ink-soft)]">(empty)</p>;
  }
  return (
    <table className="mt-2 w-full border-separate border-spacing-0 text-sm">
      <tbody>
        {entries.map(([k, v]) => (
          <tr key={k}>
            <td className="border-b border-[var(--line)] px-3 py-2 align-top font-mono text-xs text-[var(--ink-soft)] w-40">
              {k}
            </td>
            <td className="border-b border-[var(--line)] px-3 py-2 align-top font-mono text-xs break-all">
              {JSON.stringify(v)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function DangerZone() {
  return (
    <div className="mt-6 rounded-2xl border border-[var(--line)] bg-white p-6">
      <h2 className="text-base font-semibold text-[var(--coral)]">Danger zone</h2>
      <p className="mt-1 text-sm text-[var(--ink-soft)]">
        Destructive actions — not yet wired up. The buttons are visible so the affordance is
        obvious, but they do nothing.
      </p>
      <div className="mt-4 flex flex-wrap gap-3">
        <Button variant="outline" disabled title="Not implemented">
          Make admin / Revoke admin
        </Button>
        <Button variant="destructive" disabled title="Not implemented">
          Delete user
        </Button>
      </div>
    </div>
  );
}

function Dt({ children }: { children: React.ReactNode }) {
  return <dt className="font-medium text-[var(--ink-soft)]">{children}</dt>;
}

function Dd({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <dd className={className ?? ""}>{children}</dd>;
}

function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}
