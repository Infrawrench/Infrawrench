import { Text, View } from "react-native";
import {
  formatApprovalExpiry,
  isApprovalExpired,
  type ApprovalDecision,
  type WorkflowApproval,
} from "@infrawrench/client-core";
import { Button } from "@/components/ui";
import { colors, radii, spacing } from "@/lib/theme";

/**
 * One pending `infra.waitForApproval(...)` request on a phone.
 *
 * The native counterpart of `@infrawrench/ui`'s `ApprovalCard` — mobile can't
 * load that component (it is DOM/Tailwind), so this mirrors its information
 * design instead: what is being asked, which workflow and run it blocks, how
 * the run was started, when the window closes, and the fact that letting it
 * close is itself a denial. Deciding is two taps, never one: the buttons only
 * open the confirmation the screen owns.
 */
export function ApprovalCard({
  approval,
  canDecide,
  deciding,
  highlighted = false,
  onDecide,
}: {
  approval: WorkflowApproval;
  /** Whether the viewer holds `workflows:approve`. */
  canDecide: boolean;
  /** True while this row's decision is in flight — disables both buttons. */
  deciding: boolean;
  /** The request the notification deep-linked to, pulled to the top. */
  highlighted?: boolean;
  onDecide: (decision: ApprovalDecision) => void;
}) {
  const expired = isApprovalExpired(approval);
  const expiresAtLabel = new Date(approval.expiresAt).toLocaleString();

  return (
    <View
      style={{
        backgroundColor: colors.surface,
        borderColor: highlighted ? colors.warning : colors.border,
        borderWidth: highlighted ? 1.5 : 1,
        borderRadius: radii.md,
        padding: spacing.lg,
        gap: spacing.sm,
      }}
    >
      {highlighted ? (
        <Text style={{ color: colors.warning, fontSize: 11, fontWeight: "600" }}>
          From your notification
        </Text>
      ) : null}

      <Text style={{ color: colors.warning, fontSize: 15, fontWeight: "600" }}>
        Approval needed: {approval.title}
      </Text>

      <Text style={{ color: expired ? colors.danger : colors.textMuted, fontSize: 12 }}>
        {formatApprovalExpiry(approval.expiresAt)} · {expiresAtLabel}
      </Text>

      <Text style={{ color: colors.textMuted, fontSize: 12 }}>
        {approval.workflowName ?? "Deleted workflow"} · run {approval.runId.slice(0, 8)} · requested{" "}
        {new Date(approval.createdAt).toLocaleString()}
      </Text>

      <Text style={{ color: colors.text, fontSize: 14 }}>{approval.message}</Text>

      <Text style={{ color: colors.textFaint, fontSize: 11 }}>
        No decision before the deadline counts as a denial and fails the run.
      </Text>

      {canDecide ? (
        <View style={{ flexDirection: "row", gap: spacing.sm, marginTop: spacing.xs }}>
          <Button
            label={deciding ? "Working…" : "Approve"}
            disabled={deciding}
            onPress={() => onDecide("approve")}
          />
          <Button
            label="Deny"
            variant="danger"
            disabled={deciding}
            onPress={() => onDecide("deny")}
          />
        </View>
      ) : null}
    </View>
  );
}
