import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { getIdToken } from "@/lib/auth";
import { cn } from "@/lib/cn";

/**
 * Settings → Cloud sync → iPad home-screen launch keys.
 *
 * Reads each key's metadata from /api/device-keys/list and renders a
 * revoke button per row. The Generate flow is multi-step:
 *
 *   1. User taps Generate. We prompt for a friendly label.
 *   2. POST /api/device-keys/create returns `{ key, meta }`. The key
 *      value is held in component state and never persisted anywhere
 *      else — it's hidden from view by default but revealed in a
 *      preview field so the user can see what's about to be baked in.
 *   3. We replace the page's `<link rel="manifest">` with one pointing
 *      at /api/manifest?key=<key> so iOS's next "Add to Home Screen"
 *      sees the device-keyed start_url.
 *   4. Instruct the user to tap Share → Add to Home Screen NOW. After
 *      they confirm "I've added it", we restore the manifest link and
 *      drop the key from memory.
 *
 * Trade-off acknowledged in the UI: the resulting home-screen icon
 * skips all sign-in prompts. Anyone with the iPad (or who gets a
 * screenshot of the URL bar mid-launch) can act as the owner until the
 * key is revoked.
 */

type DeviceKeyMeta = {
  id: string;
  userId: string;
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
};

const DEFAULT_MANIFEST_HREF = "/manifest.webmanifest";

export function DeviceKeysCard() {
  const [keys, setKeys] = useState<DeviceKeyMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<"creating" | "revoking" | null>(null);
  const [label, setLabel] = useState("");
  const [pending, setPending] = useState<{ key: string; meta: DeviceKeyMeta } | null>(
    null,
  );
  const [revoking, setRevoking] = useState<DeviceKeyMeta | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const idToken = await getIdToken();
      if (!idToken) {
        setKeys([]);
        return;
      }
      const res = await fetch("/api/device-keys/list", {
        headers: { authorization: `Bearer ${idToken}` },
      });
      if (!res.ok) {
        setKeys([]);
        return;
      }
      const data = (await res.json()) as { keys?: DeviceKeyMeta[] };
      setKeys(data.keys ?? []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function handleGenerate() {
    if (busy) return;
    setBusy("creating");
    try {
      const idToken = await getIdToken();
      if (!idToken) {
        toast.error("You need to be signed in.");
        return;
      }
      const trimmedLabel = label.trim() || "iPad";
      const res = await fetch("/api/device-keys/create", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${idToken}`,
        },
        body: JSON.stringify({ label: trimmedLabel }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        toast.error(data.error ?? "Couldn't create the key.");
        return;
      }
      const data = (await res.json()) as { key: string; meta: DeviceKeyMeta };
      setPending(data);
      swapManifestLink(data.key);
      setLabel("");
      // Refresh the list in the background — the new row will appear
      // there with the same id once the user confirms.
      void refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't create the key.");
    } finally {
      setBusy(null);
    }
  }

  function handleDoneAdding() {
    setPending(null);
    restoreManifestLink();
    toast.success("Home-screen launch key ready. The icon stays signed in.");
  }

  function handleCancelPending() {
    setPending(null);
    restoreManifestLink();
    // Leave the row in Firestore — the user can still use the key by
    // visiting /app?device_key=<key> if they kept it elsewhere, and
    // they can revoke it from the list if not.
  }

  async function handleRevoke(meta: DeviceKeyMeta) {
    if (busy) return;
    setBusy("revoking");
    try {
      const idToken = await getIdToken();
      if (!idToken) {
        toast.error("You need to be signed in.");
        return;
      }
      const res = await fetch("/api/device-keys/revoke", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${idToken}`,
        },
        body: JSON.stringify({ id: meta.id }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        toast.error(data.error ?? "Couldn't revoke the key.");
        return;
      }
      toast.success(`Revoked "${meta.label}". The icon won't sign in anymore.`);
      await refresh();
    } finally {
      setBusy(null);
      setRevoking(null);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>iPad home-screen launch</CardTitle>
        <CardDescription>
          Bake a long-lived device key into your home-screen icon so the cockpit stays signed in
          even after Apple's 7-day cache purge. Tap Generate, then Add to Home Screen on the iPad
          you want it on.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {pending ? (
          <PendingPanel
            pending={pending}
            onDone={handleDoneAdding}
            onCancel={handleCancelPending}
          />
        ) : (
          <GeneratePanel
            label={label}
            onLabelChange={setLabel}
            busy={busy === "creating"}
            onGenerate={handleGenerate}
          />
        )}

        <div className="space-y-2 rounded-md border border-border bg-muted/40 p-3 text-sm">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            What this means
          </p>
          <p className="text-xs text-muted-foreground">
            The home-screen icon launches you straight into the cockpit with no password — the
            same way the iPad's own home screen does. Anyone with that iPad gets in too.
            If the iPad is lost or shared, revoke the matching key below; the icon will become
            inert immediately and ask for a normal sign-in instead.
          </p>
        </div>

        <KeyList
          loading={loading}
          keys={keys}
          activeId={pending?.meta.id ?? null}
          onRevoke={(meta) => setRevoking(meta)}
        />

        <ConfirmDialog
          open={Boolean(revoking)}
          onOpenChange={(o) => {
            if (!o) setRevoking(null);
          }}
          title={`Revoke "${revoking?.label ?? ""}"?`}
          description="The home-screen icon will stop signing in. You'll see the normal sign-in screen when you tap it next."
          confirmLabel="Revoke"
          destructive
          onConfirm={() => {
            if (revoking) return handleRevoke(revoking);
          }}
        />
      </CardContent>
    </Card>
  );
}

function GeneratePanel({
  label,
  onLabelChange,
  busy,
  onGenerate,
}: {
  label: string;
  onLabelChange: (v: string) => void;
  busy: boolean;
  onGenerate: () => void;
}) {
  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <Label htmlFor="device-key-label">Label (so you can tell devices apart)</Label>
        <Input
          id="device-key-label"
          placeholder="iPad Pro — James"
          value={label}
          onChange={(e) => onLabelChange(e.target.value)}
          disabled={busy}
          maxLength={80}
        />
      </div>
      <Button onClick={onGenerate} disabled={busy} className="min-h-[44px]">
        {busy ? "Generating…" : "Generate iPad launch link"}
      </Button>
    </div>
  );
}

function PendingPanel({
  pending,
  onDone,
  onCancel,
}: {
  pending: { key: string; meta: DeviceKeyMeta };
  onDone: () => void;
  onCancel: () => void;
}) {
  const previewKey = `${pending.key.slice(0, 6)}…${pending.key.slice(-4)}`;
  return (
    <div className="space-y-4 rounded-xl border border-[var(--teal)]/40 bg-[var(--teal)]/5 p-4">
      <div className="space-y-1">
        <p className="text-sm font-semibold text-[var(--ink)]">
          Add this iPad to your home screen now.
        </p>
        <p className="text-sm text-[var(--ink-soft)]">
          On the iPad you want to keep signed in, tap the Share icon (square with an up-arrow),
          then "Add to Home Screen". The icon it creates will skip the sign-in screen every time
          you launch it.
        </p>
      </div>
      <ol className="list-decimal space-y-1 pl-5 text-sm text-[var(--ink-soft)]">
        <li>Make sure you're on this iPad right now.</li>
        <li>Tap the Safari Share icon.</li>
        <li>Choose "Add to Home Screen".</li>
        <li>Confirm the name, then tap Add.</li>
      </ol>
      <div className="rounded-md bg-white/60 p-3 text-xs">
        <p className="font-mono text-[var(--ink-soft)]">
          Label: <span className="text-[var(--ink)]">{pending.meta.label}</span>
        </p>
        <p className="font-mono text-[var(--ink-soft)]">
          Key preview: <span className="text-[var(--ink)]">{previewKey}</span>
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button onClick={onDone} className="min-h-[44px]">
          I've added it
        </Button>
        <Button variant="outline" onClick={onCancel} className="min-h-[44px]">
          Cancel
        </Button>
      </div>
    </div>
  );
}

function KeyList({
  loading,
  keys,
  activeId,
  onRevoke,
}: {
  loading: boolean;
  keys: DeviceKeyMeta[];
  activeId: string | null;
  onRevoke: (meta: DeviceKeyMeta) => void;
}) {
  if (loading) {
    return <p className="text-xs text-muted-foreground">Loading device keys…</p>;
  }
  if (keys.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        No home-screen launch keys yet. Generate one to bake a sign-in-free icon onto an iPad.
      </p>
    );
  }
  return (
    <ul className="space-y-2">
      {keys.map((meta) => (
        <li
          key={meta.id}
          className={cn(
            "flex flex-wrap items-center justify-between gap-3 rounded-md border p-3 text-sm",
            meta.id === activeId
              ? "border-[var(--teal)]/40 bg-[var(--teal)]/5"
              : "border-border bg-background",
          )}
        >
          <div>
            <p className="font-medium text-[var(--ink)]">{meta.label || "(no label)"}</p>
            <p className="text-xs text-muted-foreground">
              Added {formatDate(meta.createdAt)} · Last used {formatRelative(meta.lastUsedAt)}
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => onRevoke(meta)}
            className="min-h-[40px]"
          >
            Revoke
          </Button>
        </li>
      ))}
    </ul>
  );
}

