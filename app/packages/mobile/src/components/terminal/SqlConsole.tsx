import { useCallback, useState } from "react";
import { ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { CloudApiError } from "@infrawrench/client-core";
import { useOrgApi } from "@/lib/auth/AuthProvider";
import { Button, Card, SectionTitle } from "@/components/ui";
import { KeyboardAvoider } from "@/components/KeyboardAvoider";
import { colors, radii, spacing } from "@/lib/theme";

/**
 * SQL console over `POST /sql/query`, the same endpoint web and desktop use.
 *
 * It has to be this route rather than the WS gateway's `sql:query` frame: the
 * frame carries no resource, so the proxy can only reach plugins that expose
 * `executeQuery` — and it passes the account id where a resource id belongs.
 * The HTTP route also handles per-resource SQL drivers (Turso, D1, ClickHouse
 * services) and account-level ones (Postgres, MySQL, SQL Server), which is
 * most of what has a SQL editor at all. Hence `resourceId`/`resourceTypeId`.
 */

const MAX_RENDERED_ROWS = 200;

interface SqlResult {
  rows: Array<Record<string, unknown>>;
  durationMs?: number;
}

/**
 * A failed query is usually the database talking — a syntax error, a missing
 * table. Dig the server's `{ error }` out of the response body so the console
 * shows that instead of "Cloud request failed: 500 https://…".
 */
function queryErrorMessage(e: unknown): string {
  if (e instanceof CloudApiError) {
    try {
      const parsed = JSON.parse(e.body) as { error?: unknown };
      if (typeof parsed.error === "string" && parsed.error) return parsed.error;
    } catch {
      /* not JSON — fall through to the raw message */
    }
  }
  return e instanceof Error ? e.message : "Query failed";
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export function SqlConsole({
  accountId,
  resourceId,
  resourceTypeId,
}: {
  accountId: string;
  resourceId?: string | undefined;
  resourceTypeId?: string | undefined;
}) {
  const { api, orgId } = useOrgApi();
  const [sql, setSql] = useState("");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<SqlResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const runQuery = useCallback(async () => {
    const trimmed = sql.trim();
    if (!trimmed || running) return;
    setRunning(true);
    setError(null);
    try {
      const outcome = await api.org<{ rows?: unknown; durationMs?: unknown }>(orgId, "/sql/query", {
        method: "POST",
        body: JSON.stringify({
          accountId,
          ...(resourceId ? { resourceId } : {}),
          ...(resourceTypeId ? { resourceTypeId } : {}),
          sql: trimmed,
        }),
      });
      const rows = Array.isArray(outcome?.rows)
        ? (outcome.rows as Array<Record<string, unknown>>)
        : [];
      setResult({
        rows,
        ...(typeof outcome?.durationMs === "number" ? { durationMs: outcome.durationMs } : {}),
      });
    } catch (e) {
      setError(queryErrorMessage(e));
      setResult(null);
    } finally {
      setRunning(false);
    }
  }, [sql, running, api, orgId, accountId, resourceId, resourceTypeId]);

  const rows = result?.rows ?? [];
  const firstRow = rows[0];
  const columns = firstRow ? Object.keys(firstRow) : [];

  return (
    <KeyboardAvoider style={styles.container}>
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
    </KeyboardAvoider>
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
