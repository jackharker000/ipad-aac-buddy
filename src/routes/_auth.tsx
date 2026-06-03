import { Link, Outlet, createFileRoute } from "@tanstack/react-router";

import { ParleyLogo } from "@/components/ParleyLogo";

export const Route = createFileRoute("/_auth")({
  component: AuthLayout,
});

function AuthLayout() {
  return (
    <div className="flex min-h-full flex-col bg-[var(--sand)] text-[var(--ink)]">
      <header className="px-6 py-5">
        <Link to="/" className="inline-flex items-center gap-2">
          <ParleyLogo className="h-8 w-8" />
          <span className="text-lg font-semibold tracking-tight">Parley</span>
        </Link>
      </header>
      <main className="flex flex-1 items-center justify-center px-4 py-12">
        <div className="w-full max-w-md">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
