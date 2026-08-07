import { Text, View } from "react-native";
import {
  formatElevationCountdown,
  formatGrantDuration,
  type AccessRequest,
} from "@infrawrench/client-core";
import { Button } from "@/components/ui";
import { colors, radii, spacing } from "@/lib/theme";

/**
 * One break-glass request on a phone.
 *
 * The native counterpart of the web section's row — mobile can't load that
 * component (it is DOM/Tailwind), so this mirrors its information design: who
 * is asking, for exactly which permissions, for how long, and why. The reason
 * gets the most prominent treatment on purpose: it is the thing an approver is
 * actually deciding on, and a card that leads with the permission strings
 * invites approving on pattern-match.
 *
 * Deciding is two taps, never one — the buttons only open the confirmation the
 * screen owns.
 */
export function AccessRequestCard({
  request,
  canDecide,
  deciding,
  highlighted = false,
  onDecide,
}: {
  request: AccessRequest;
  /** Whether the viewer holds `access:approve`. */
  canDecide: boolean;
  /** True while this row's decision is in flight — disables both buttons. */
  deciding: boolean;
  /** The request the notification deep-linked to, pulled to the top. */
  highlighted?: boolean;
  onDecide: (decision: "approve" | "deny") => void;
}) {
  const live = request.active;
  return (
    <View
      style={{
        backgroundColor: colors.surface,
        borderColor: highlighted || live ? colors.warning : colors.border,
        borderWidth: highlighted || live ? 1.5 : 1,
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
        {request.userName ?? "A member"} is asking for elevated access
      </Text>

      <Text style={{ color: colors.text, fontSize: 14 }}>{request.reason}</Text>

      <Text style={{ color: colors.textMuted, fontSize: 12 }}>
        {request.permissions.join(", ")}
      </Text>

      <Text style={{ color: colors.textMuted, fontSize: 12 }}>
        {live && request.grantExpiresAt
          ? `Live — ${formatElevationCountdown(request.grantExpiresAt)}`
          : `${formatGrantDuration(request.durationMinutes)} if granted · request ${formatElevationCountdown(request.expiresAt)}`}
      </Text>

      {!live ? (
        <Text style={{ color: colors.textFaint, fontSize: 11 }}>
          No decision before the deadline counts as a denial.
        </Text>
      ) : null}

      {canDecide && !live ? (
        <View style={{ flexDirection: "row", gap: spacing.sm, marginTop: spacing.xs }}>
          <Button
            label={deciding ? "Working…" : "Approve"}
            disabled={deciding}
            onPress={() => onDecide("approve")}
          />
          <Button
            label="Deny"
            variant="secondary"
            disabled={deciding}
            onPress={() => onDecide("deny")}
          />
        </View>
      ) : null}

      {canDecide && live ? (
        <View style={{ marginTop: spacing.xs }}>
          <Button
            label={deciding ? "Working…" : "End now"}
            variant="secondary"
            disabled={deciding}
            onPress={() => onDecide("deny")}
          />
        </View>
      ) : null}
    </View>
  );
}
