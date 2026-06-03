import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/admin/")({
  component: AdminOverview,
});

function AdminOverview() {
  return (
    <div className="mx-auto max-w-6xl px-5 py-10">
      <h1 className="text-3xl font-semibold tracking-tight">Overview</h1>
      <p className="mt-3 text-muted-foreground">Placeholder — replace with admin overview.</p>
    </div>
  );
}
