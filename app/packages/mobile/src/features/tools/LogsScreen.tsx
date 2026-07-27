import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import type { LogsFetchParams, LogsFetchResult } from "@infrawrench/plugin-base";
import { useOrgApi } from "@/lib/auth/AuthProvider";
import { Button, LoadingView } from "@/components/ui";
import { colors, radii, spacing } from "@/lib/theme";

/**
 * Logs viewer with the same controls as the web Logs tab: container picker,
 * tail length, previous-instance, follow, copy and reload. Everything the
 * plugin's `getLogs` accepts is exposed — mobile used to post no parameters at
 * all and take whatever defaults the provider chose.
 */

const TAIL_OPTIONS = [100, 500, 1000, 5000];
const FOLLOW_INTERVAL_MS = 5000;

export function LogsScreen({
  pluginId,
  resourceTypeId,
  resourceId,
  accountId,
  parentResourceId,
  defaultTailLines,
  supportsPrevious,
}: {
  pluginId: string;
  resourceTypeId: string;
  resourceId: string;
  accountId: string;
  parentResourceId?: string | undefined;
  defaultTailLines?: number | undefined;
  supportsPrevious?: boolean | undefined;
}) {
  const { api, orgId } = useOrgApi();
  const [text, setText] = useState("");
  const [containers, setContainers] = useState<string[]>([]);
  const [container, setContainer] = useState<string | null>(null);
  const [tailLines, setTailLines] = useState(defaultTailLines ?? 500);
  const [previous, setPrevious] = useState(false);
  const [follow, setFollow] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<ScrollView>(null);
  // Guards against an earlier slow request landing after a newer one — the
  // poll interval makes overlapping fetches routine.
  const latestRequestRef = useRef(0);

  const fetchLogs = useCallback(
    async (opts?: { spinner?: boolean }) => {
      if (opts?.spinner) setLoading(true);
      const requestId = ++latestRequestRef.current;
      setError(null);
      try {
        const params: LogsFetchParams = { tailLines, previous };
        if (container) params.container = container;
        const result = await api.org<LogsFetchResult>(
          orgId,
          `/resources/${encodeURIComponent(pluginId)}/${encodeURIComponent(resourceTypeId)}/logs`,
          {
            method: "POST",
            body: JSON.stringify({
              accountId,
              resourceId,
              ...(parentResourceId ? { parentResourceId } : {}),
              ...params,
            }),
          },
        );
        if (requestId !== latestRequestRef.current) return;
        setText(result?.text ?? "");
        setContainers(result?.containers ?? []);
        if (!container && result?.activeContainer) setContainer(result.activeContainer);
      } catch (e) {
        if (requestId !== latestRequestRef.current) return;
        setError(e instanceof Error ? e.message : "Failed to fetch logs");
      } finally {
        if (requestId === latestRequestRef.current) setLoading(false);
      }
    },
    [
      api,
      orgId,
      pluginId,
      resourceTypeId,
      resourceId,
      accountId,
      parentResourceId,
      tailLines,
      previous,
      container,
    ],
  );

  useEffect(() => {
    void fetchLogs({ spinner: true });
  }, [fetchLogs]);

  useEffect(() => {
    if (!follow) return;
    const t = setInterval(() => void fetchLogs(), FOLLOW_INTERVAL_MS);
    return () => clearInterval(t);
  }, [follow, fetchLogs]);

  useEffect(() => {
    if (follow) scrollRef.current?.scrollToEnd({ animated: false });
  }, [text, follow]);

  if (loading && !text) return <LoadingView />;

  return (
    <View style={styles.container}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.controls}
      >
        {containers.length > 1 &&
          containers.map((c) => (
            <Chip key={c} label={c} selected={c === container} onPress={() => setContainer(c)} />
          ))}
        {TAIL_OPTIONS.map((n) => (
          <Chip
            key={n}
            label={`Last ${n}`}
            selected={n === tailLines}
            onPress={() => setTailLines(n)}
          />
        ))}
        {supportsPrevious && (
          <Chip label="Previous" selected={previous} onPress={() => setPrevious((prev) => !prev)} />
        )}
        <Chip label="Follow" selected={follow} onPress={() => setFollow((prev) => !prev)} />
      </ScrollView>

      {error ? <Text style={styles.error}>{error}</Text> : null}

      <ScrollView ref={scrollRef} style={styles.output} contentContainerStyle={styles.outputInner}>
        <Text style={styles.logText} selectable>
          {text || "<no output>"}
        </Text>
      </ScrollView>

      <View style={styles.footer}>
        <Button
          label="Copy"
          variant="secondary"
          disabled={!text}
          onPress={() => {
            void Clipboard.setStringAsync(text);
            Alert.alert("Copied", "Logs copied to clipboard.");
          }}
        />
        <Button label="Reload" onPress={() => void fetchLogs({ spinner: true })} />
      </View>
    </View>
  );
}

function Chip({
  label,
  selected,
  onPress,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable onPress={onPress} style={[styles.chip, selected && styles.chipSelected]}>
      <Text style={selected ? styles.chipTextSelected : styles.chipText}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  controls: { gap: spacing.xs, padding: spacing.sm, alignItems: "center" },
  chip: {
    borderColor: colors.border,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  chipSelected: { borderColor: colors.accent, backgroundColor: colors.surfaceOverlay },
  chipText: { color: colors.textMuted, fontSize: 12 },
  chipTextSelected: { color: colors.text, fontSize: 12, fontWeight: "600" },
  error: { color: colors.danger, fontSize: 12, paddingHorizontal: spacing.md },
  output: { flex: 1, backgroundColor: colors.surface },
  outputInner: { padding: spacing.md },
  logText: { color: colors.textSecondary, fontFamily: "monospace", fontSize: 11, lineHeight: 16 },
  footer: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: spacing.sm,
    padding: spacing.sm,
  },
});
