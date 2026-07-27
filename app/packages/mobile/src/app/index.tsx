import { useEffect, useState } from "react";
import { Redirect, useRouter } from "expo-router";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { useAuth } from "@/lib/auth/AuthProvider";
import { colors, spacing } from "@/lib/theme";

/** How long to spin before admitting something is wrong and offering a way out. */
const STUCK_AFTER_MS = 20_000;

export default function Index() {
  const router = useRouter();
  const { state, orgId } = useAuth();
  const [stuck, setStuck] = useState(false);

  useEffect(() => {
    if (state !== "loading") return;
    const timer = setTimeout(() => setStuck(true), STUCK_AFTER_MS);
    return () => clearTimeout(timer);
  }, [state]);

  if (state === "loading") {
    // Restoring the session is bounded by request timeouts now, but a spinner
    // with no exit is the worst failure mode a launch screen can have — if we
    // are somehow still here, say so and offer the door.
    return (
      <View style={styles.container}>
        <ActivityIndicator color={colors.accent} />
        {stuck && (
          <>
            <Text style={styles.text}>
              Still trying to restore your session. Your connection may be down.
            </Text>
            <Pressable accessibilityRole="button" onPress={() => router.replace("/sign-in")}>
              <Text style={styles.action}>Go to sign-in</Text>
            </Pressable>
          </>
        )}
      </View>
    );
  }
  if (state === "signed-out") return <Redirect href="/sign-in" />;
  if (!orgId) return <Redirect href="/select-org" />;
  return <Redirect href={`/org/${orgId}`} />;
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.background,
    gap: spacing.md,
    padding: spacing.xl,
  },
  text: { color: colors.textMuted, fontSize: 13, textAlign: "center" },
  action: { color: colors.accent, fontSize: 15, fontWeight: "600" },
});
