/**
 * The push contract shared by the Expo transport (`expo-client.ts`) and the
 * org fan-out that resolves recipients (`dispatch.ts`).
 *
 * This module is a deliberate leaf: its only import is type-only, so the
 * transport can describe its message payload without depending on the module
 * that owns the database queries. Consumers that only need the contract —
 * `slack.ts`, `msteams.ts`, and anything reading `PushData` off a notification
 * — should import from here rather than from `dispatch.ts`, which pulls in
 * `db/client` and opens a connection at module scope.
 */
import type { PushNotificationData } from "@infrawrench/client-core";

/**
 * The deep-link contract with the mobile app. Notification title/body are
 * display-only; all routing keys live here.
 *
 * Defined in `@infrawrench/client-core` because the mobile app parses these
 * payloads back into routes (`mobile/src/lib/push.ts`); aliased here so the
 * two ends of the deep link cannot drift apart silently.
 */
export type PushData = PushNotificationData;

export type PushTrigger = "syncIncidents" | "budgetAlerts" | "workflowPages";

/**
 * What a Slack channel or Teams webhook can opt into. A superset of the push
 * triggers: the weekly digest is a scheduled summary, not an alert, so it goes
 * to team channels but never to a phone — mobile push keeps the three alert
 * triggers only.
 */
export type ChannelTrigger = PushTrigger | "weeklyDigest";

export interface PushMessage {
  title: string;
  body: string;
  data: PushData;
}

export interface PushResult {
  attempted: number;
  succeeded: number;
}
