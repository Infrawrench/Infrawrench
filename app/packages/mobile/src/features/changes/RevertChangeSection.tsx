import { useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  applyRevert,
  fetchRevertPreview,
  formatChangeValue,
  localRevertRefusal,
  type ResourceChangeEntry,
  type RevertFieldPlan,
  type RevertFieldStatus,
} from "@infrawrench/client-core";
import { useOrgApi } from "@/lib/auth/AuthProvider";
import { Button } from "@/components/ui";
import { colors, radii, spacing } from "@/lib/theme";

/**
 * Time-travel undo, the native way. The web and desktop surfaces open a modal;
 * a phone row is already an expanded detail, so the plan renders in place — tap
 * **Revert this change**, read what would happen field by field, then confirm.
 *
 * Everything that decides anything (which fields can go back, which already
 * did, which moved again since) is the server's plan from
 * `GET /changes/{id}/revert`, exactly as on the other two surfaces; the only
 * thing written twice is the markup, because `@infrawrench/ui` is DOM-only.
 */

const STATUS_LABELS: Record<RevertFieldStatus, string> = {
  revertible: "Will revert",
  "already-reverted": "No change needed",
  conflict: "Changed since",
  "not-writable": "Not writable",
  "provider-derived": "Provider-derived",
};

const STATUS_COLORS: Record<RevertFieldStatus, string> = {
  revertible: colors.success,
  "already-reverted": colors.textFaint,
  conflict: colors.warning,
  "not-writable": colors.textFaint,
  "provider-derived": colors.textFaint,
};

function PlanRow({ field }: { field: RevertFieldPlan }) {
  return (
    <View style={styles.planRow}>
      <View style={styles.planHeader}>
        <Text style={styles.fieldName}>{field.field}</Text>
        <Text style={[styles.status, { color: STATUS_COLORS[field.status] }]}>
          {STATUS_LABELS[field.status]}
        </Text>
      </View>
      <Text style={styles.fromValue}>{formatChangeValue(field.changedTo)}</Text>
      <Text style={styles.toValue}>→ {formatChangeValue(field.revertTo)}</Text>
      {field.status === "conflict" && (
        <Text style={styles.conflict}>Now holds {formatChangeValue(field.current)}</Text>
      )}
      <Text style={styles.reason}>{field.reason}</Text>
    </View>
  );
}

export function RevertChangeSection({
  entry,
  onReverted,
}: {
  entry: ResourceChangeEntry;
  /** Refetch the feed — the row's `revertedAt` and the resource both moved. */
  onReverted: () => void;
}) {
  const { api, orgId } = useOrgApi();
  const [open, setOpen] = useState(false);
  const refusal = localRevertRefusal(entry);

  const preview = useQuery({
    queryKey: ["change-revert-preview", orgId, entry.id],
    queryFn: () => fetchRevertPreview(api, orgId, entry.id),
    enabled: open && refusal === null,
  });

  const revert = useMutation({
    mutationFn: () => applyRevert(api, orgId, entry.id),
    onSuccess: onReverted,
  });

  if (refusal !== null) {
    return <Text style={styles.reason}>{refusal}</Text>;
  }

  if (!open) {
    return <Button label="Revert this change" variant="secondary" onPress={() => setOpen(true)} />;
  }

  if (revert.isSuccess) {
    const applied = revert.data?.appliedFields ?? [];
    return (
      <Text style={styles.reason}>
        Reverted {applied.join(", ") || "nothing"}. The next poll will record it as its own change
        event.
      </Text>
    );
  }

  const plan = preview.data?.plan ?? null;

  return (
    <View style={{ gap: spacing.sm }}>
      {preview.isLoading && <Text style={styles.reason}>Reading the current state…</Text>}
      {preview.isError && (
        <Text style={styles.error}>
          {preview.error instanceof Error ? preview.error.message : "Couldn't plan the revert."}
        </Text>
      )}
      {revert.isError && (
        <Text style={styles.error}>
          {revert.error instanceof Error ? revert.error.message : "The revert failed."}
        </Text>
      )}
      {plan?.blockedReason != null && <Text style={styles.reason}>{plan.blockedReason}</Text>}
      {plan?.fields.map((field) => (
        <PlanRow key={field.field} field={field} />
      ))}
      {plan?.revertible === true && (
        <Button
          label={
            revert.isPending ? "Reverting…" : `Revert ${plan.revertibleFields.length} field(s)`
          }
          disabled={revert.isPending}
          onPress={() => revert.mutate()}
        />
      )}
      <Button label="Cancel" variant="secondary" onPress={() => setOpen(false)} />
    </View>
  );
}

const styles = StyleSheet.create({
  planRow: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.sm,
    padding: spacing.sm,
    gap: 2,
  },
  planHeader: { flexDirection: "row", justifyContent: "space-between", gap: spacing.sm },
  fieldName: { color: colors.textSecondary, fontSize: 12, fontWeight: "600", flexShrink: 1 },
  status: { fontSize: 11, fontWeight: "600" },
  fromValue: { color: colors.textFaint, fontSize: 12, fontFamily: "monospace" },
  toValue: { color: colors.text, fontSize: 12, fontFamily: "monospace" },
  conflict: { color: colors.warning, fontSize: 12 },
  reason: { color: colors.textFaint, fontSize: 12 },
  error: { color: colors.danger, fontSize: 12 },
});
