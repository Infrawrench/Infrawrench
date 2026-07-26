/**
 * Minimal Expo Push API transport. Hand-rolled fetch (no expo-server-sdk),
 * matching the Twilio pager's raw-fetch precedent and keeping the poller
 * bundle dependency-free. https://docs.expo.dev/push-notifications/sending-notifications/
 */

import type { PushData } from "./dispatch";

export interface ExpoPushMessage {
  /** `ExponentPushToken[...]` */
  to: string;
  title: string;
  body: string;
  data: PushData;
  sound?: "default";
  channelId?: string;
  /**
   * `normal` is APNs priority 5 / FCM normal, `high` is APNs 10 / FCM high.
   * Omitting the field means `normal` on Android and `high` on iOS, so this is
   * only load-bearing for Android — but we set it explicitly rather than
   * inherit a platform default that could change under us.
   */
  priority?: "default" | "normal" | "high";
  /**
   * iOS only; maps to `UNNotificationInterruptionLevel`. `critical` needs an
   * Apple-approved entitlement — `time-sensitive` needs only the entitlement we
   * grant ourselves in `app.config.ts`.
   */
  interruptionLevel?: "passive" | "active" | "time-sensitive" | "critical";
}

export interface ExpoTicket {
  status: "ok" | "error";
  id?: string;
  message?: string;
  details?: { error?: string };
}

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
/** Expo accepts at most 100 messages per request. */
const CHUNK_SIZE = 100;
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Send messages in chunks of 100. Returns one ticket per message, aligned by
 * index with the input. A failed chunk request yields error tickets for every
 * message in that chunk rather than throwing, so callers can do per-device
 * bookkeeping uniformly.
 */
export async function sendExpoPush(messages: ExpoPushMessage[]): Promise<ExpoTicket[]> {
  const tickets: ExpoTicket[] = [];
  for (let i = 0; i < messages.length; i += CHUNK_SIZE) {
    const chunk = messages.slice(i, i + CHUNK_SIZE);
    tickets.push(...(await sendChunk(chunk)));
  }
  return tickets;
}

async function sendChunk(chunk: ExpoPushMessage[]): Promise<ExpoTicket[]> {
  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    const accessToken = process.env.EXPO_ACCESS_TOKEN;
    if (accessToken) headers.Authorization = `Bearer ${accessToken}`;

    const res = await fetch(EXPO_PUSH_URL, {
      method: "POST",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers,
      body: JSON.stringify(chunk),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Expo push ${res.status}: ${text.slice(0, 200)}`);
    }
    const json = (await res.json()) as { data?: ExpoTicket[] };
    const data = Array.isArray(json.data) ? json.data : [];
    // Defensive: if Expo returns fewer tickets than messages, pad with errors
    // so the index alignment callers rely on holds.
    while (data.length < chunk.length) data.push({ status: "error", message: "missing ticket" });
    return data;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return chunk.map(() => ({ status: "error", message }));
  }
}
