import { useCallback, useEffect, useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import type { KvKeyEntry, KvListResult } from "@infrawrench/plugin-base";
import { useOrgApi } from "@/lib/auth/AuthProvider";
import { Button, Card, EmptyView, LoadingView, SectionTitle } from "@/components/ui";
import { KeyboardAvoider } from "@/components/KeyboardAvoider";
import { colors, radii, spacing } from "@/lib/theme";

/**
 * Key-value namespace browser (Cloudflare Workers KV and friends) over the
 * `/kv-browser/*` routes — list with a prefix filter and cursor paging, reveal
 * a value, write it back, or delete the key.
 */

const PAGE_SIZE = 50;

export function KvBrowserScreen({
  accountId,
  resourceTypeId,
  resourceId,
}: {
  accountId: string;
  resourceTypeId: string;
  resourceId: string;
}) {
  const { api, orgId } = useOrgApi();
  const [prefix, setPrefix] = useState("");
  const [appliedPrefix, setAppliedPrefix] = useState("");
  const [keys, setKeys] = useState<KvKeyEntry[]>([]);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState<{ key: string; value: string } | null>(null);

  const body = useCallback(
    (extra: Record<string, unknown>) =>
      JSON.stringify({ accountId, resourceTypeId, resourceId, ...extra }),
    [accountId, resourceTypeId, resourceId],
  );

  const loadPage = useCallback(
    async (opts: { reset: boolean; cursor?: string; prefix?: string }) => {
      if (opts.reset) setLoading(true);
      setError(null);
      try {
        const result = await api.org<KvListResult>(orgId, "/kv-browser/list", {
          method: "POST",
          body: body({
            limit: PAGE_SIZE,
            ...(opts.prefix ? { prefix: opts.prefix } : {}),
            ...(opts.cursor ? { cursor: opts.cursor } : {}),
          }),
        });
        const items = result?.items ?? [];
        setKeys((prev) => (opts.reset ? items : [...prev, ...items]));
        setCursor(result?.nextCursor || undefined);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to list keys");
      } finally {
        setLoading(false);
      }
    },
    [api, orgId, body],
  );

  useEffect(() => {
    void loadPage({ reset: true, prefix: appliedPrefix });
  }, [loadPage, appliedPrefix]);

  async function openKey(key: string) {
    setBusy(true);
    try {
      const result = await api.org<{ value: string }>(orgId, "/kv-browser/get", {
        method: "POST",
        body: body({ key }),
      });
      setActive({ key, value: result?.value ?? "" });
    } catch (e) {
      Alert.alert("Read failed", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function saveKey() {
    if (!active) return;
    setBusy(true);
    try {
      await api.org(orgId, "/kv-browser/put", {
        method: "POST",
        body: body({ key: active.key, value: active.value }),
      });
      Alert.alert("Saved", `"${active.key}" written.`);
      setActive(null);
      await loadPage({ reset: true, prefix: appliedPrefix });
    } catch (e) {
      Alert.alert("Write failed", e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function confirmDelete(key: string) {
    Alert.alert("Delete key", `Delete "${key}"? This cannot be undone.`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: () => {
          void (async () => {
            setBusy(true);
            try {
              await api.org(orgId, "/kv-browser/delete", {
                method: "POST",
                body: body({ key }),
              });
              setActive(null);
              await loadPage({ reset: true, prefix: appliedPrefix });
            } catch (e) {
              Alert.alert("Delete failed", e instanceof Error ? e.message : String(e));
            } finally {
              setBusy(false);
            }
          })();
        },
      },
    ]);
  }

  if (loading) return <LoadingView />;

  if (active) {
    return (
      <KeyboardAvoider style={styles.container}>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <Card>
            <SectionTitle>{active.key}</SectionTitle>
            <TextInput
              value={active.value}
              onChangeText={(value) => setActive({ key: active.key, value })}
              multiline
              autoCapitalize="none"
              autoCorrect={false}
              style={styles.valueInput}
            />
            <View style={styles.row}>
              <Button label="Back" variant="secondary" onPress={() => setActive(null)} />
              <Button
                label="Delete"
                variant="secondary"
                onPress={() => confirmDelete(active.key)}
              />
              <Button
                label={busy ? "Saving…" : "Save"}
                disabled={busy}
                onPress={() => void saveKey()}
              />
            </View>
          </Card>
        </ScrollView>
      </KeyboardAvoider>
    );
  }

  return (
    <KeyboardAvoider style={styles.container}>
      <View style={styles.filterRow}>
        <TextInput
          value={prefix}
          onChangeText={setPrefix}
          placeholder="key prefix"
          placeholderTextColor={colors.textFaint}
          autoCapitalize="none"
          autoCorrect={false}
          onSubmitEditing={() => setAppliedPrefix(prefix.trim())}
          returnKeyType="search"
          style={styles.filterInput}
        />
        <Button label="Filter" onPress={() => setAppliedPrefix(prefix.trim())} />
      </View>

      {error ? <Text style={styles.error}>{error}</Text> : null}

      {keys.length === 0 ? (
        <EmptyView message="No keys in this namespace." />
      ) : (
        <ScrollView contentContainerStyle={styles.content}>
          <Card list>
            {keys.map((entry) => (
              <Pressable
                key={entry.name}
                onPress={() => void openKey(entry.name)}
                style={styles.keyRow}
              >
                <Text style={styles.keyName} numberOfLines={1}>
                  {entry.name}
                </Text>
                {entry.expiration ? (
                  <Text style={styles.keyMeta}>
                    expires {new Date(entry.expiration * 1000).toLocaleString()}
                  </Text>
                ) : null}
              </Pressable>
            ))}
          </Card>
          {cursor ? (
            <Button
              label="Load more"
              variant="secondary"
              onPress={() => void loadPage({ reset: false, cursor, prefix: appliedPrefix })}
            />
          ) : null}
        </ScrollView>
      )}
    </KeyboardAvoider>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.lg, gap: spacing.md },
  filterRow: { flexDirection: "row", gap: spacing.sm, padding: spacing.md, alignItems: "center" },
  filterInput: {
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
  error: { color: colors.danger, fontSize: 12, paddingHorizontal: spacing.md },
  keyRow: { paddingVertical: spacing.sm, gap: 2 },
  keyName: { color: colors.text, fontFamily: "monospace", fontSize: 13 },
  keyMeta: { color: colors.textFaint, fontSize: 11 },
  valueInput: {
    backgroundColor: colors.background,
    borderColor: colors.border,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.md,
    color: colors.text,
    fontFamily: "monospace",
    fontSize: 12,
    minHeight: 200,
    padding: spacing.sm,
    textAlignVertical: "top",
  },
  row: { flexDirection: "row", gap: spacing.sm, justifyContent: "flex-end" },
});