function swapManifestLink(key: string): void {
  if (typeof document === "undefined") return;
  const existing = document.querySelector<HTMLLinkElement>('link[rel="manifest"]');
  const target = `/api/manifest?key=${encodeURIComponent(key)}`;
  if (existing) {
    existing.dataset.parleyOriginal = existing.href;
    existing.href = target;
  } else {
    const link = document.createElement("link");
    link.rel = "manifest";
    link.href = target;
    link.dataset.parleyOriginal = "";
    document.head.appendChild(link);
  }
}

function restoreManifestLink(): void {
  if (typeof document === "undefined") return;
  const existing = document.querySelector<HTMLLinkElement>('link[rel="manifest"]');
  if (!existing) return;
  if (existing.dataset.parleyOriginal === "") {
    existing.parentElement?.removeChild(existing);
    return;
  }
  if (typeof existing.dataset.parleyOriginal === "string") {
    existing.href = existing.dataset.parleyOriginal;
    delete existing.dataset.parleyOriginal;
  } else {
    existing.href = DEFAULT_MANIFEST_HREF;
  }
}

function formatDate(iso: string): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString();
  } catch {
    return "—";
  }
}

function formatRelative(iso: string | null): string {
  if (!iso) return "never";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "never";
  const delta = Date.now() - t;
  if (delta < 60_000) return "just now";
  if (delta < 3_600_000) return `${Math.round(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.round(delta / 3_600_000)}h ago`;
  return `${Math.round(delta / 86_400_000)}d ago`;
}
