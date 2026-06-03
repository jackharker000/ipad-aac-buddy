import { createFileRoute, Link } from "@tanstack/react-router";
import {
  ArrowRight,
  Ear,
  ImageIcon,
  PlayCircle,
  Users,
  Volume2,
} from "lucide-react";

import { cn } from "@/lib/cn";

export const Route = createFileRoute("/_marketing/")({
  component: HomePage,
});

type MediaPlaceholderProps = {
  label: string;
  aspect?: string;
  kind?: "image" | "video";
  className?: string;
};

function MediaPlaceholder({
  label,
  aspect = "aspect-[4/3]",
  kind = "image",
  className,
}: MediaPlaceholderProps) {
  const Icon = kind === "video" ? PlayCircle : ImageIcon;
  return (
    <div
      className={cn(
        "flex w-full items-center justify-center rounded-2xl border-2 border-dashed border-[var(--line)] bg-[var(--sand-2)] p-6 text-center",
        aspect,
        className,
      )}
    >
      <div className="flex max-w-sm flex-col items-center gap-3">
        <Icon className="h-10 w-10 text-[var(--ink-soft)]/60" strokeWidth={1.5} />
        <p className="text-xs font-medium uppercase tracking-wider text-[var(--ink-soft)]">
          {label}
        </p>
      </div>
    </div>
  );
}

type FeatureCardProps = {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  description: string;
};

function FeatureCard({ icon: Icon, title, description }: FeatureCardProps) {
  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-[var(--line)] bg-white/70 p-6">
      <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[var(--coral-soft)] text-[var(--teal)]">
        <Icon className="h-5 w-5" />
      </div>
      <h3 className="text-lg font-semibold tracking-tight">{title}</h3>
      <p className="text-sm leading-relaxed text-[var(--ink-soft)]">{description}</p>
    </div>
  );
}

type StepProps = {
  number: number;
  title: string;
  description: string;
};

function Step({ number, title, description }: StepProps) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex h-10 w-10 items-center justify-center rounded-full bg-[var(--teal)] text-base font-semibold text-white">
        {number}
      </div>
      <h3 className="text-lg font-semibold tracking-tight">{title}</h3>
      <p className="text-sm leading-relaxed text-[var(--ink-soft)]">{description}</p>
    </div>
  );
}

type SmallFeatureProps = {
  title: string;
  description: string;
};

function SmallFeature({ title, description }: SmallFeatureProps) {
  return (
    <div className="rounded-2xl border border-[var(--line)] bg-white/70 p-5">
      <h4 className="text-base font-semibold tracking-tight">{title}</h4>
      <p className="mt-2 text-sm leading-relaxed text-[var(--ink-soft)]">{description}</p>
    </div>
  );
}

