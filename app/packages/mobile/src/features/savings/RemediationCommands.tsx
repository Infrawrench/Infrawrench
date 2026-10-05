import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import {
  hasRemediation,
  orderedRemediationCommands,
  remediationScript,
  remediationToolLabel,
  type FindingRemediation,
} from "@infrawrench/client-core";
import { colors, radii, spacing } from "@/lib/theme";

/**
 * The native counterpart of the web/desktop Remediate panel: a "Commands"
 * disclosure under a finding row, listing the plugin's ready-to-run CLI
 * commands with a copy button each. Read-only like every savings surface on
 * mobile; it copies, it never runs anything. Renders nothing when the finding
 * has no commands.
 */
export function RemediationCommands({
  remediation,
}: {
  remediation: FindingRemediation | null | undefined;
}) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState<number | "all" | null>(null);
  if (!remediation || !hasRemediation(remediation)) return null;
  const commands = orderedRemediationCommands(remediation);

  function copy(text: string, key: number | "all") {
    void Clipboard.setStringAsync(text).then(() => {
      setCopied(key);
      setTimeout(() => setCopied((current) => (current === key ? null : current)), 1200);
    });
  }

  return (
    <View style={styles.wrap}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((v) => !v)}
        hitSlop={6}
      >
        <Text style={styles.toggle}>{open ? "Hide commands" : "Remediation commands"}</Text>
      </Pressable>
      {open && (
        <View style={styles.panel}>
          {remediation.iac && (
            <Text style={styles.iac}>
              Managed by Terraform at {remediation.iac.address}. Change the configuration instead:
              the next apply reverts a CLI change.
            </Text>
          )}
          {remediation.placeholders.map((p) => (
            <Text key={p.name} style={styles.muted}>
              Set ${p.name}: {p.description}
            </Text>
          ))}
          {commands.map((command, index) => (
            <View key={`${index}:${command.command}`} style={styles.command}>
              <Text style={styles.description}>
                {index + 1}. {remediationToolLabel(command.tool)}
                {command.destructive ? " · destructive" : ""} · {command.description}
              </Text>
              <View style={styles.codeRow}>
                <Text style={styles.code} selectable>
                  {command.command}
                </Text>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Copy command"
                  onPress={() => copy(command.command, index)}
                  hitSlop={6}
                >
                  <Text style={styles.copy}>{copied === index ? "Copied" : "Copy"}</Text>
                </Pressable>
              </View>
            </View>
          ))}
          <Pressable
            accessibilityRole="button"
            onPress={() => copy(remediationScript(remediation), "all")}
          >
            <Text style={styles.copy}>{copied === "all" ? "Copied" : "Copy all"}</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { paddingBottom: spacing.sm, gap: spacing.xs },
  toggle: { color: colors.accent, fontSize: 12, fontWeight: "500" },
  panel: {
    gap: spacing.sm,
    padding: spacing.sm,
    borderRadius: radii.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.background,
  },
  iac: { color: colors.warning, fontSize: 12 },
  muted: { color: colors.textMuted, fontSize: 11 },
  command: { gap: 2 },
  description: { color: colors.textSecondary, fontSize: 12 },
  codeRow: { flexDirection: "row", alignItems: "flex-start", gap: spacing.sm },
  code: { flex: 1, color: colors.text, fontSize: 11, fontFamily: "Menlo" },
  copy: { color: colors.accent, fontSize: 12, fontWeight: "500" },
});
