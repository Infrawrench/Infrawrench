import { Alert, Pressable } from "react-native";
import { colors } from "@/lib/theme";
import { WarningIcon } from "./icons";

/**
 * The native counterpart of `IssueIndicator` in `@infrawrench/ui`: a warning
 * triangle shown only when something needs attention. There is no hover on a
 * phone, so tapping it says why.
 */
export function IssueIndicator({
  reason,
  tone = "warning",
  size = 14,
}: {
  reason: string;
  tone?: "warning" | "danger";
  size?: number;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={reason}
      hitSlop={8}
      onPress={() => Alert.alert(reason)}
    >
      <WarningIcon color={tone === "danger" ? colors.danger : colors.warning} size={size} />
    </Pressable>
  );
}
