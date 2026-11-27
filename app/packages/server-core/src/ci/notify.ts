/**
 * A runner telling the app that a run changed, so the app reads it at once
 * rather than on the poller's next pass.
 *
 * The poller's `ci` status pass follows every running run on a loop of its
 * own, but it shares its process with every account poll, and on the Lambda
 * poller each invocation stops it at the end of its window: finished runs
 * were recorded 2 to 71 seconds after their runner finished them
 * (2026-11-24). So each run is dispatched with `notify` (the runner's
 * README, "HTTP API"): the runner that has it posts to
 * `/api/ci-notify/runs/{id}` as its pipelines and jobs start and end, at
 * most once a second, and once it has ended and recorded its result. The
 * app then follows the run as the pass does (`syncRun`, `acceptRunNotice`
 * in `runs.ts`): the run's row and its GitHub checks change within a second
 * of the runner, and the pass stays the fallback for a notice that never
 * comes (a runner or proxy from before notices, an app it cannot reach).
 *
 * A notice is trusted with nothing: it only says "read run X now", and the
 * app reads X from the proxy as always. Its token is an HMAC of the run's
 * id under `CI_PROXY_KEY` (so no new secret and nothing stored per run),
 * which keeps anyone else from making the app read runs on their say-so.
 * Without `APP_URL`, or with one that is not `https` (the runners only post
 * to `https`), runs are sent without `notify` and followed by polling.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

import { appBaseUrl } from "../app-url.js";

/** The route a runner posts a run's notices to, before the run's id. */
export const CI_NOTIFY_PATH = "/api/ci-notify/runs";

/** Separates this key's use from the proxy key's own. */
const LABEL = "infrawrench ci run notice v1\n";

/** The token a runner sends with run `runId`'s notices, or `null` without `CI_PROXY_KEY`. */
export function noticeToken(runId: string): string | null {
  const secret = process.env["CI_PROXY_KEY"];
  if (!secret) return null;
  return createHmac("sha256", secret)
    .update(LABEL + runId)
    .digest("hex");
}

/** Whether `token` is run `runId`'s, compared in constant time. */
export function noticeTokenValid(runId: string, token: string): boolean {
  const want = noticeToken(runId);
  if (want === null || !/^[0-9a-f]{64}$/.test(token)) return false;
  return timingSafeEqual(Buffer.from(token, "hex"), Buffer.from(want, "hex"));
}

/** Where run `runId`'s notices go, or `null` when they cannot be sent. */
export function noticeTarget(runId: string): { url: string; token: string } | null {
  const base = appBaseUrl();
  if (!base?.startsWith("https://")) return null;
  const token = noticeToken(runId);
  if (!token) return null;
  return { url: `${base}${CI_NOTIFY_PATH}/${encodeURIComponent(runId)}`, token };
}

/**
 * Adds `notify` to a run's `POST /v1/runs` body. Returns whether it did. The
 * proxy sends it only to a runner that takes it, and never to a helper.
 */
export function withNotify(body: Record<string, unknown>, runId: string): boolean {
  const target = noticeTarget(runId);
  if (!target) return false;
  body["notify"] = target;
  return true;
}
