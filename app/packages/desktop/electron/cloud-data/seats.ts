import { ipcMain } from "electron";
import { cloudFetch } from "./shared";

// SaaS seats, cloud mode only: the inventory is collected by the cloud
// poller from the org's connected accounts, so there is no local
// counterpart. Removal goes through the server route, which owns the change
// freeze, the audit row and the realized-savings capture.

/**
 * `cloudFetch` throws "Cloud request failed: <status> <path> <body>"; the
 * Seats row shows a refusal (a freeze, a provider error) verbatim, so pull
 * the server's `{ error }` back out of the body.
 */
function serverError(err: unknown): Error {
  const text = err instanceof Error ? err.message : String(err);
  const start = text.indexOf("{");
  if (start >= 0) {
    try {
      const parsed = JSON.parse(text.slice(start)) as { error?: unknown };
      if (typeof parsed.error === "string") return new Error(parsed.error);
    } catch {
      // Not a JSON body: keep the original message.
    }
  }
  return err instanceof Error ? err : new Error(text);
}

async function withServerMessage<T>(request: Promise<T>): Promise<T> {
  try {
    return await request;
  } catch (err) {
    throw serverError(err);
  }
}

ipcMain.handle("cloud_seats_list", async (_e, { orgId }: { orgId: string }) => {
  return cloudFetch(orgId, "/seats");
});

ipcMain.handle("cloud_seats_refresh", async (_e, { orgId }: { orgId: string }) => {
  return withServerMessage(cloudFetch(orgId, "/seats/refresh", { method: "POST" }));
});

ipcMain.handle(
  "cloud_seats_remove",
  async (_e, { orgId, seatId }: { orgId: string; seatId: string }) => {
    return withServerMessage(
      cloudFetch(orgId, `/seats/${encodeURIComponent(seatId)}/remove`, { method: "POST" }),
    );
  },
);

ipcMain.handle(
  "cloud_seats_update_settings",
  async (_e, { orgId, inactiveDays }: { orgId: string; inactiveDays: number }) => {
    return withServerMessage(
      cloudFetch(orgId, "/seats/settings", {
        method: "PUT",
        body: JSON.stringify({ inactiveDays }),
      }),
    );
  },
);
