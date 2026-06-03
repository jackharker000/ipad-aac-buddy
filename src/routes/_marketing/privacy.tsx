import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_marketing/privacy")({
  component: PrivacyPage,
});

function PrivacyPage() {
  return (
    <div className="mx-auto max-w-3xl px-5 py-16 md:py-24">
      <h1 className="text-3xl font-semibold tracking-tight md:text-4xl">Privacy &amp; safety</h1>
      <p className="mt-5 text-lg leading-relaxed text-[var(--ink-soft)]">
        Plain English first. A formal policy comes later. Here&apos;s what&apos;s actually true
        today.
      </p>

      <section className="mt-16 flex flex-col gap-5">
        <h2 className="text-xl font-semibold tracking-tight md:text-2xl">
          Voice recognition stays on the device
        </h2>
        <p className="text-base leading-relaxed text-[var(--ink-soft)]">
          The model that recognises voices runs on your iPad, not in the cloud. The voice samples
          and voiceprints it learns from stay in local storage on your device.
        </p>
      </section>

      <section className="mt-12 flex flex-col gap-5">
        <h2 className="text-xl font-semibold tracking-tight md:text-2xl">
          Signing in and joining the waitlist
        </h2>
        <p className="text-base leading-relaxed text-[var(--ink-soft)]">
          Account sign-in is handled by Google Firebase — you create an account with an email and
          password, and Firebase stores those credentials. If you join the waitlist, the details you
          share in that form are saved in our project&apos;s Firebase too. That&apos;s the only
          place your name and email live with us.
        </p>
      </section>

      <section className="mt-12 flex flex-col gap-5">
        <h2 className="text-xl font-semibold tracking-tight md:text-2xl">
          What uses the internet, and why
        </h2>
        <p className="text-base leading-relaxed text-[var(--ink-soft)]">
          Suggestion generation, transcript-to-text and your cloned voice need to call AI services
          over the internet — that&apos;s how those services work. The keys for those services stay
          on our server, not on your iPad. Nothing about your conversations is sold or used for
          advertising, by us or our providers.
        </p>
      </section>

      <section className="mt-12 flex flex-col gap-5">
        <h2 className="text-xl font-semibold tracking-tight md:text-2xl">
          Where your conversations live
        </h2>
        <p className="text-base leading-relaxed text-[var(--ink-soft)]">
          Today, your conversation history lives on your iPad. We&apos;re building optional cloud
          sync so you can keep your data across devices — when that&apos;s switched on, that history
          will be stored in our project&apos;s Firebase (Google). Either way, you can export your
          device data, or wipe everything with one button in Settings.
        </p>
      </section>

      <section className="mt-12 flex flex-col gap-5">
        <h2 className="text-xl font-semibold tracking-tight md:text-2xl">
          What you&apos;ll need to consent to
        </h2>
        <p className="text-base leading-relaxed text-[var(--ink-soft)]">
          We&apos;ll ask before we use anything identifiable in materials — a photo, a story, an
          example transcript. Default is private.
        </p>
      </section>

      <p className="mt-16 text-sm text-[var(--ink-soft)]">
        Questions? Email{" "}
        <a
          href="mailto:hello@parley.help"
          className="font-medium text-[var(--teal)] underline underline-offset-2 hover:text-[var(--teal-dark)]"
        >
          hello@parley.help
        </a>
        .
      </p>
    </div>
  );
}
