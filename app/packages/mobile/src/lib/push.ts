import * as Notifications from "expo-notifications";
import * as Device from "expo-device";
import * as SecureStore from "expo-secure-store";
import Constants from "expo-constants";
import { Platform } from "react-native";
import {
  registerPushToken,
  unregisterPushDevice,
  listPushDevices,
  type CloudFetch,
  type PushNotificationData,
} from "@infrawrench/client-core";

/**
 * Push registration lifecycle. Registration runs after sign-in (and again on
 * token rotation); the stored device id lets sign-out remove exactly this
 * device server-side. Notification `data` payloads deep-link via
 * `pushDataToPath` — the client mirror of server-core's PushData contract.
 */

const DEVICE_ID_KEY = "cloud_push_device_id";
const LAST_TOKEN_KEY = "cloud_push_token";

/** Show alerts for foreground notifications too. */
export function configureNotificationHandler(): void {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: false,
      shouldSetBadge: false,
    }),
  });
}

let registering = false;
let warnedNoProjectId = false;

export async function registerForPush(api: CloudFetch): Promise<boolean> {
  if (!Device.isDevice) return false; // simulators have no push tokens

  const projectId: string | undefined =
    (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)?.eas?.projectId ||
    undefined;
  if (!projectId) {
    // Dev builds without EAS config: getExpoPushTokenAsync would throw.
    if (!warnedNoProjectId) {
      warnedNoProjectId = true;
      console.warn(
        "[push] No EAS projectId configured (set EAS_PROJECT_ID or run `eas init`); skipping push registration.",
      );
    }
    return false;
  }

  // getExpoPushTokenAsync re-emits the device token, which would re-trigger
  // watchPushTokenRotation's listener mid-registration — guard against that.
  if (registering) return false;
  registering = true;
  try {
    const existing = await Notifications.getPermissionsAsync();
    let status = existing.status;
    if (status !== "granted") {
      status = (await Notifications.requestPermissionsAsync()).status;
    }
    if (status !== "granted") return false;

    if (Platform.OS === "android") {
      await Notifications.setNotificationChannelAsync("incidents", {
        name: "Incidents & alerts",
        importance: Notifications.AndroidImportance.HIGH,
        sound: "default",
      });
    }

    const token = (await Notifications.getExpoPushTokenAsync({ projectId })).data;

    const lastToken = await SecureStore.getItemAsync(LAST_TOKEN_KEY);
    const deviceId = await SecureStore.getItemAsync(DEVICE_ID_KEY);
    if (token === lastToken && deviceId) return true; // already registered

    const res = await registerPushToken(api, {
      expoPushToken: token,
      platform: Platform.OS === "ios" ? "ios" : "android",
      ...(Device.deviceName ? { deviceName: Device.deviceName } : {}),
    });
    if (!res) return false;
    await SecureStore.setItemAsync(DEVICE_ID_KEY, res.id);
    await SecureStore.setItemAsync(LAST_TOKEN_KEY, token);
    return true;
  } finally {
    registering = false;
  }
}

/** Re-register when Expo rotates the push token. */
export function watchPushTokenRotation(api: CloudFetch): () => void {
  // Fetching the Expo push token re-emits the current device token, so a
  // naive listener re-registers in an infinite loop. Only react when the
  // native token actually changes.
  let lastNativeToken: string | null = null;
  const sub = Notifications.addPushTokenListener((devicePushToken) => {
    const data =
      typeof devicePushToken.data === "string"
        ? devicePushToken.data
        : JSON.stringify(devicePushToken.data);
    if (data === lastNativeToken) return;
    lastNativeToken = data;
    void registerForPush(api).catch(() => {});
  });
  return () => sub.remove();
}

export async function unregisterCurrentDevice(api: CloudFetch): Promise<void> {
  const deviceId = await SecureStore.getItemAsync(DEVICE_ID_KEY);
  if (!deviceId) return;
  // Server first — if the call fails the device id survives for a retry.
  await unregisterPushDevice(api, deviceId);
  await SecureStore.deleteItemAsync(DEVICE_ID_KEY);
  await SecureStore.deleteItemAsync(LAST_TOKEN_KEY);
}

export { listPushDevices };

/**
 * Map a notification payload to an expo-router path. Sync incidents land on
 * the failing account; budget breaches land on the org home (budgets live on
 * the home surface); tests land on the org home.
 */
export function pushDataToPath(data: PushNotificationData): string {
  switch (data.type) {
    case "sync_incident":
      return `/org/${data.orgId}/accounts/${data.accountId}`;
    case "budget_breach":
      return `/org/${data.orgId}`;
    case "test":
      return `/org/${data.orgId}`;
    default:
      return "/";
  }
}

export function parsePushData(raw: unknown): PushNotificationData | null {
  if (!raw || typeof raw !== "object") return null;
  const data = raw as Record<string, unknown>;
  if (typeof data.type !== "string" || typeof data.orgId !== "string") return null;
  // Type-specific required fields — a malformed payload must not deep-link
  // to a path containing "undefined".
  if (data.type === "sync_incident" && typeof data.accountId !== "string") return null;
  return data as unknown as PushNotificationData;
}
