import { useCallback, useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { formatRedisResult, kvConsoleProfile, parseKvCommand } from "@infrawrench/client-core";
import { useOrgApi } from "@/lib/auth/AuthProvider";
import { Button } from "@/components/ui";
import { KeyboardAvoider } from "@/components/KeyboardAvoider";
import { colors, radii, spacing } from "@/lib/theme";

/**
 * Mobile KV console — the phone counterpart of the web KvConsole panel, over
 * `POST /kv/command`. Command parsing, result formatting and the per-driver
 * copy come from client-core so Redis, Memcached, Kafka and Mongo behave the
 * same here as on the desk.
 *
 * There are no arrow keys on a phone, so history is recall-by-tap: tap any
 * echoed command to put it back in the input.
 */

interface ConsoleLine {
  kind: "input" | "output" | "error";
  text: string;
}

export function KvConsoleScreen({
  accountId,
  driverName,
  pluginId,
  parentResourceId,
}: {
  accountId: string;
  driverName: string;
  pluginId?: string | undefined;
  parentResourceId?: string | undefined;
}) {
  const { api, orgId } = useOrgApi();
  const [input, setInput] = useState("");
  const [lines, setLines] = useState<ConsoleLine[]>([]);
  const [running, setRunning] = useState(false);
  const scrollRef = useRef<ScrollView>(null);
  const profile = kvConsoleProfile(driverName);

  const runCommand = useCallback(
    async (raw: string) => {
      const trimmed = raw.trim();
      if (!trimmed || running) return;
      setLines((prev) => [...prev, { kind: "input", text: `> ${trimmed}` }]);
      setInput("");
      setRunning(true);
      try {
        const { command, args } = parseKvCommand(trimmed);
        const response = await api.org<{ result: unknown }>(orgId, "/kv/command", {
          method: "POST",
          body: JSON.stringify({
            accountId,
            command,
            args,
            ...(pluginId ? { pluginId } : {}),
            ...(parentResourceId ? { parentResourceId } : {}),
          }),
        });
        setLines((prev) => [
          ...prev,
          { kind: "output", text: formatRedisResult(response?.result ?? null) },
        ]);
      } catch (e) {
        setLines((prev) => [
          ...prev,
          { kind: "error", text: e instanceof Error ? e.message : "Command failed" },
        ]);
      } finally {
        setRunning(false);
      }
    },
    [api, orgId, accountId, pluginId, parentResourceId, running],
  );

  return (
    <KeyboardAvoider style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.headerText}>{profile.label} console</Text>
        {lines.length > 0 && (
          <Pressable onPress={() => setLines([])}>
            <Text style={styles.clear}>Clear</Text>
          </Pressable>
        )}
      </View>

      <ScrollView
        ref={scrollRef}
        style={styles.output}
        contentContainerStyle={styles.outputInner}
        onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: true })}
        keyboardShouldPersistTaps="handled"
      >
        {lines.length === 0 ? (
          <Text style={styles.hint}>
            Type a {profile.label} command and press Run, e.g. {profile.examples}
          </Text>
        ) : (
          lines.map((line, i) => (
            <Pressable
              key={i}
              onPress={() => line.kind === "input" && setInput(line.text.replace(/^> /, ""))}
            >
              <Text
                style={[
                  styles.line,
                  line.kind === "input"
                    ? styles.lineInput
                    : line.kind === "error"
                      ? styles.lineError
                      : styles.lineOutput,
                ]}
                selectable
              >
                {line.text}
              </Text>
            </Pressable>
          ))
        )}
        {running ? <Text style={styles.hint}>…</Text> : null}
      </ScrollView>

      <View style={styles.inputRow}>
        <TextInput
          value={input}
          onChangeText={setInput}
          placeholder={profile.placeholder}
          placeholderTextColor={colors.textFaint}
          autoCapitalize="none"
          autoCorrect={false}
          onSubmitEditing={() => void runCommand(input)}
          returnKeyType="send"
          style={styles.input}
        />
        <Button
          label={running ? "…" : "Run"}
          disabled={running || !input.trim()}
          onPress={() => void runCommand(input)}
        />
      </View>
    </KeyboardAvoider>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    padding: spacing.md,
  },
  headerText: { color: colors.textMuted, fontSize: 13, fontWeight: "600" },
  clear: { color: colors.textFaint, fontSize: 12 },
  output: { flex: 1, backgroundColor: colors.surface },
  outputInner: { padding: spacing.md, gap: 2 },
  hint: { color: colors.textFaint, fontSize: 12 },
  line: { fontFamily: "monospace", fontSize: 12 },
  lineInput: { color: colors.textMuted },
  lineOutput: { color: colors.success },
  lineError: { color: colors.danger },
  inputRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    padding: spacing.sm,
  },
  input: {
    flex: 1,
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.md,
    color: colors.text,
    fontFamily: "monospace",
    fontSize: 13,
    padding: spacing.sm,
  },
});
