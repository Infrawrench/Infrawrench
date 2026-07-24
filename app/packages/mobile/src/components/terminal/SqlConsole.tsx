import { useCallback, useEffect, useRef, useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import type { ServerFrame } from "@infrawrench/client-core";
import { useOrgApi } from "@/lib/auth/AuthProvider";
import { WsSession } from "@/lib/ws/WsSession";
import { Button, Card, SectionTitle } from "@/components/ui";
import { colors, radii, spacing } from "@/lib/theme";

/**
 * SQL console over the WS gateway: sends `sql:query` frames and renders the
 * `sql:result` / `sql:error` responses (see app/packages/web/server.ts and
 * src/services/sql-proxy.ts — results are { rows, durationMs }).
 *
 * The socket is dialed lazily per query and reused while it stays open; unlike
 * a pty, a SQL session has no state to lose, so reconnecting is safe.
 */

const MAX_RENDERED_ROWS = 200;

interface SqlResult {
  rows: Array<Record<string, unknown>>;
  durationMs?: number;
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export function SqlConsole({ accountId }: { accountId: string }) {
  const { api, orgId } = useOrgApi();
  const [sql, setSql] = useState("");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<SqlResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sessionRef = useRef<WsSession | null>(null);

  useEffect(() => {
    return () => {
      sessionRef.current?.close();
      sessionRef.current = null;
    };
  }, []);

  const ensureSession = useCallback(async (): Promise<WsSession> => {
    const existing = sessionRef.current;
    if (existing?.isOpen) return existing;
    existing?.close();
    const session = new WsSession({ api, orgId });
    sessionRef.current = session;
    await session.connect();
    return session;
  }, [api, orgId]);

  const runQuery = useCallback(async () => {
    const trimmed = sql.trim();
    if (!trimmed || running) return;
    setRunning(true);
    setError(null);
    try {
      const session = await ensureSession();
      const outcome = await new Promise<ServerFrame>((resolve, reject) => {
        const offFrame = session.onFrame((frame) => {
          if (frame.type === "sql:result" || frame.type === "sql:error") {
            cleanup();
            resolve(frame);
          }
        });
        const offClose = session.onClose(() => {
          cleanup();
          reject(new Error("Connection closed before the query finished"));
        });
        // A gateway that never answers would leave the console stuck on
        // "Running…" forever. Generous — legitimate queries can be slow.
        const timeout = setTimeout(() => {
          cleanup();
          reject(new Error("Query timed out after 120 seconds"));
        }, 120_000);
        const cleanup = () => {
          clearTimeout(timeout);
          offFrame();
          offClose();
        };
        session.send({ type: "sql:query", accountId, sql: trimmed });
      });

      if (outcome.type === "sql:error") {
        const message =
          "error" in outcome && typeof outcome.error === "string" ? outcome.error : "Query failed";
        setError(message);
        setResult(null);
      } else {
        const rawRows = (outcome as { rows?: unknown }).rows;
        const rows = Array.isArray(rawRows) ? (rawRows as Array<Record<string, unknown>>) : [];
        const durationMs = (outcome as { durationMs?: unknown }).durationMs;
        setResult({
          rows,
          ...(typeof durationMs === "number" ? { durationMs } : {}),
        });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Query failed");
      setResult(null);
    } finally {
      setRunning(false);
    }
  }, [sql, running, ensureSession, accountId]);

  const rows = result?.rows ?? [];
  const firstRow = rows[0];
  const columns = firstRow ? Object.keys(firstRow) : [];

  return (
    <KeyboardAvoidingView
      style={styles.container}
      {...(Platform.OS === "ios" ? { behavior: "padding" as const } : {})}
    >
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        <Card>
          <SectionTitle>Query</SectionTitle>
          <TextInput
            value={sql}
            onChangeText={setSql}
            placeholder="SELECT * FROM …"
            placeholderTextColor={colors.textFaint}
            multiline
            autoCapitalize="none"
            autoCorrect={false}
            style={styles.input}
          />
          <Button
            label={running ? "Running…" : "Run query"}
            disabled={running || !sql.trim()}
            onPress={() => void runQuery()}
          />
        </Card>

        {error !== null && (
          <Card>
            <SectionTitle>Error</SectionTitle>
            <Text style={styles.error} selectable>
              {error}
            </Text>
          </Card>
        )}

        {result !== null && error === null && (
          <Card>
            <SectionTitle>
              {`${rows.length} row${rows.length === 1 ? "" : "s"}`}
              {typeof result.durationMs === "number" ? ` · ${result.durationMs} ms` : ""}
            </SectionTitle>
            {rows.length === 0 ? (
              <Text style={styles.muted}>The query returned no rows.</Text>
            ) : (
              <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                <View>
                  <View style={styles.tableRow}>
                    {columns.map((col) => (
                      <Text key={col} style={[styles.cell, styles.headerCell]} numberOfLines={1}>
                        {col}
                      </Text>
                    ))}
                  </View>
                  {rows.slice(0, MAX_RENDERED_ROWS).map((row, i) => (
                    <View key={i} style={styles.tableRow}>
                      {columns.map((col) => (
                        <Text key={col} style={styles.cell} numberOfLines={1} selectable>
                          {formatCell(row[col])}
                        </Text>
                      ))}
                    </View>
                  ))}
                </View>
              </ScrollView>
            )}
            {rows.length > MAX_RENDERED_ROWS && (
              <Text style={styles.muted}>
                Showing the first {MAX_RENDERED_ROWS} of {rows.length} rows.
              </Text>
            )}
          </Card>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.lg, gap: spacing.md },
  input: {
    color: colors.text,
    fontFamily: "monospace",
    fontSize: 13,
    minHeight: 96,
    textAlignVertical: "top",
    backgroundColor: colors.background,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radii.sm,
    padding: spacing.sm,
  },
  error: { color: colors.danger, fontFamily: "monospace", fontSize: 12 },
  muted: { color: colors.textMuted, fontSize: 12 },
  tableRow: {
    flexDirection: "row",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  cell: {
    color: colors.textSecondary,
    fontFamily: "monospace",
    fontSize: 11,
    width: 140,
    paddingVertical: spacing.xs + 2,
    paddingRight: spacing.sm,
  },
  headerCell: { color: colors.text, fontWeight: "700" },
});
