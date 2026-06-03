import { ImageIcon, PlayCircle } from "lucide-react";

import { cn } from "@/lib/cn";

type Props = {
  label: string;
  aspect?: "video" | "[4/3]" | "[3/2]" | "square";
  className?: string;
};

const ASPECT_CLASS: Record<NonNullable<Props["aspect"]>, string> = {
  video: "aspect-video",
  "[4/3]": "aspect-[4/3]",
  "[3/2]": "aspect-[3/2]",
  square: "aspect-square",
};

export function MediaPlaceholder({ label, aspect = "[4/3]", className }: Props) {
  const isVideo = /video/i.test(label);
  const Icon = isVideo ? PlayCircle : ImageIcon;

  return (
    <div
      className={cn(
        "flex w-full items-center justify-center rounded-2xl border-2 border-dashed border-[var(--line)] bg-[var(--sand-2)] p-6 text-center",
        ASPECT_CLASS[aspect],
        className,
      )}
    >
      <div className="flex max-w-sm flex-col items-center gap-3">
        <Icon className="h-10 w-10 text-[var(--ink-soft)]/60" strokeWidth={1.5} />
        <p className="text-sm text-[var(--ink-soft)]">{label}</p>
      </div>
    </div>
  );
}
