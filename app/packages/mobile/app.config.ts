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
  // Both icons derive from the website's `public/icon.png`, which is a rounded
  // badge floating on transparency. iOS rejects an alpha channel and masks its
  // own corners, so `icon.png` is the badge cropped to its bounds and made
  // opaque. Android composites `adaptiveIcon` itself, so that one keeps the
  // transparency and is inset to ~62% to survive the circular safe zone.
  icon: "./assets/icon.png",
  ios: {
    bundleIdentifier: "com.infrawrench.mobile",
    supportsTablet: true,
    infoPlist: {
      UIBackgroundModes: ["remote-notification"],
    },
    // Everything we push is an alert, so the server sends every notification at
    // `interruptionLevel: "time-sensitive"` (see server-core `push/dispatch.ts`).
    // Without this entitlement iOS accepts the payload and silently downgrades
    // it to `active`, which Focus and Do Not Disturb will swallow. It must stay
    // a static literal: eas-cli reads the introspected config to sync the
    // matching capability onto the Apple provisioning profile, and anything
    // computed in a modifier is invisible to it.
    entitlements: {
      "com.apple.developer.usernotifications.time-sensitive": true,
    },
  },
  android: {
    package: "com.infrawrench.mobile",
    edgeToEdgeEnabled: true,
    adaptiveIcon: {
      foregroundImage: "./assets/adaptive-icon.png",
      backgroundColor: "#0b0d10",
    },
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
