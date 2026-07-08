import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, RefreshCw, ShieldAlert } from "lucide-react";
import { useState } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { whoami } from "@/lib/account.functions";
import {
  adminOverview,
  adminSetRole,
  adminUsage,
  adminUsers,
  type AdminUserRow,
} from "@/lib/admin.functions";

export const Route = createFileRoute("/admin")({
  component: AdminPage,
});

type DayRange = 7 | 30 | 90;

/* -------------------------------- Helpers ---------------------------------- */

function fmtUsd(n: number | null | undefined): string {
  const v = n ?? 0;
  if (v === 0) return "$0.00";
  if (Math.abs(v) < 0.01) return `$${v.toFixed(4)}`;
  if (Math.abs(v) < 1) return `$${v.toFixed(3)}`;
  return `$${v.toFixed(2)}`;
}

function fmtInt(n: number | null | undefined): string {
  return (n ?? 0).toLocaleString();
}

function timeAgo(iso: string | null | undefined): string {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  const sec = Math.floor(ms / 1000);
  if (sec < 45) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  const mo = Math.floor(day / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(day / 365)}y ago`;
}

const CHART_TOOLTIP_STYLE = {
  backgroundColor: "var(--card)",
  border: "1px solid var(--border)",
  borderRadius: "0.5rem",
  color: "var(--foreground)",
  fontSize: "12px",
} as const;

/* ------------------------------- Page shell -------------------------------- */

function AdminPage() {
  const whoQ = useQuery({ queryKey: ["whoami"], queryFn: () => whoami() });

  if (whoQ.isPending) {
    return (
      <main className="mx-auto flex min-h-screen w-full max-w-6xl flex-col gap-4 p-4">
        <Skeleton className="h-10 w-48" />
        <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-24 w-full" />
          ))}
        </div>
        <Skeleton className="h-72 w-full" />
      </main>
    );
  }

  if (whoQ.isError) {
    return (
      <main className="mx-auto flex min-h-screen w-full max-w-md flex-col items-center justify-center gap-4 p-4 text-center">
        <ShieldAlert className="size-10 text-muted-foreground" />
        <h1 className="text-xl font-semibold">Couldn't verify access</h1>
        <p className="text-sm text-muted-foreground">
          {(whoQ.error as Error)?.message || "Something went wrong checking your account."}
        </p>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => whoQ.refetch()}>
            <RefreshCw className="mr-1 size-4" /> Retry
          </Button>
          <Button asChild variant="ghost">
            <Link to="/">Back home</Link>
          </Button>
        </div>
      </main>
    );
  }

  if (!whoQ.data?.isAdmin) {
    return (
      <main className="mx-auto flex min-h-screen w-full max-w-md flex-col items-center justify-center gap-4 p-4 text-center">
        <ShieldAlert className="size-10 text-muted-foreground" />
        <h1 className="text-xl font-semibold">Admins only</h1>
        <p className="text-sm text-muted-foreground">
          {whoQ.data?.cloudEnabled === false
            ? "This deployment isn't connected to the cloud, so there's no admin data here."
            : "This page shows usage metrics and costs for Parley administrators. Your account doesn't have admin access."}
        </p>
        <Button asChild variant="outline">
          <Link to="/">Back home</Link>
        </Button>
      </main>
    );
  }

  return <AdminDashboard meUserId={whoQ.data.userId} />;
}

/* ------------------------------- Dashboard --------------------------------- */

function AdminDashboard({ meUserId }: { meUserId: string | null }) {
  const [days, setDays] = useState<DayRange>(30);
  const queryClient = useQueryClient();

  const overviewQ = useQuery({
    queryKey: ["admin", "overview"],
    queryFn: () => adminOverview(),
  });
  const usersQ = useQuery({
    queryKey: ["admin", "users"],
    queryFn: () => adminUsers(),
  });
  const usageQ = useQuery({
    queryKey: ["admin", "usage", days],
    queryFn: () => adminUsage({ data: { days } }),
  });

  const setRole = useMutation({
    mutationFn: (vars: { userId: string; role: "user" | "admin" }) => adminSetRole({ data: vars }),
    onMutate: async (vars) => {
      await queryClient.cancelQueries({ queryKey: ["admin", "users"] });
      const prev = queryClient.getQueryData<AdminUserRow[]>(["admin", "users"]);
      queryClient.setQueryData<AdminUserRow[]>(["admin", "users"], (old) =>
        (old ?? []).map((u) => (u.userId === vars.userId ? { ...u, role: vars.role } : u)),
      );
      return { prev };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev) queryClient.setQueryData(["admin", "users"], ctx.prev);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["admin", "users"] });
    },
  });

  const overview = overviewQ.data;
  const usage = usageQ.data;

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-6xl flex-col gap-4 p-4">
      {/* Header */}
      <header className="flex flex-wrap items-center gap-3">
        <Link
          to="/"
          className="flex size-10 items-center justify-center rounded-lg border border-border hover:bg-secondary"
          aria-label="Back"
        >
          <ChevronLeft className="size-5" />
        </Link>
        <div className="min-w-0 flex-1">
          <h1 className="text-xl font-semibold">Admin</h1>
          <p className="text-xs text-muted-foreground">
            Usage metrics and cost only — conversations and transcripts are never shown here.
          </p>
        </div>
        <Tabs value={String(days)} onValueChange={(v) => setDays(Number(v) as DayRange)}>
          <TabsList>
            <TabsTrigger value="7">7d</TabsTrigger>
            <TabsTrigger value="30">30d</TabsTrigger>
            <TabsTrigger value="90">90d</TabsTrigger>
          </TabsList>
        </Tabs>
      </header>

      {/* Stat cards */}
      {overviewQ.isError ? (
        <SectionError
          message={(overviewQ.error as Error)?.message || "Failed to load overview."}
          onRetry={() => overviewQ.refetch()}
        />
      ) : (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
          <StatCard
            label="Users"
            value={overview ? fmtInt(overview.totalUsers) : undefined}
            sub={overview ? `+${fmtInt(overview.newUsers30d)} in 30d` : undefined}
          />
          <StatCard
            label="Active (7d)"
            value={overview ? fmtInt(overview.activeUsers7d) : undefined}
          />
          <StatCard label="Calls (30d)" value={overview ? fmtInt(overview.calls30d) : undefined} />
          <StatCard
            label="Est. cost (30d)"
            value={overview ? fmtUsd(overview.estCost30d) : undefined}
          />
          <StatCard
            label="Error rate (7d)"
            value={overview ? `${(overview.errorRate7d * 100).toFixed(1)}%` : undefined}
          />
        </div>
      )}

      {/* Charts */}
      {usageQ.isError ? (
        <SectionError
          message={(usageQ.error as Error)?.message || "Failed to load usage data."}
          onRetry={() => usageQ.refetch()}
        />
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          <Card className="p-4">
            <h2 className="mb-2 text-sm font-medium">Daily calls & cost ({days}d)</h2>
            {usage ? (
              <ResponsiveContainer width="100%" height={280}>
                <AreaChart
                  data={usage.dailySeries}
                  margin={{ top: 4, right: 4, left: -8, bottom: 0 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                  <XAxis
                    dataKey="date"
                    tickFormatter={(d: string) => d.slice(5)}
                    tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                    tickLine={false}
                    axisLine={{ stroke: "var(--border)" }}
                    minTickGap={24}
                  />
                  <YAxis
                    yAxisId="calls"
                    allowDecimals={false}
                    tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                    tickLine={false}
                    axisLine={false}
                  />
                  <YAxis
                    yAxisId="cost"
                    orientation="right"
                    tickFormatter={(v: number) => fmtUsd(v)}
                    tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                    tickLine={false}
                    axisLine={false}
                    width={64}
                  />
                  <Tooltip
                    contentStyle={CHART_TOOLTIP_STYLE}
                    formatter={(value: any, name: any) =>
                      name === "Est. cost"
                        ? [fmtUsd(Number(value)), name]
                        : [fmtInt(Number(value)), name]
                    }
                  />
                  <Area
                    yAxisId="calls"
                    type="monotone"
                    dataKey="calls"
                    name="Calls"
                    stroke="var(--chart-2)"
                    fill="var(--chart-2)"
                    fillOpacity={0.15}
                    strokeWidth={2}
                  />
                  <Area
                    yAxisId="cost"
                    type="monotone"
                    dataKey="estCostUsd"
                    name="Est. cost"
                    stroke="var(--chart-4)"
                    fill="var(--chart-4)"
                    fillOpacity={0.15}
                    strokeWidth={2}
                  />
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <Skeleton className="h-[280px] w-full" />
            )}
          </Card>

          <Card className="p-4">
            <h2 className="mb-2 text-sm font-medium">Cost by provider ({days}d)</h2>
            {usage ? (
              usage.byProvider.length === 0 ? (
                <div className="flex h-[280px] items-center justify-center text-sm italic text-muted-foreground">
                  No usage in this period.
                </div>
              ) : (
                <ResponsiveContainer width="100%" height={280}>
                  <BarChart
                    data={usage.byProvider}
                    margin={{ top: 4, right: 4, left: -8, bottom: 0 }}
                  >
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                    <XAxis
                      dataKey="provider"
                      tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                      tickLine={false}
                      axisLine={{ stroke: "var(--border)" }}
                    />
                    <YAxis
                      tickFormatter={(v: number) => fmtUsd(v)}
                      tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                      tickLine={false}
                      axisLine={false}
                      width={64}
                    />
                    <Tooltip
                      cursor={{ fill: "var(--secondary)" }}
                      contentStyle={CHART_TOOLTIP_STYLE}
                      formatter={(value: any) => [fmtUsd(Number(value)), "Est. cost"]}
                    />
                    <Bar
                      dataKey="estCostUsd"
                      name="Est. cost"
                      fill="var(--chart-1)"
                      radius={[4, 4, 0, 0]}
                    />
                  </BarChart>
                </ResponsiveContainer>
              )
            ) : (
              <Skeleton className="h-[280px] w-full" />
            )}
          </Card>
        </div>
      )}

      {/* Per-function usage */}
      <Card className="p-4">
        <h2 className="mb-2 text-sm font-medium">By function ({days}d)</h2>
        {usageQ.isError ? (
          <p className="text-sm text-muted-foreground">Couldn't load usage data.</p>
        ) : usage ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Function</TableHead>
                <TableHead className="text-right">Calls</TableHead>
                <TableHead className="text-right">Est. cost</TableHead>
                <TableHead className="text-right">Avg latency</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {usage.byFn.length === 0 && (
                <TableRow>
                  <TableCell colSpan={4} className="text-sm italic text-muted-foreground">
                    No usage logged in this period.
                  </TableCell>
                </TableRow>
              )}
              {usage.byFn.map((f) => (
                <TableRow key={f.fn}>
                  <TableCell className="font-mono text-xs">{f.fn}</TableCell>
                  <TableCell className="text-right">{fmtInt(f.calls)}</TableCell>
                  <TableCell className="text-right">{fmtUsd(f.estCostUsd)}</TableCell>
                  <TableCell className="text-right">
                    {f.avgLatencyMs != null ? `${fmtInt(f.avgLatencyMs)}ms` : "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <Skeleton className="h-32 w-full" />
        )}
      </Card>

      {/* Users */}
      <Card className="p-4">
        <h2 className="mb-2 text-sm font-medium">Users</h2>
        {usersQ.isError ? (
          <SectionError
            message={(usersQ.error as Error)?.message || "Failed to load users."}
            onRetry={() => usersQ.refetch()}
          />
        ) : usersQ.data ? (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>User</TableHead>
                  <TableHead>Joined</TableHead>
                  <TableHead>Last active</TableHead>
                  <TableHead>Backup</TableHead>
                  <TableHead className="text-right">Calls (30d)</TableHead>
                  <TableHead className="text-right">Cost (30d)</TableHead>
                  <TableHead>Role</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {usersQ.data.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={7} className="text-sm italic text-muted-foreground">
                      No users yet.
                    </TableCell>
                  </TableRow>
                )}
                {usersQ.data.map((u) => (
                  <TableRow key={u.userId}>
                    <TableCell>
                      <div className="text-sm">{u.email ?? u.userId}</div>
                      {u.displayName && (
                        <div className="text-xs text-muted-foreground">{u.displayName}</div>
                      )}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {timeAgo(u.createdAt)}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {timeAgo(u.lastActiveAt)}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {u.backupUpdatedAt ? timeAgo(u.backupUpdatedAt) : "never"}
                    </TableCell>
                    <TableCell className="text-right">{fmtInt(u.calls30d)}</TableCell>
                    <TableCell className="text-right">{fmtUsd(u.estCost30d)}</TableCell>
                    <TableCell>
                      <Select
                        value={u.role === "admin" ? "admin" : "user"}
                        onValueChange={(v) =>
                          setRole.mutate({ userId: u.userId, role: v as "user" | "admin" })
                        }
                        disabled={u.userId === meUserId || setRole.isPending}
                      >
                        <SelectTrigger className="h-8 w-[110px]">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="user">user</SelectItem>
                          <SelectItem value="admin">admin</SelectItem>
                        </SelectContent>
                      </Select>
                      {u.userId === meUserId && (
                        <div className="mt-1 text-[10px] text-muted-foreground">you</div>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <Skeleton className="h-40 w-full" />
        )}
        {setRole.isError && (
          <p className="mt-2 text-xs text-destructive">
            Role change failed: {(setRole.error as Error)?.message || "unknown error"}
          </p>
        )}
      </Card>

      {/* Top users by cost */}
      <Card className="p-4">
        <h2 className="mb-2 text-sm font-medium">Top users by cost ({days}d)</h2>
        {usageQ.isError ? (
          <p className="text-sm text-muted-foreground">Couldn't load usage data.</p>
        ) : usage ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>User</TableHead>
                <TableHead className="text-right">Calls</TableHead>
                <TableHead className="text-right">Est. cost</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {usage.topUsers.length === 0 && (
                <TableRow>
                  <TableCell colSpan={3} className="text-sm italic text-muted-foreground">
                    No per-user usage in this period.
                  </TableCell>
                </TableRow>
              )}
              {usage.topUsers.map((t) => (
                <TableRow key={t.userId}>
                  <TableCell className="text-sm">{t.email ?? t.userId}</TableCell>
                  <TableCell className="text-right">{fmtInt(t.calls)}</TableCell>
                  <TableCell className="text-right">{fmtUsd(t.estCostUsd)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <Skeleton className="h-32 w-full" />
        )}
      </Card>
    </main>
  );
}

/* ------------------------------- Components -------------------------------- */

function StatCard({
  label,
  value,
  sub,
}: {
  label: string;
  value: string | undefined;
  sub?: string;
}) {
  return (
    <Card className="p-4">
      <div className="text-xs text-muted-foreground">{label}</div>
      {value === undefined ? (
        <Skeleton className="mt-1 h-8 w-16" />
      ) : (
        <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
      )}
      {sub && <div className="mt-0.5 text-xs text-muted-foreground">{sub}</div>}
    </Card>
  );
}

function SectionError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <Card className="flex flex-wrap items-center justify-between gap-2 border-destructive/40 p-4">
      <p className="text-sm text-muted-foreground">{message}</p>
      <Button variant="outline" size="sm" onClick={onRetry}>
        <RefreshCw className="mr-1 size-4" /> Retry
      </Button>
    </Card>
  );
}
