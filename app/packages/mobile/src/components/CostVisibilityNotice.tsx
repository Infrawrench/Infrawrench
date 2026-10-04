import { useQuery } from "@tanstack/react-query";
import { StyleSheet, Text, View } from "react-native";
import { fetchOrgPermissions } from "@infrawrench/client-core";
import { useOrgApi } from "@/lib/auth/AuthProvider";
import { colors, radii, spacing } from "@/lib/theme";

/**
 * Says so when the viewer's cost figures are scoped, so a total that is
 * smaller than a colleague's reads as "you see part of it" rather than a bug.
 * The server already narrows every number on this tab; this is only the
 * explanation. Scopes are edited on web or desktop (Settings → Cost
 * Visibility), never here.
 */
export function CostVisibilityNotice() {
  const { api, orgId } = useOrgApi();
  const query = useQuery({
    queryKey: ["org-permissions", orgId],
    queryFn: () => fetchOrgPermissions(api, orgId),
    staleTime: 5 * 60_000,
  });
  const summary = query.data?.costVisibility;
  if (!summary?.restricted) return null;
  const names = summary.sources
    .map((s) => s.label)
    .filter((l): l is string => !!l)
    .join(", ");
  return (
    <View style={styles.box}>
      <Text style={styles.heading}>Your cost view is scoped</Text>
      <Text style={styles.message}>
        These figures include only the spend you are allowed to see
        {names ? ` (set on ${names})` : ""}. Anomaly findings cover the whole organization and are
        hidden for scoped access.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  box: {
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceOverlay,
    borderRadius: radii.md,
    padding: spacing.md,
    gap: spacing.xs,
  },
  heading: { color: colors.text, fontWeight: "600" },
  message: { color: colors.textMuted, fontSize: 13 },
});
