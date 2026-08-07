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
import type { AlertTrigger, PushNotificationData } from "@infrawrench/client-core";

/**
 * The deep-link contract with the mobile app. Notification title/body are
 * display-only; all routing keys live here.
 *
 * Defined in `@infrawrench/client-core` because the mobile app parses these
 * payloads back into routes (`mobile/src/lib/push.ts`); aliased here so the
 * two ends of the deep link cannot drift apart silently.
 */
export type PushData = PushNotificationData;

/**
 * What can raise an alert. Aliased from the registry in
 * `client-core/src/alert-routing.ts` — the single list that used to be spelled
 * out here, in three database schemas and in three `TRIGGER_COLUMN` maps.
 *
 * `PushTrigger` and `ChannelTrigger` are the same type now. They were distinct
 * because the weekly digest could reach a channel but not a phone, and that is
 * still true — it is just expressed as `channelOnly` on the registry entry and
 * enforced in one place (`alerts/route.ts` drops a `push` destination for a
 * channel-only trigger) instead of by two type aliases that every call site had
 * to pick correctly between.
 */
export type PushTrigger = AlertTrigger;
export type ChannelTrigger = AlertTrigger;

export interface PushMessage {
  title: string;
  body: string;
  data: PushData;
}

export interface PushResult {
  attempted: number;
  succeeded: number;
}
