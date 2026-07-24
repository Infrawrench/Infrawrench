import { Alert, FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { useAuth } from "@/lib/auth/AuthProvider";
import { colors, radii, spacing } from "@/lib/theme";

export default function SelectOrg() {
  const router = useRouter();
  const { orgs, selectOrg, signOut } = useAuth();

  return (
    <View style={styles.container}>
      <FlatList
        data={orgs}
        keyExtractor={(o) => o.id}
        contentContainerStyle={{ padding: spacing.lg, gap: spacing.sm }}
        ListEmptyComponent={
          <Text style={styles.empty}>
            You don't belong to any organizations yet. Create one on the web app first.
          </Text>
        }
        renderItem={({ item }) => (
          <Pressable
            accessibilityRole="button"
            style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
            onPress={() => {
              void selectOrg(item.id)
                .then(() => router.replace(`/org/${item.id}`))
                .catch((e: unknown) =>
                  Alert.alert(
                    "Failed to select organization",
                    e instanceof Error ? e.message : "Unknown error",
                  ),
                );
            }}
          >
            <Text style={styles.name}>{item.displayName}</Text>
            <Text style={styles.role}>{item.role}</Text>
          </Pressable>
        )}
      />
      <Pressable
        accessibilityRole="button"
        onPress={() => {
          void signOut()
            .then(() => router.replace("/sign-in"))
            .catch((e: unknown) =>
              Alert.alert("Sign out failed", e instanceof Error ? e.message : "Unknown error"),
            );
        }}
        style={styles.signOut}
      >
        <Text style={styles.signOutText}>Sign out</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  row: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radii.md,
    padding: spacing.lg,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  rowPressed: { backgroundColor: colors.surfaceOverlay },
  name: { color: colors.text, fontSize: 16, fontWeight: "600" },
  role: { color: colors.textMuted, fontSize: 13 },
  empty: { color: colors.textMuted, textAlign: "center", marginTop: spacing.xl },
  signOut: { alignItems: "center", padding: spacing.lg },
  signOutText: { color: colors.danger, fontSize: 14 },
});
