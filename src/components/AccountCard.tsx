import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { LogOut, Cloud, Loader2, ShieldCheck } from "lucide-react";
import { isFirebaseConfigured } from "@/integrations/firebase/client";
import { signOutAndClear } from "@/components/AuthGate";
import { whoami } from "@/lib/account.functions";
import { flushPush } from "@/lib/cloud-sync";
import { toast } from "sonner";

export function AccountCard() {
  // Local-first / anonymous mode: when Firebase isn't configured on the
  // deploy, this whole card has nothing to render (there's no account to show).
  if (!isFirebaseConfigured()) return null;
  return <AccountCardContent />;
}

function AccountCardContent() {
  const [busy, setBusy] = useState(false);
  const [backingUp, setBackingUp] = useState(false);
  const whoamiFn = useServerFn(whoami);

  const { data: me, isLoading } = useQuery({
    queryKey: ["whoami"],
    queryFn: () => whoamiFn(),
    staleTime: 5 * 60 * 1000,
  });

  async function backupNow() {
    setBackingUp(true);
    try {
      await flushPush();
      toast.success("Backed up to the cloud");
    } catch {
      toast.error("Backup failed");
    } finally {
      setBackingUp(false);
    }
  }

  async function handleSignOut() {
    setBusy(true);
    try {
      await signOutAndClear();
      window.location.reload();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="p-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-lg font-semibold">
            Account &amp; cloud backup
            {me?.isAdmin && (
              <span className="inline-flex items-center gap-1 rounded-full border border-[var(--accent)]/50 bg-[var(--accent)]/15 px-2 py-0.5 text-xs font-medium text-foreground">
                <ShieldCheck className="size-3" /> Admin
              </span>
            )}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Signed in as{" "}
            {isLoading ? (
              <Skeleton className="inline-block h-4 w-40 align-middle" />
            ) : (
              <span className="font-medium text-foreground">
                {me?.displayName || me?.email || "…"}
                {me?.displayName && me?.email ? (
                  <span className="font-normal text-muted-foreground"> ({me.email})</span>
                ) : null}
              </span>
            )}
            . Your data syncs to the cloud automatically — sign in with the same email on any other
            device to see it there.
          </p>
        </div>
        <div className="flex flex-shrink-0 flex-wrap gap-2">
          {me?.isAdmin && (
            <Button asChild variant="outline" className="gap-2">
              <Link to="/admin">
                <ShieldCheck className="size-4" />
                Admin
              </Link>
            </Button>
          )}
          <Button variant="secondary" onClick={backupNow} disabled={backingUp} className="gap-2">
            {backingUp ? <Loader2 className="size-4 animate-spin" /> : <Cloud className="size-4" />}
            Back up now
          </Button>
          <Button variant="outline" onClick={handleSignOut} disabled={busy} className="gap-2">
            {busy ? <Loader2 className="size-4 animate-spin" /> : <LogOut className="size-4" />}
            Sign out
          </Button>
        </div>
      </div>
    </Card>
  );
}
