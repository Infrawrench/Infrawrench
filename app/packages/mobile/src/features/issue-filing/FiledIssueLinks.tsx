import { Pressable, StyleSheet, Text, View } from "react-native";
import * as Linking from "expo-linking";
import type {
  IssueLinksForSource,
  IssueStatusCategory,
  IssueStatusFields,
} from "@infrawrench/client-core";
import { colors } from "@/lib/theme";

/**
 * Where a finding was filed, with each issue's live status: the native
 * counterpart of the web `FileIssueButton`'s filed state plus
 * `IssueStatusBadge`. Read-only: a tap opens the issue in the tracker.
 */

const DOT: Record<IssueStatusCategory, string> = {
  todo: colors.textFaint,
  in_progress: colors.accent,
  done: colors.success,
  canceled: colors.textFaint,
};

const CATEGORY_LABEL: Record<IssueStatusCategory, string> = {
  todo: "To do",
  in_progress: "In progress",
  done: "Done",
  canceled: "Canceled",
};

/** The status dot and name; nothing until the first sync has said anything. */
export function IssueStatusChip({ link }: { link: IssueStatusFields }) {
  const category = link.statusCategory ?? null;
  if (!link.status && !category) return null;
  const label = link.status ?? (category ? CATEGORY_LABEL[category] : "");
  return (
    <View style={styles.chip}>
      <View
        style={[
          styles.dot,
          { backgroundColor: category ? DOT[category] : colors.textFaint },
          category === "canceled" ? styles.faded : null,
        ]}
      />
      <Text style={styles.chipText} numberOfLines={1}>
        {label}
        {link.assignee ? ` · ${link.assignee}` : ""}
      </Text>
    </View>
  );
}

/** Every tracker's link for one finding, each with its status. */
export function FiledIssueLinks({ links }: { links: IssueLinksForSource }) {
  if (!links.jira && !links.linear && !links.github) return null;
  return (
    <View style={styles.row}>
      {links.jira && (
        <Pressable
          accessibilityRole="link"
          style={styles.item}
          onPress={() => void Linking.openURL(links.jira!.issueUrl)}
        >
          <Text style={styles.link}>{links.jira.issueKey}</Text>
          <IssueStatusChip link={links.jira} />
        </Pressable>
      )}
      {links.linear && (
        <Pressable
          accessibilityRole="link"
          style={styles.item}
          onPress={() => void Linking.openURL(links.linear!.issueUrl)}
        >
          <Text style={styles.link}>{links.linear.issueIdentifier}</Text>
          <IssueStatusChip link={links.linear} />
        </Pressable>
      )}
      {links.github && (
        <Pressable
          accessibilityRole="link"
          style={styles.item}
          onPress={() => void Linking.openURL(links.github!.issueUrl)}
        >
          <Text style={styles.link}>#{links.github.issueNumber}</Text>
          <IssueStatusChip link={links.github} />
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", flexWrap: "wrap", gap: 10, marginTop: 2 },
  item: { flexDirection: "row", alignItems: "center", gap: 6 },
  link: { color: colors.accent, fontSize: 11, fontWeight: "600" },
  chip: { flexDirection: "row", alignItems: "center", gap: 4, flexShrink: 1 },
  dot: { width: 6, height: 6, borderRadius: 3 },
  faded: { opacity: 0.5 },
  chipText: { color: colors.textMuted, fontSize: 11 },
});
