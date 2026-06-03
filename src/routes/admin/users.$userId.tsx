import { useEffect, useState } from "react";
import { Link, createFileRoute } from "@tanstack/react-router";

import { Button } from "@/components/ui/button";
import { AdminApiError, fetchUser } from "@/lib/admin";
import type { AdminUserRecord } from "@/lib/admin";

export const Route = createFileRoute("/admin/users/$userId")({
  component: AdminUserDetailPage,
});

function AdminUserDetailPage() {
  const { userId } = Route.useParams();
  const [user, setUser] = useState<AdminUserRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<AdminApiError | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchUser(userId)
      .then((data) => {
        if (!cancelled) {
          setUser(data);
          setError(null);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(
            err instanceof AdminApiError
              ? err
              : new AdminApiError(0, "Couldn't load this user."),
          );
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [userId]);

  return (
    <div className="mx-auto max-w-6xl px-5 py-8">
      <Link
        to="/admin/users"
        className="text-sm font-medium text-[var(--teal-dark)] hover:underline"
      >
        ← Back to users
      </Link>

      {loading ? (
        <p className="mt-6 text-sm text-[var(--ink-soft)]">Loading…</p>
      ) : error ? (
        <ErrorCard error={error} />
      ) : user === null ? (
        <>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight">User</h1>
          <p className="mt-6 text-sm text-[var(--ink-soft)]">User not found.</p>
        </>
      ) : (
        <>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight">
            {user.email ?? user.uid}
          </h1>
          <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
            <InfoCard user={user} />
          </div>
          <DangerZone />
        </>
      )}
    </div>
  );
}

function ErrorCard({ error }: { error: AdminApiError }) {
  const is503 = error.status === 503;
  return (
    <div className="mt-6 rounded-2xl border border-[var(--line)] bg-white p-6">
      <h2 className="text-base font-semibold">
        {is503 ? "Admin features aren't configured yet" : "Couldn't load this user"}
      </h2>
      <p className="mt-2 text-sm text-[var(--ink-soft)]">{error.message}</p>
    </div>
  );
}

function InfoCard({ user }: { user: AdminUserRecord }) {
  return (
    <div className="rounded-2xl border border-[var(--line)] bg-white p-6">
      <h2 className="text-base font-semibold">Account</h2>
      <dl className="mt-4 grid grid-cols-[140px_1fr] gap-y-2 text-sm">
        <Dt>UID</Dt>
        <Dd className="font-mono text-xs">{user.uid}</Dd>

        <Dt>Email</Dt>
        <Dd>{user.email ?? "—"}</Dd>

        <Dt>Display name</Dt>
        <Dd>{user.displayName ?? "—"}</Dd>

        <Dt>Provider</Dt>
        <Dd>{user.provider ?? "—"}</Dd>

        <Dt>Created</Dt>
        <Dd>{fmtDateTime(user.createdAt)}</Dd>

        <Dt>Last sign in</Dt>
        <Dd>{fmtDateTime(user.lastSignInAt)}</Dd>

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

        <Dt>Disabled</Dt>
        <Dd>{user.disabled ? "Yes" : "No"}</Dd>
      </dl>
    </div>
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
          Revoke admin
        </Button>
        <Button variant="outline" disabled title="Not implemented">
          Disable account
        </Button>
        <Button variant="destructive" disabled title="Not implemented">
          Delete account
        </Button>
      </div>
    </div>
  );
}

function Dt({ children }: { children: React.ReactNode }) {
  return <dt className="font-medium text-[var(--ink-soft)]">{children}</dt>;
}

function Dd({ children, className }: { children: React.ReactNode; className?: string }) {
  return <dd className={className ?? ""}>{children}</dd>;
}

function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString();
}
