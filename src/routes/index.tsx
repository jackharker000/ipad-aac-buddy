import { createFileRoute } from "@tanstack/react-router";
import { Link } from "@tanstack/react-router";
import { useLiveQuery } from "dexie-react-hooks";
import { db } from "@/lib/db";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Mic, Settings as SettingsIcon, MapPin, Users, Brain } from "lucide-react";

export const Route = createFileRoute("/")({
  component: Index,
});

function Index() {
  const recent = useLiveQuery(
    () => db.conversations.orderBy("started_at").reverse().limit(5).toArray(),
    [],
  );
  const peopleCount = useLiveQuery(() => db.people.count(), []) ?? 0;
  const placesCount = useLiveQuery(() => db.places.count(), []) ?? 0;
  const memoriesCount = useLiveQuery(() => db.memories.count(), []) ?? 0;

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="mx-auto max-w-3xl px-6 py-10">
        <header className="flex items-center justify-between">
          <div>
            <h1 className="text-4xl font-semibold tracking-tight">
              AAC Copilot
            </h1>
            <p className="mt-1 text-muted-foreground">
              Your conversation, ready when you are.
            </p>
          </div>
          <Link
            to="/settings"
            className="rounded-full p-3 hover:bg-secondary transition-colors"
            aria-label="Settings"
          >
            <SettingsIcon className="size-6" />
          </Link>
        </header>

        <Link to="/conversation/new">
          <Card className="mt-8 flex min-h-[180px] cursor-pointer items-center justify-center gap-4 rounded-3xl border-0 bg-primary p-8 text-primary-foreground shadow-lg transition-transform hover:scale-[1.01] active:scale-[0.99]">
            <Mic className="size-10" />
            <span className="text-3xl font-semibold">Start Conversation</span>
          </Card>
        </Link>

        <div className="mt-6 grid grid-cols-3 gap-3">
          <StatCard icon={<Users className="size-5" />} label="People" value={peopleCount} />
          <StatCard icon={<MapPin className="size-5" />} label="Places" value={placesCount} />
          <StatCard icon={<Brain className="size-5" />} label="Memories" value={memoriesCount} />
        </div>

        <section className="mt-10">
          <h2 className="text-lg font-semibold">Recent</h2>
          <div className="mt-3 space-y-3">
            {recent === undefined && (
              <p className="text-sm text-muted-foreground">Loading…</p>
            )}
            {recent && recent.length === 0 && (
              <Card className="p-6 text-sm text-muted-foreground">
                No conversations yet. Tap "Start Conversation" to begin.
              </Card>
            )}
            {recent?.map((c) => (
              <Card key={c.id} className="p-5">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-sm text-muted-foreground">
                    {new Date(c.started_at).toLocaleString()}
                  </span>
                  {c.ended_at && (
                    <span className="text-xs text-muted-foreground">
                      {Math.round((c.ended_at - c.started_at) / 60000)} min
                    </span>
                  )}
                </div>
                {c.summary ? (
                  <p className="mt-2 text-base leading-snug">{c.summary}</p>
                ) : (
                  <p className="mt-2 text-sm italic text-muted-foreground">
                    {c.ended_at ? "Summary unavailable" : "In progress…"}
                  </p>
                )}
              </Card>
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}

function StatCard({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
}) {
  return (
    <Card className="flex flex-col items-start gap-1 rounded-2xl p-4">
      <div className="text-muted-foreground">{icon}</div>
      <div className="text-2xl font-semibold">{value}</div>
      <div className="text-xs uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
    </Card>
  );
}
