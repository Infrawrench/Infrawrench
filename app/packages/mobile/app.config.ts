import type { ConfigContext, ExpoConfig } from "expo/config";

/**
 * Expo app config. The `infrawrench` scheme is shared with the desktop app on
 * purpose: desktop registers it on macOS/Windows/Linux, mobile on iOS/Android
 * — the platforms never overlap, and cross-surface links stay uniform. The
 * OAuth redirect URI `infrawrench://auth/callback` must be registered on the
 * WorkOS client (distinct from desktop's `infrawrench://callback`).
 */
export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: "Infrawrench",
  slug: "infrawrench",
  scheme: "infrawrench",
  version: "0.1.0",
  orientation: "portrait",
  userInterfaceStyle: "dark",
  newArchEnabled: true,
  ios: {
    bundleIdentifier: "com.infrawrench.mobile",
    supportsTablet: true,
    infoPlist: {
      UIBackgroundModes: ["remote-notification"],
    },
  },
  android: {
    package: "com.infrawrench.mobile",
    edgeToEdgeEnabled: true,
  },
  plugins: [
    "expo-router",
    "expo-secure-store",
    "expo-web-browser",
    [
      "expo-notifications",
      {
        defaultChannel: "incidents",
      },
    ],
  ],
  experiments: {
    typedRoutes: false,
  },
  extra: {
    eas: {
      // Set after `eas init`; required for getExpoPushTokenAsync.
      projectId: process.env.EAS_PROJECT_ID ?? "",
    },
  },
});
