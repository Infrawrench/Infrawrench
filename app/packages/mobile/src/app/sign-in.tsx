import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { useAuth } from "@/lib/auth/AuthProvider";
import { createAuthRequest, redirectUri, workosDiscovery } from "@/lib/auth/workos";
import { registerForPush } from "@/lib/push";
import { colors, radii, spacing } from "@/lib/theme";

WebBrowser.maybeCompleteAuthSession();

export default function SignIn() {
  const router = useRouter();
  const { tokens, api, completeSignIn } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSignIn() {
    setBusy(true);
    setError(null);
    try {
      const request = createAuthRequest();
      const result = await request.promptAsync(workosDiscovery);
      if (result.type !== "success" || !result.params.code) {
        if (result.type === "error") setError(result.error?.message ?? "Sign-in failed");
        return;
      }
      // A missing or mismatched state means the callback wasn't ours — refuse it.
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
      <Text style={styles.subtitle}>Manage your infrastructure from anywhere.</Text>
      <Pressable
        accessibilityRole="button"
        onPress={() => void handleSignIn()}
        disabled={busy}
        style={({ pressed }) => [styles.button, (pressed || busy) && styles.buttonPressed]}
      >
        <Text style={styles.buttonText}>{busy ? "Signing in…" : "Sign in"}</Text>
      </Pressable>
      {error && <Text style={styles.error}>{error}</Text>}
      <Text style={styles.hint}>Redirects to {redirectUri} after WorkOS sign-in.</Text>
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
