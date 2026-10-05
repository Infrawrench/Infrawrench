import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { useAuth } from "@/lib/auth/AuthProvider";
import { createAuthRequest, redirectUri, workosDiscovery } from "@/lib/auth/workos";
import { registerForPush } from "@/lib/push";
import { colors, radii, spacing } from "@/lib/theme";

WebBrowser.maybeCompleteAuthSession();

export default function SignIn() {
  const router = useRouter();
  // Set when an org that requires single sign-on refused this session: sign
  // in again straight at that org's identity provider.
  const { organization } = useLocalSearchParams<{ organization?: string }>();
  const ssoOrg =
    typeof organization === "string" && /^org_[0-9A-Za-z]{10,64}$/.test(organization)
      ? organization
      : undefined;
  const { tokens, api, completeSignIn, sessionError } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSignIn() {
    setBusy(true);
    setError(null);
    try {
      const request = createAuthRequest(ssoOrg);
      const result = await request.promptAsync(workosDiscovery);
      if (result.type !== "success" || !result.params.code) {
        if (result.type === "error") setError(result.error?.message ?? "Sign-in failed");
        return;
      }
      // A missing or mismatched state means the callback wasn't ours: refuse it.
      if (result.params.state !== request.state) {
        setError("Sign-in failed: state mismatch");
        return;
      }
      if (!request.codeVerifier) {
        setError("Sign-in failed: missing PKCE verifier");
        return;
      }
      await tokens.exchangeAuthorizationCode(result.params.code, request.codeVerifier);
      await completeSignIn();
      // Fire-and-forget: permission prompt + device registration.
      void registerForPush(api).catch(() => {});
      router.replace("/");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Sign-in failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Infrawrench</Text>
      <Text style={styles.subtitle}>
        {ssoOrg
          ? "This organization requires single sign-on. Sign in through your identity provider."
          : "Manage your infrastructure from anywhere."}
      </Text>
      <Pressable
        accessibilityRole="button"
        onPress={() => void handleSignIn()}
        disabled={busy}
        style={({ pressed }) => [styles.button, (pressed || busy) && styles.buttonPressed]}
      >
        <Text style={styles.buttonText}>
          {busy ? "Signing in…" : ssoOrg ? "Sign in with SSO" : "Sign in"}
        </Text>
      </Pressable>
      {/* Landing here because restoring the session failed reads as a random
          sign-out unless we say what actually went wrong. */}
      {!error && sessionError && (
        <Text style={styles.error}>Couldn&apos;t restore your session: {sessionError}</Text>
      )}
      {error && <Text style={styles.error}>{error}</Text>}
      {/* Callback URI is a debugging aid, not something a released build should surface. */}
      {__DEV__ && <Text style={styles.hint}>Redirects to {redirectUri} after WorkOS sign-in.</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
    alignItems: "center",
    justifyContent: "center",
    padding: spacing.xl,
    gap: spacing.md,
  },
  title: { color: colors.text, fontSize: 32, fontWeight: "700" },
  subtitle: { color: colors.textMuted, fontSize: 15, marginBottom: spacing.lg },
  button: {
    backgroundColor: colors.accent,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
    borderRadius: radii.md,
    minWidth: 220,
    alignItems: "center",
  },
  buttonPressed: { backgroundColor: colors.accentPressed, opacity: 0.9 },
  buttonText: { color: "#fff", fontSize: 16, fontWeight: "600" },
  error: { color: colors.danger, fontSize: 13, textAlign: "center" },
  hint: { color: colors.textFaint, fontSize: 11, position: "absolute", bottom: spacing.xl },
});
