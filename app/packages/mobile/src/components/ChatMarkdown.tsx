import { Fragment } from "react";
import { Linking, StyleSheet, Text, View } from "react-native";
import { colors, radii, spacing } from "@/lib/theme";

/**
 * Markdown renderer for assistant chat messages — the native counterpart of
 * ui's ChatMarkdown (which is react-markdown and DOM-only). Hand-rolled for
 * the subset the model actually emits: headings, bullet/numbered lists,
 * blockquotes, fenced code, and inline bold / italic / code / links. Anything
 * else falls through as plain text.
 */
export function ChatMarkdown({ text }: { text: string }) {
  return <View style={{ gap: spacing.sm }}>{parseBlocks(text).map(renderBlock)}</View>;
}

type Block =
  | { kind: "code"; text: string }
  | { kind: "heading"; level: number; text: string }
  | { kind: "quote"; text: string }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "paragraph"; text: string };

function parseBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === "") {
      i++;
      continue;
    }
    if (line.startsWith("```")) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.startsWith("```")) code.push(lines[i++]!);
      i++; // closing fence (or EOF mid-stream)
      blocks.push({ kind: "code", text: code.join("\n") });
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push({ kind: "heading", level: heading[1]!.length, text: heading[2]! });
      i++;
      continue;
    }
    if (line.startsWith("> ")) {
      const quote: string[] = [];
      while (i < lines.length && lines[i]!.startsWith("> ")) quote.push(lines[i++]!.slice(2));
      blocks.push({ kind: "quote", text: quote.join("\n") });
      continue;
    }
    const bullet = /^\s*[-*]\s+/;
    const numbered = /^\s*\d+[.)]\s+/;
    if (bullet.test(line) || numbered.test(line)) {
      const ordered = numbered.test(line);
      const marker = ordered ? numbered : bullet;
      const items: string[] = [];
      while (i < lines.length && marker.test(lines[i]!)) {
        items.push(lines[i]!.replace(marker, ""));
        i++;
      }
      blocks.push({ kind: "list", ordered, items });
      continue;
    }
    const para: string[] = [line];
    i++;
    while (
      i < lines.length &&
      lines[i]!.trim() !== "" &&
      !lines[i]!.startsWith("```") &&
      !lines[i]!.startsWith("> ") &&
      !/^(#{1,6})\s/.test(lines[i]!) &&
      !bullet.test(lines[i]!) &&
      !numbered.test(lines[i]!)
    ) {
      para.push(lines[i++]!);
    }
    blocks.push({ kind: "paragraph", text: para.join("\n") });
  }
  return blocks;
}

function renderBlock(block: Block, key: number) {
  switch (block.kind) {
    case "code":
      return (
        <View key={key} style={styles.codeBlock}>
          <Text style={styles.codeText}>{block.text}</Text>
        </View>
      );
    case "heading":
      return (
        <Text key={key} style={[styles.heading, block.level === 1 && styles.headingLarge]}>
          {renderInline(block.text)}
        </Text>
      );
    case "quote":
      return (
        <View key={key} style={styles.quote}>
          <Text style={styles.quoteText}>{renderInline(block.text)}</Text>
        </View>
      );
    case "list":
      return (
        <View key={key} style={{ gap: spacing.xs }}>
          {block.items.map((item, j) => (
            <View key={j} style={styles.listItem}>
              <Text style={styles.listMarker}>{block.ordered ? `${j + 1}.` : "•"}</Text>
              <Text style={styles.text}>{renderInline(item)}</Text>
            </View>
          ))}
        </View>
      );
    case "paragraph":
      return (
        <Text key={key} style={styles.text}>
          {renderInline(block.text)}
        </Text>
      );
  }
}

/** Inline spans: `code`, **bold**, *italic*, [label](url). */
const INLINE = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|\[[^\]]+\]\((?:https?:\/\/)[^)\s]+\))/g;

function renderInline(text: string) {
  const parts = text.split(INLINE);
  return parts.map((part, i) => {
    if (part.startsWith("`") && part.endsWith("`")) {
      return (
        <Text key={i} style={styles.inlineCode}>
          {part.slice(1, -1)}
        </Text>
      );
    }
    if (part.startsWith("**") && part.endsWith("**")) {
      return (
        <Text key={i} style={styles.bold}>
          {part.slice(2, -2)}
        </Text>
      );
    }
    if (part.startsWith("*") && part.endsWith("*") && part.length > 2) {
      return (
        <Text key={i} style={styles.italic}>
          {part.slice(1, -1)}
        </Text>
      );
    }
    const link = /^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/.exec(part);
    if (link) {
      const url = link[2]!;
      return (
        <Text key={i} style={styles.link} onPress={() => void Linking.openURL(url)}>
          {link[1]}
        </Text>
      );
    }
    return <Fragment key={i}>{part}</Fragment>;
  });
}

const styles = StyleSheet.create({
  text: { color: colors.text, fontSize: 15, lineHeight: 21, flexShrink: 1 },
  bold: { fontWeight: "600" },
  italic: { fontStyle: "italic" },
  link: { color: colors.accent, textDecorationLine: "underline" },
  inlineCode: {
    fontFamily: "Menlo",
    fontSize: 13,
    color: colors.textSecondary,
    backgroundColor: colors.surfaceOverlay,
  },
  heading: { color: colors.text, fontSize: 16, fontWeight: "600", marginTop: spacing.xs },
  headingLarge: { fontSize: 18 },
  quote: {
    borderLeftWidth: 2,
    borderLeftColor: colors.border,
    paddingLeft: spacing.md,
  },
  quoteText: { color: colors.textMuted, fontSize: 15, lineHeight: 21 },
  codeBlock: {
    backgroundColor: colors.surfaceOverlay,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radii.sm,
    padding: spacing.md,
  },
  codeText: { fontFamily: "Menlo", fontSize: 12, color: colors.textSecondary, lineHeight: 17 },
  listItem: { flexDirection: "row", gap: spacing.sm, paddingRight: spacing.md },
  listMarker: { color: colors.textMuted, fontSize: 15, lineHeight: 21 },
});
