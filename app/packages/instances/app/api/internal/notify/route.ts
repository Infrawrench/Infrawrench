import { env, waitUntil } from "cloudflare:workers";
import { notifyChanges } from "@/lib/alerts";
import { refreshCatalog } from "@/lib/chat/catalog";

/**
 * POST /api/internal/notify: called by the bulk pricing sync
 * (.github/workflows/aws-bulk-pricing-sync.yml) after it loads new data into
 * the warehouse. Re-runs every watched view and emails confirmed subscribers
 * of the ones that changed, and rebuilds the chat's catalog of column values
 * (`lib/chat/catalog.ts`). Bearer `NOTIFY_SECRET`.
 */
function authorized(request: Request): boolean {
  const secret = env.NOTIFY_SECRET;
  const given = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (!secret || given.length !== secret.length) return false;
  // Constant time over equal lengths.
  let diff = 0;
  for (let i = 0; i < secret.length; i++) diff |= secret.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}

export async function POST(request: Request) {
  if (!authorized(request)) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const result = await notifyChanges();
  // After the version bump inside notifyChanges, so it is built for the new data.
  waitUntil(
    refreshCatalog().catch((error: unknown) => console.warn("catalog refresh failed", error)),
  );
  return Response.json(result);
}
