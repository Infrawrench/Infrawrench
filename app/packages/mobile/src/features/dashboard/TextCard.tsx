import { Text } from "react-native";
import type { TextWidgetConfig } from "@infrawrench/client-core";
import { ChatMarkdown } from "@/components/ChatMarkdown";
import { Card } from "@/components/ui";
import { colors } from "@/lib/theme";

/**
 * The native `text` dashboard card, through the native markdown renderer the
 * chat screen uses (headings, lists, code, links). Edited on web or desktop.
 */
export function TextCard({ title, config }: { title: string; config: TextWidgetConfig }) {
  return (
    <Card>
      {title ? (
        <Text style={{ color: colors.text, fontSize: 15, fontWeight: "600" }}>{title}</Text>
      ) : null}
      {config.markdown.trim() ? (
        <ChatMarkdown text={config.markdown} />
      ) : (
        <Text style={{ color: colors.textFaint, fontSize: 13 }}>No text.</Text>
      )}
    </Card>
  );
}
