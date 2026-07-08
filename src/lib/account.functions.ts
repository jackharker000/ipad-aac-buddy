import { createServerFn } from "@tanstack/react-start";
import { requireUserOrLocal, serverFirebaseConfigured } from "./server/auth-guard";

export type WhoAmI = {
  userId: string | null;
  email: string | null;
  displayName: string | null;
  role: "user" | "admin";
  isAdmin: boolean;
  /** False on local-first dev deploys with no Firebase configured. */
  cloudEnabled: boolean;
};

/**
 * Identity + role for the signed-in user. Drives the account menu and whether
 * the Admin nav entry renders. The env allow-list (PARLEY_ADMIN_EMAILS)
 * bootstraps the first admin; the profiles/{uid}.role field is the durable
 * source. Firestore has no signup trigger, so this is also where a user's
 * `profiles` doc is auto-created on first call.
 */
export const whoami = createServerFn({ method: "GET" })
  .middleware([requireUserOrLocal])
  .handler(async ({ context }): Promise<WhoAmI> => {
    const userId = (context as { userId: string | null }).userId;
    if (!userId || !serverFirebaseConfigured()) {
      return {
        userId,
        email: null,
        displayName: null,
        role: "user",
        isAdmin: false,
        cloudEnabled: serverFirebaseConfigured(),
      };
    }
    const { adminDb, adminAuth } = await import("@/integrations/firebase/admin");
    const { FieldValue } = await import("firebase-admin/firestore");
    const ref = adminDb().collection("profiles").doc(userId);
    let snap = await ref.get();

    // Auto-create the profile on first sign-in (no signup trigger in Firestore).
    // Seed email/displayName from the auth record so the admin dashboard has
    // something human-readable without waiting for the user to fill it in.
    if (!snap.exists) {
      let email: string | null = null;
      let displayName: string | null = null;
      try {
        const rec = await adminAuth().getUser(userId);
        email = rec.email ?? null;
        displayName = rec.displayName ?? null;
      } catch {
        // Non-fatal: create the doc without the auth-derived fields.
      }
      await ref.set(
        {
          email,
          displayName,
          role: "user",
          createdAt: FieldValue.serverTimestamp(),
          lastActiveAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
      snap = await ref.get();
    }

    const data = (snap.data() ?? {}) as {
      email?: string | null;
      displayName?: string | null;
      role?: string;
    };

    // Touch last_active_at so the admin dashboard can show activity.
    void ref.set({ lastActiveAt: FieldValue.serverTimestamp() }, { merge: true }).catch(() => {});

    const allowList = (process.env.PARLEY_ADMIN_EMAILS ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    const email: string | null = data.email ?? null;
    const isAdmin =
      data.role === "admin" || Boolean(email && allowList.includes(email.toLowerCase()));

    return {
      userId,
      email,
      displayName: data.displayName ?? null,
      role: isAdmin ? "admin" : "user",
      isAdmin,
      cloudEnabled: true,
    };
  });
