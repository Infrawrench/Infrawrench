import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import type { LogsFetchResult } from "@infrawrench/plugin-base";
import {
  compileLogSearch,
  splitLogLines,
  logStreamKey,
  type LogStreamSelector,
} from "@infrawrench/client-core";
import { useOrgApi } from "@/lib/auth/AuthProvider";
import { ErrorView, LoadingView } from "@/components/ui";
import { colors, radii, spacing } from "@/lib/theme";
import { useLogWorkspaces } from "./useLogWorkspaces";

/** Per-stream label colors — same round-robin idea as the web workspace. */
const STREAM_COLORS = ["#38bdf8", "#34d399", "#fbbf24", "#e879f9", "#fb7185", "#22d3ee"];

const TAIL_LINES = 300;

interface StreamChunk {
  key: string;
  label: string;
  color: string;
  lines: string[];
  error: string | null;
}

/**
 * Read-only viewer for one saved query: fetches a tail of every stream
 * through the same per-resource logs endpoint the Logs tool uses, interleaves
 * them with colored per-stream labels, and applies the saved search
 * expression (editable locally, client-side only). Pull down to refresh.
 */
export function LogWorkspaceViewerScreen({ queryId }: { queryId: string }) {
  const { api, orgId } = useOrgApi();
  const queries = useLogWorkspaces();
  const query = queries.data?.queries.find((q) => q.id === queryId);

  const [chunks, setChunks] = useState<StreamChunk[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [search, setSearch] = useState<string | null>(null);
  const latestRequestRef = useRef(0);

  const effectiveSearch = search ?? query?.search ?? "";

  const fetchAll = useCallback(async () => {
    if (!query) return;
    const requestId = ++latestRequestRef.current;
    const results = await Promise.all(
      query.resources.map(async (selector: LogStreamSelector, i: number): Promise<StreamChunk> => {
        const base: StreamChunk = {
          key: logStreamKey(selector),
          label: selector.resourceId.split(":").slice(2).join(":") || selector.resourceId,
          color: STREAM_COLORS[i % STREAM_COLORS.length]!,
          lines: [],
          error: null,
        };
        try {
          const result = await api.org<LogsFetchResult>(
            orgId,
            `/resources/${encodeURIComponent(selector.pluginId)}/${encodeURIComponent(selector.resourceTypeId)}/logs`,
            {
              method: "POST",
              body: JSON.stringify({
                accountId: selector.accountId,
                resourceId: selector.resourceId,
                tailLines: TAIL_LINES,
                ...(selector.container ? { container: selector.container } : {}),
              }),
            },
          );
          return { ...base, lines: splitLogLines(result?.text ?? "") };
        } catch (e) {
          return { ...base, error: e instanceof Error ? e.message : "Failed to fetch logs" };
        }
      }),
    );
    if (requestId === latestRequestRef.current) setChunks(results);
  }, [api, orgId, query]);

  useEffect(() => {
    if (query && chunks === null) void fetchAll();
  }, [query, chunks, fetchAll]);

  const compiled = useMemo(() => compileLogSearch(effectiveSearch), [effectiveSearch]);
  const visible = useMemo(() => {
    if (!chunks) return [];
    return chunks.map((chunk) => ({
      ...chunk,
      lines:
        compiled.error || compiled.matchAll
          ? chunk.lines
          : chunk.lines.filter((line) => compiled.test(line)),
    }));
  }, [chunks, compiled]);

  if (queries.isLoading) return <LoadingView />;
  if (queries.isError) {
    return (
      <ErrorView
        message={queries.error instanceof Error ? queries.error.message : "Failed to load"}
        onRetry={() => void queries.refetch()}
      />
    );
  }
  if (!query)
    return <ErrorView message="Saved query not found." onRetry={() => void queries.refetch()} />;
  if (chunks === null) return <LoadingView />;

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>{query.name}</Text>
        <TextInput
          value={effectiveSearch}
          onChangeText={setSearch}
          placeholder='Filter — terms, "phrases", -not, /regex/'
          placeholderTextColor={colors.textMuted}
          autoCapitalize="none"
          autoCorrect={false}
          style={styles.search}
        />
        {compiled.error ? <Text style={styles.error}>{compiled.error}</Text> : null}
      </View>
      <ScrollView
        style={styles.output}
        contentContainerStyle={styles.outputInner}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              setRefreshing(true);
              void fetchAll().finally(() => setRefreshing(false));
            }}
            tintColor={colors.textMuted}
          />
        }
      >
        {visible.map((chunk) => (
          <View key={chunk.key} style={styles.chunk}>
            <Text style={[styles.chunkLabel, { color: chunk.color }]}>{chunk.label}</Text>
            {chunk.error ? (
              <Text style={styles.error}>{chunk.error}</Text>
            ) : chunk.lines.length === 0 ? (
              <Text style={styles.emptyText}>
                {compiled.matchAll ? "<no output>" : "<no lines match>"}
              </Text>
            ) : (
              <Text style={styles.logText} selectable>
                {chunk.lines.join("\n")}
              </Text>
            )}
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  header: { padding: spacing.md, gap: spacing.xs },
  title: { color: colors.text, fontSize: 16, fontWeight: "600" },
  search: {
    color: colors.text,
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    fontSize: 13,
    fontFamily: "monospace",
  },
  error: { color: colors.danger, fontSize: 12 },
  output: { flex: 1, backgroundColor: colors.surface },
  outputInner: { padding: spacing.md, gap: spacing.md },
  chunk: { gap: spacing.xs },
  chunkLabel: { fontSize: 12, fontWeight: "700", fontFamily: "monospace" },
  emptyText: { color: colors.textMuted, fontSize: 11, fontFamily: "monospace" },
  logText: { color: colors.textSecondary, fontFamily: "monospace", fontSize: 11, lineHeight: 16 },
});
