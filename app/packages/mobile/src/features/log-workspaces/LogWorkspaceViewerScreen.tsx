import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import {
  compileLogSearch,
  fetchLogStreamTail,
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
 * through the same per-resource logs endpoint the Logs tool uses, merges them
 * into one sequence with colored per-stream labels (arrival order, like the
 * web/desktop panel — the generic `getLogs` contract returns raw text without
 * timestamps, so chronological cross-stream ordering isn't possible), and
 * applies the saved search expression (editable locally, client-side only).
 * Pull down to refresh.
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
          const tail = await fetchLogStreamTail(api, orgId, selector, { tailLines: TAIL_LINES });
          return { ...base, lines: tail.lines };
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
  // One merged sequence with per-line stream metadata, in arrival order (the
  // generic getLogs contract returns raw text without timestamps, so a
  // chronological cross-stream sort isn't possible — same as the web panel).
  const merged = useMemo(() => {
    if (!chunks) return [];
    return chunks.flatMap((chunk) =>
      (compiled.error || compiled.matchAll
        ? chunk.lines
        : chunk.lines.filter((line) => compiled.test(line))
      ).map((text) => ({ streamKey: chunk.key, label: chunk.label, color: chunk.color, text })),
    );
  }, [chunks, compiled]);
  const errorChunks = useMemo(() => (chunks ?? []).filter((c) => c.error !== null), [chunks]);

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
        {errorChunks.map((chunk) => (
          <View key={chunk.key} style={styles.chunk}>
            <Text style={[styles.chunkLabel, { color: chunk.color }]}>{chunk.label}</Text>
            <Text style={styles.error}>{chunk.error}</Text>
          </View>
        ))}
        {merged.length === 0 ? (
          errorChunks.length === chunks.length ? null : (
            <Text style={styles.emptyText}>
              {compiled.matchAll ? "<no output>" : "<no lines match>"}
            </Text>
          )
        ) : (
          <Text style={styles.logText} selectable>
            {merged.map((line, i) => (
              <Text key={`${line.streamKey}:${i}`}>
                <Text style={{ color: line.color }}>[{line.label}] </Text>
                {line.text}
                {i < merged.length - 1 ? "\n" : ""}
              </Text>
            ))}
          </Text>
        )}
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
