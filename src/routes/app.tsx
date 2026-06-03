import { useEffect } from "react";
import {
  Link,
  Outlet,
  createFileRoute,
  redirect,
  useRouter,
} from "@tanstack/react-router";

import { ParleyLogo } from "@/components/ParleyLogo";
import { cn } from "@/lib/cn";
import { drainPendingJobs } from "@/lib/jobs/drain";
import { getCurrentUser, signOutFn } from "@/lib/auth";

export const Route = createFileRoute("/app")({
  beforeLoad: async ({ location }) => {
    const user = await getCurrentUser();
    if (!user) {
      throw redirect({
        to: "/login",
        search: { redirect: location.href },
      });
    }
    return { user };
  },
  component: AppLayout,
});

const NAV: Array<{ to: string; label: string; exact?: boolean }> = [
  { to: "/app", label: "Live", exact: true },
  { to: "/app/people", label: "People" },
  { to: "/app/events", label: "Events" },
  { to: "/app/recent", label: "Recent" },
  { to: "/app/helpers", label: "Helpers" },
  { to: "/app/settings", label: "Settings" },
];

function AppLayout() {
  const { user } = Route.useRouteContext();
  const router = useRouter();

  useEffect(() => {
    if (typeof window === "undefined") return;
    void drainPendingJobs();
  }, []);

  async function handleSignOut() {
    await signOutFn();
    await router.invalidate();
    router.navigate({ to: "/login" });
  }

  return (
    <div className="flex min-h-full flex-col bg-background text-foreground">
      <header className="sticky top-0 z-20 border-b border-border bg-background/95 backdrop-blur">
        <div className="mx-auto flex w-full max-w-6xl items-center gap-3 px-4 py-3">
          <Link to="/app" className="flex items-center gap-2">
            <ParleyLogo className="h-8 w-8" />
            <span className="text-lg font-semibold tracking-tight">Parley</span>
          </Link>
          <nav className="ml-auto flex flex-wrap items-center gap-1">
            {NAV.map((item) => (
              <Link
                key={item.to}
                to={item.to}
                activeOptions={{ exact: item.exact }}
                className={cn(
                  "rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
                )}
                activeProps={{
                  className: cn(
                    "rounded-md px-3 py-1.5 text-sm font-medium bg-muted text-foreground",
                  ),
                }}
              >
                {item.label}
              </Link>
            ))}
            <div className="ml-2 flex items-center gap-2 border-l border-border pl-2">
              <span className="hidden text-xs text-muted-foreground sm:inline">
                {user?.email}
              </span>
              <button
                onClick={handleSignOut}
                className="rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                Sign out
              </button>
            </div>
          </nav>
        </div>
      </header>
      <main className="flex-1">
        <Outlet />
      </main>
    </div>
  );
}