function HomePage() {
  return (
    <div className="text-[var(--ink)]">
      {/* 1. Hero */}
      <section className="mx-auto w-full max-w-6xl px-5 pt-16 pb-20 md:pt-24 md:pb-28">
        <div className="grid items-center gap-12 lg:grid-cols-2 lg:gap-16">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--teal)]">
              AAC copilot for iPad
            </p>
            <h1 className="mt-4 text-4xl font-semibold tracking-tight md:text-5xl">
              A voice for every conversation.
            </h1>
            <p className="mt-5 max-w-xl text-lg leading-relaxed text-[var(--ink-soft)]">
              Parley is an iPad copilot for people who can&apos;t speak easily. It
              listens to the room, understands who&apos;s talking, and offers
              tap-to-speak replies — out loud, in a voice that sounds like you.
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <Link
                to="/get-started"
                className="inline-flex items-center justify-center rounded-full bg-[var(--teal)] px-6 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-[var(--teal-dark)]"
              >
                Join the waitlist
              </Link>
              <Link
                to="/how-it-works"
                className="inline-flex items-center justify-center gap-1 rounded-full px-5 py-3 text-sm font-semibold text-[var(--ink)] transition hover:bg-[var(--sand-2)]"
              >
                See how it works
                <ArrowRight className="h-4 w-4" />
              </Link>
            </div>
            <p className="mt-6 text-sm text-[var(--ink-soft)]">
              Voice recognition runs on the iPad, not in the cloud.
            </p>
          </div>
          <div className="lg:pl-4">
            <MediaPlaceholder
              label="Screenshot — assets/screenshots/home-hero-cockpit.png"
              aspect="aspect-[4/3]"
            />
          </div>
        </div>
      </section>

      {/* 2. Problem + three-up cards */}
      <section className="mx-auto w-full max-w-6xl px-5 py-20 md:py-24">
        <div className="max-w-3xl">
          <h2 className="text-3xl font-semibold tracking-tight md:text-4xl">
            Conversations move fast. Parley keeps you in them.
          </h2>
          <p className="mt-5 text-lg leading-relaxed text-[var(--ink-soft)]">
            For someone who can&apos;t speak — or can&apos;t type quickly — the
            moment to reply is often gone before the words are ready. Parley
            closes that gap.
          </p>
        </div>
        <div className="mt-12 grid gap-5 md:grid-cols-3">
          <FeatureCard
            icon={Ear}
            title="Listens and understands"
            description="A live transcript of the room, so nothing is missed."
          />
          <FeatureCard
            icon={Users}
            title="Knows who's speaking"
            description="Recognises familiar voices and labels each line."
          />
          <FeatureCard
            icon={Volume2}
            title="Replies in your own voice"
            description="Tap a suggestion and Parley speaks it aloud in your cloned voice."
          />
        </div>
      </section>

      {/* 3. Demo video */}
      <section className="mx-auto w-full max-w-6xl px-5 py-20 md:py-24">
        <div className="mx-auto max-w-2xl text-center">
          <h2 className="text-3xl font-semibold tracking-tight md:text-4xl">
            See it in action
          </h2>
          <p className="mt-4 text-lg text-[var(--ink-soft)]">
            One conversation, start to finish.
          </p>
        </div>
        <div className="mx-auto mt-10 max-w-4xl">
          <MediaPlaceholder
            label="Video — assets/videos/parley-demo.mp4"
            aspect="aspect-video"
            kind="video"
          />
        </div>
      </section>

      {/* 4. How it works teaser */}
      <section className="mx-auto w-full max-w-6xl px-5 py-20 md:py-24">
        <h2 className="text-3xl font-semibold tracking-tight md:text-4xl">
          How a Parley conversation works
        </h2>
        <div className="mt-12 grid gap-10 md:grid-cols-2 md:gap-x-12 md:gap-y-10">
          <Step
            number={1}
            title="Set the scene"
            description="Tell Parley who's likely to be there."
          />
          <Step
            number={2}
            title="Press record"
            description="One big button. A live transcript appears."
          />
          <Step
            number={3}
            title="It knows who's speaking"
            description="Familiar voices get labelled automatically."
          />
          <Step
            number={4}
            title="Tap to reply"
            description="Suggested replies tuned to the moment — spoken in your own voice."
          />
        </div>
        <div className="mt-12">
          <Link
            to="/how-it-works"
            className="inline-flex items-center gap-1 text-sm font-semibold text-[var(--teal)] hover:text-[var(--teal-dark)]"
          >
            Read the full walkthrough
            <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
      </section>

      {/* 5. Features teaser */}
      <section className="mx-auto w-full max-w-6xl px-5 py-20 md:py-24">
        <h2 className="text-3xl font-semibold tracking-tight md:text-4xl">
          Built around what really helps.
        </h2>
        <div className="mt-10 rounded-2xl border border-[var(--line)] bg-white/70 p-8 md:p-10">
          <h3 className="text-xl font-semibold tracking-tight md:text-2xl">
            Speaker recognition that learns voices
          </h3>
          <p className="mt-4 max-w-3xl text-base leading-relaxed text-[var(--ink-soft)]">
            Most AAC apps treat every voice the same. Parley learns who&apos;s
            who — so suggestions match the conversation, not just the words.
          </p>
          <Link
            to="/features"
            className="mt-6 inline-flex items-center gap-1 text-sm font-semibold text-[var(--teal)] hover:text-[var(--teal-dark)]"
          >
            See all features
            <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
        <div className="mt-5 grid gap-5 md:grid-cols-3">
          <SmallFeature
            title="Context-aware suggestions"
            description="Replies that fit who you're with and what you're talking about."
          />
          <SmallFeature
            title="Speaks in your own voice"
            description="A cloned voice means every reply sounds like you, not a machine."
          />
          <SmallFeature
            title="Quick phrases & type-and-expand"
            description="A tap for the everyday answers, a short note when you need more."
          />
        </div>
      </section>

      {/* 6. Story teaser */}
      <section className="mx-auto w-full max-w-6xl px-5 py-20 md:py-24">
        <div className="grid items-center gap-12 lg:grid-cols-2 lg:gap-16">
          <div>
            <h2 className="text-3xl font-semibold tracking-tight md:text-4xl">
              It began with one man — and a refusal to let him be left out.
            </h2>
            <p className="mt-5 text-base leading-relaxed text-[var(--ink-soft)]">
              Parley was built for James, a non-speaking man with cerebral
              palsy. Every feature exists because something in a conversation
              almost didn&apos;t happen for him. We&apos;re now opening it to
              others who deserve to be heard the same way.
            </p>
            <blockquote className="mt-8 border-l-4 border-[var(--teal)] pl-5 text-xl italic leading-relaxed text-[var(--ink)] md:text-2xl">
              If it works for James, it can work for others who deserve to be
              heard.
            </blockquote>
            <Link
              to="/story"
              className="mt-8 inline-flex items-center gap-1 text-sm font-semibold text-[var(--teal)] hover:text-[var(--teal-dark)]"
            >
              Read our story
              <ArrowRight className="h-4 w-4" />
            </Link>
          </div>
          <div>
            <MediaPlaceholder
              label="Photo — assets/photos/james-using-parley.jpg (consent required before publishing)"
              aspect="aspect-[4/3]"
            />
          </div>
        </div>
      </section>

      {/* 7. Privacy strip */}
      <section className="bg-[var(--teal)] text-white">
        <div className="mx-auto w-full max-w-6xl px-5 py-20 md:py-24">
          <div className="max-w-3xl">
            <h2 className="text-3xl font-semibold tracking-tight text-white md:text-4xl">
              Your voice stays on your device.
            </h2>
            <p className="mt-5 text-lg leading-relaxed text-white/85">
              Speaker recognition happens on the iPad, not in the cloud. Your
              conversations live in local storage you control — and you can
              export or wipe everything any time.
            </p>
            <Link
              to="/privacy"
              className="mt-6 inline-flex items-center gap-1 text-sm font-semibold text-white underline underline-offset-4 hover:text-white/90"
            >
              Read our privacy approach
              <ArrowRight className="h-4 w-4" />
            </Link>
          </div>
        </div>
      </section>

      {/* 8. Get started CTA */}
      <section className="mx-auto w-full max-w-6xl px-5 py-20 md:py-24">
        <div className="mx-auto max-w-3xl rounded-3xl bg-[var(--coral-soft)] px-6 py-14 text-center md:px-12 md:py-16">
          <h2 className="text-3xl font-semibold tracking-tight md:text-4xl">
            Help us bring this to more non-speaking people.
          </h2>
          <p className="mx-auto mt-5 max-w-xl text-base leading-relaxed text-[var(--ink-soft)] md:text-lg">
            We&apos;re inviting a small first cohort of users and the people who
            support them. Tell us a little about who Parley would be for.
          </p>
          <div className="mt-8">
            <Link
              to="/get-started"
              className="inline-flex items-center justify-center rounded-full bg-[var(--teal)] px-6 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-[var(--teal-dark)]"
            >
              Join the waitlist
            </Link>
          </div>
        </div>
      </section>
    </div>
  );
}
