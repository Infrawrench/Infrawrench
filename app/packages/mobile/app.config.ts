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
  // EAS account that owns the project and its push/store credentials. Pinned
  // because the signed-in user can also see the personal `astrid_infrawrench`
  // account, and EAS refuses to guess between them.
  owner: "infrawrench",
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
      // Required for getExpoPushTokenAsync. Hardcoded rather than env-only: the
      // project id is public (it ships in the app manifest), and EAS Build sets
      // EAS_BUILD_PROJECT_ID — never EAS_PROJECT_ID — so an env-only value is
      // empty on remote builds and push registration silently no-ops. The
      // override exists so a fork can point at its own EAS project.
      projectId: process.env.EAS_PROJECT_ID ?? "70615e11-f9fc-42a1-9a92-ffc906a049d2",
    },
  },
});
