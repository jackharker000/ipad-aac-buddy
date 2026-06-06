import { createFileRoute } from "@tanstack/react-router";

import { corsPreflight, withCors } from "@/lib/api-cors";

/**
 * Dynamic PWA manifest.
 *
 * The static `/manifest.webmanifest` is fine for first install — but the
 * iPad PWA stay-logged-in trick needs a per-user `start_url` baked into
 * the home-screen icon. When the user clicks "Generate iPad launch link"
 * in Settings, the cockpit swaps the `<link rel="manifest">` to point
 * here with `?key=…`; iOS then reads this response at "Add to Home
 * Screen" time and persists the device-keyed URL into the icon's launch
 * target forever (until the user revokes it).
 *
 * `key` is intentionally NOT validated against Firestore here — that
 * happens at `/api/autologin` time. This endpoint just templates the
 * value into start_url; a junk key gives a junk URL that 401s on
 * autologin, which the gateway handles by falling through to /login.
 *
 * `Cache-Control: no-store` forces iOS to fetch a fresh copy each time
 * the user installs, so two different keys produce two different icons
 * rather than racing the CDN.
 */

const APPLE_TOUCH_ICON = "/favicon.svg";

function manifestBody(key: string | null): Record<string, unknown> {
  const startUrl = key ? `/app?device_key=${encodeURIComponent(key)}` : "/app";
  return {
    id: "/app",
    name: "Parley — AAC copilot",
    short_name: "Parley",
    description:
      "An iPad AAC copilot that listens to the conversation, recognises who's talking, and offers tap-to-speak replies in your own voice.",
    start_url: startUrl,
    scope: "/",
    display: "standalone",
    display_override: ["fullscreen", "standalone"],
    orientation: "landscape",
    background_color: "#FAF8F5",
    theme_color: "#0E7C73",
    prefer_related_applications: false,
    icons: [
      { src: APPLE_TOUCH_ICON, sizes: "any", type: "image/svg+xml", purpose: "any" },
      { src: APPLE_TOUCH_ICON, sizes: "any", type: "image/svg+xml", purpose: "maskable" },
    ],
  };
}

export const Route = createFileRoute("/api/manifest")({
  server: {
    handlers: {
      OPTIONS: ({ request }) => corsPreflight(request),
      GET: ({ request }) => {
        const url = new URL(request.url);
        const rawKey = url.searchParams.get("key");
        const key = rawKey && rawKey.length > 0 && rawKey.length <= 256 ? rawKey : null;
        return new Response(JSON.stringify(manifestBody(key)), {
          status: 200,
          headers: withCors(
            {
              "content-type": "application/manifest+json",
              "cache-control": "no-store, max-age=0",
            },
            request,
          ),
        });
      },
    },
  },
});
