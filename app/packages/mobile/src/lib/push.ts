import * as Notifications from "expo-notifications";
import * as Device from "expo-device";
import * as SecureStore from "expo-secure-store";
import Constants from "expo-constants";
import { Platform } from "react-native";
import {
  registerPushToken,
  unregisterPushDevice,
  type CloudFetch,
  type PushNotificationData,
} from "@infrawrench/client-core";
import { CRITICAL_ALERTS } from "../../env";

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

/**
 * iOS grants only the options present in the app's *first* authorization
 * prompt and never asks again, so `allowCriticalAlerts` has to ride along with
 * the initial request — it cannot be added once the user has answered.
 *
 * A build whose entitlements don't include critical alerts can't be granted it;
 * rather than rely on that being a silent no-op, fall back to the plain request
 * so a rejected option can't cost us ordinary notifications as well. Naming the
 * other three options is required once `ios` is passed — omitting them would
 * request *less* than the argument-free call does.
 */
async function requestPermissions(): Promise<Notifications.NotificationPermissionsStatus> {
  if (CRITICAL_ALERTS && Platform.OS === "ios") {
    try {
      return await Notifications.requestPermissionsAsync({
        ios: {
          allowAlert: true,
          allowBadge: true,
          allowSound: true,
          allowCriticalAlerts: true,
        },
      });
    } catch (err) {
      console.warn("[push] critical-alert permission request failed, asking without it:", err);
    }
  }
  return Notifications.requestPermissionsAsync();
}

export async function registerForPush(api: CloudFetch): Promise<boolean> {
  if (!Device.isDevice) return false; // simulators have no push tokens

  // `expoConfig` is absent in some build contexts (bare/standalone), where the
  // id comes through `easConfig` instead — check both before giving up.
  const projectId: string | undefined =
    (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)?.eas?.projectId ||
    Constants.easConfig?.projectId ||
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
      status = (await requestPermissions()).status;
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

/**
 * Map a notification payload to an expo-router path. Sync incidents land on
 * the failing account; workflow pages land on the workflow that raised them
 * (its run list is the first thing you want); budget breaches land on the
 * Costs tab, which lists every budget in the org whether or not a dashboard
 * shows it — the alert has to open something that contains the budget it is
 * about, and the Dashboards tab is a list of dashboards, not of budgets.
 * Tests and API pages land on the org root.
 */
export function pushDataToPath(data: PushNotificationData): string {
  switch (data.type) {
    case "sync_incident":
      return `/org/${data.orgId}/accounts/${data.accountId}`;
    case "workflow_page":
      return `/org/${data.orgId}/workflows/${data.workflowId}`;
    // API pages name a source Infrawrench has no page for, so the org home is
    // the closest thing to "where this alert came from".
    case "api_page":
      return `/org/${data.orgId}`;
    case "budget_breach":
      return `/org/${data.orgId}/costs`;
    case "test":
      return `/org/${data.orgId}`;
    default:
      return "/";
  }
}

/**
 * Validate a notification `data` blob against the server's `PushData` contract.
 *
 * This is a trust boundary — the payload arrives from the OS notification
 * centre, so it starts as `unknown` and every field is checked before it is
 * used. Each arm rebuilds the variant from validated pieces rather than
 * asserting the whole object, so an unrecognised `type`, a missing routing key,
 * or a field of the wrong primitive type yields `null` (the caller then skips
 * the deep link) instead of a path containing "undefined".
 */
export function parsePushData(raw: unknown): PushNotificationData | null {
  if (!raw || typeof raw !== "object") return null;
  const data: Record<string, unknown> = raw as Record<string, unknown>;
  const orgId = data["orgId"];
  if (typeof orgId !== "string") return null;

  switch (data["type"]) {
    case "sync_incident": {
      const accountId = data["accountId"];
      const resourceTypeId = data["resourceTypeId"];
      const incidentId = data["incidentId"];
      if (
        typeof accountId !== "string" ||
        typeof resourceTypeId !== "string" ||
        typeof incidentId !== "string"
      ) {
        return null;
      }
      return { type: "sync_incident", orgId, accountId, resourceTypeId, incidentId };
    }
    case "budget_breach": {
      const budgetId = data["budgetId"];
      const month = data["month"];
      const thresholdPercent = data["thresholdPercent"];
      if (
        typeof budgetId !== "string" ||
        typeof month !== "string" ||
        typeof thresholdPercent !== "number"
      ) {
        return null;
      }
      return { type: "budget_breach", orgId, budgetId, month, thresholdPercent };
    }
    case "workflow_page": {
      const workflowId = data["workflowId"];
      const runId = data["runId"];
      if (typeof workflowId !== "string") return null;
      return {
        type: "workflow_page",
        orgId,
        workflowId,
        ...(typeof runId === "string" ? { runId } : {}),
      };
    }
    case "api_page": {
      const source = data["source"];
      const key = data["key"];
      if (typeof source !== "string" || typeof key !== "string") return null;
      return { type: "api_page", orgId, source, key };
    }
    case "test":
      return { type: "test", orgId };
    default:
      return null;
  }
}
