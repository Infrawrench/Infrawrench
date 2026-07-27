import { useCallback, useEffect, useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import {
  formatMongoPreview,
  formatMongoValue,
  mongoCommands,
  stripMongoId,
  MONGO_PAGE_SIZE,
  type MongoCollectionStats,
  type MongoCommand,
} from "@infrawrench/client-core";
import { useOrgApi } from "@/lib/auth/AuthProvider";
import { Button, Card, EmptyView, LoadingView, SectionTitle } from "@/components/ui";
import { KeyboardAvoider } from "@/components/KeyboardAvoider";
import { colors, radii, spacing } from "@/lib/theme";

/**
 * MongoDB document browser — the phone counterpart of the web
 * MongoDocumentBrowser. Collections across the top, a JSON filter, paged
 * documents that expand to full JSON, and insert / edit / delete. Every call
 * is a positional `executeNoSqlCommand` through `POST /kv/command`; the
 * argument builders live in client-core so both hosts speak the same dialect.
 */

export function MongoBrowserScreen({
  accountId,
  databaseName,
  pluginId,
  parentResourceId,
}: {
  accountId: string;
  databaseName: string;
  pluginId?: string | undefined;
  parentResourceId?: string | undefined;
}) {
  const { api, orgId } = useOrgApi();
  const [collections, setCollections] = useState<string[]>([]);
  const [activeCollection, setActiveCollection] = useState<string | null>(null);
  const [stats, setStats] = useState<MongoCollectionStats | null>(null);
  const [documents, setDocuments] = useState<Record<string, unknown>[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [page, setPage] = useState(0);
  const [filterText, setFilterText] = useState("");
  const [appliedFilter, setAppliedFilter] = useState("{}");
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ doc: Record<string, unknown>; json: string } | null>(
    null,
  );
  const [inserting, setInserting] = useState<string | null>(null);

  const run = useCallback(
    async (cmd: MongoCommand): Promise<unknown> => {
      const response = await api.org<{ result: unknown }>(orgId, "/kv/command", {
        method: "POST",
        body: JSON.stringify({
          accountId,
          command: cmd.command,
          args: cmd.args,
          ...(pluginId ? { pluginId } : {}),
          ...(parentResourceId ? { parentResourceId } : {}),
        }),
      });
      return response?.result ?? null;
    },
    [api, orgId, accountId, pluginId, parentResourceId],
  );

  const refreshCollections = useCallback(async () => {
    try {
      const cols = (await run(mongoCommands.listCollections(databaseName))) as string[];
      setCollections(cols ?? []);
      setActiveCollection((prev) => prev ?? cols?.[0] ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to list collections");
    } finally {
      setLoading(false);
    }
  }, [run, databaseName]);

  useEffect(() => {
    void refreshCollections();
  }, [refreshCollections]);

  const fetchDocuments = useCallback(async () => {
    if (!activeCollection) return;
    setError(null);
    try {
      const [docs, count, collStats] = await Promise.all([
        run(
          mongoCommands.find(
            databaseName,
            activeCollection,
            appliedFilter,
            page * MONGO_PAGE_SIZE,
            MONGO_PAGE_SIZE,
          ),
        ) as Promise<Record<string, unknown>[]>,
        run(
          mongoCommands.countDocuments(databaseName, activeCollection, appliedFilter),
        ) as Promise<number>,
        run(
          mongoCommands.collectionStats(databaseName, activeCollection),
        ) as Promise<MongoCollectionStats>,
      ]);
      setDocuments(docs ?? []);
      setTotalCount(count ?? 0);
      setStats(collStats ?? null);
      setExpanded(new Set());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Query failed");
      setDocuments([]);
      setTotalCount(0);
    }
  }, [run, databaseName, activeCollection, appliedFilter, page]);

  useEffect(() => {
    void fetchDocuments();
  }, [fetchDocuments]);

  function applyFilter() {
    const trimmed = filterText.trim() || "{}";
    try {
      JSON.parse(trimmed);
      setAppliedFilter(trimmed);
      setPage(0);
    } catch {
      setError("Invalid JSON filter");
    }
  }

  async function saveEdit() {
    if (!editing || !activeCollection) return;
    const id = editing.doc["_id"];
    if (id == null) return;
    try {
      JSON.parse(editing.json);
    } catch {
      Alert.alert("Invalid JSON", "The document is not valid JSON.");
      return;
    }
    try {
      await run(
        mongoCommands.replaceOne(
          databaseName,
          activeCollection,
          JSON.stringify({ _id: id }),
          stripMongoId(editing.json),
        ),
      );
      setEditing(null);
      await fetchDocuments();
    } catch (e) {
      Alert.alert("Save failed", e instanceof Error ? e.message : String(e));
    }
  }

  async function insertDocument() {
    if (inserting === null || !activeCollection) return;
    try {
      JSON.parse(inserting);
    } catch {
      Alert.alert("Invalid JSON", "The document is not valid JSON.");
      return;
    }
    try {
      await run(mongoCommands.insertOne(databaseName, activeCollection, inserting));
      setInserting(null);
      await fetchDocuments();
    } catch (e) {
      Alert.alert("Insert failed", e instanceof Error ? e.message : String(e));
    }
  }

  function confirmDelete(doc: Record<string, unknown>) {
    const id = doc["_id"];
    if (id == null || !activeCollection) return;
    Alert.alert("Delete document", `Delete ${formatMongoValue(id)}?`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: () => {
          void (async () => {
            try {
              await run(
                mongoCommands.deleteOne(
                  databaseName,
                  activeCollection,
                  JSON.stringify({ _id: id }),
                ),
              );
              await fetchDocuments();
            } catch (e) {
              Alert.alert("Delete failed", e instanceof Error ? e.message : String(e));
            }
          })();
        },
      },
    ]);
  }

  function confirmDropCollection(name: string) {
    Alert.alert("Drop collection", `Drop "${name}" and everything in it?`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Drop",
        style: "destructive",
        onPress: () => {
          void (async () => {
            try {
              await run(mongoCommands.dropCollection(databaseName, name));
              if (activeCollection === name) {
                setActiveCollection(null);
                setDocuments([]);
                setTotalCount(0);
              }
              await refreshCollections();
            } catch (e) {
              Alert.alert("Drop failed", e instanceof Error ? e.message : String(e));
            }
          })();
        },
      },
    ]);
  }

  if (loading) return <LoadingView />;

  const totalPages = Math.max(1, Math.ceil(totalCount / MONGO_PAGE_SIZE));

  if (editing) {
    return (
      <JsonEditor
        title={`Edit ${formatMongoValue(editing.doc["_id"])}`}
        json={editing.json}
        onChange={(json) => setEditing({ doc: editing.doc, json })}
        onCancel={() => setEditing(null)}
        onSave={() => void saveEdit()}
      />
    );
  }

  if (inserting !== null) {
    return (
      <JsonEditor
        title={`Insert into ${activeCollection ?? ""}`}
        json={inserting}
        onChange={setInserting}
        onCancel={() => setInserting(null)}
        onSave={() => void insertDocument()}
        saveLabel="Insert"
      />
    );
  }

  return (
    <KeyboardAvoider style={styles.container}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.chipRow}
      >
        {collections.map((col) => (
          <Pressable
            key={col}
            onPress={() => {
              setActiveCollection(col);
              setPage(0);
              setFilterText("");
              setAppliedFilter("{}");
            }}
            onLongPress={() => confirmDropCollection(col)}
            style={[styles.chip, col === activeCollection && styles.chipSelected]}
          >
            <Text style={col === activeCollection ? styles.chipTextSelected : styles.chipText}>
              {col}
            </Text>
          </Pressable>
        ))}
      </ScrollView>

      <View style={styles.filterRow}>
        <TextInput
          value={filterText}
          onChangeText={setFilterText}
          placeholder='{ "field": "value" }'
          placeholderTextColor={colors.textFaint}
          autoCapitalize="none"
          autoCorrect={false}
          onSubmitEditing={applyFilter}
          returnKeyType="search"
          style={styles.filterInput}
        />
        <Button label="Apply" onPress={applyFilter} />
      </View>

      {error ? <Text style={styles.error}>{error}</Text> : null}

      {!activeCollection ? (
        <EmptyView message="No collections in this database." />
      ) : documents.length === 0 ? (
        <EmptyView message="No documents match." />
      ) : (
        <ScrollView contentContainerStyle={styles.content}>
          <Card list>
            {documents.map((doc, idx) => {
              const isOpen = expanded.has(idx);
              const preview = Object.entries(doc)
                .filter(([k]) => k !== "_id")
                .slice(0, 3);
              return (
                <View key={idx} style={styles.docRow}>
                  <Pressable
                    onPress={() =>
                      setExpanded((prev) => {
                        const next = new Set(prev);
                        if (next.has(idx)) next.delete(idx);
                        else next.add(idx);
                        return next;
                      })
                    }
                  >
                    <Text style={styles.docId} numberOfLines={1}>
                      {formatMongoValue(doc["_id"])}
                    </Text>
                    {!isOpen &&
                      preview.map(([key, val]) => (
                        <Text key={key} style={styles.docPreview} numberOfLines={1}>
                          {key}: {formatMongoPreview(val)}
                        </Text>
                      ))}
                  </Pressable>
                  {isOpen ? (
                    <>
                      <Text style={styles.docJson} selectable>
                        {JSON.stringify(doc, null, 2)}
                      </Text>
                      <View style={styles.docActions}>
                        <Button
                          label="Edit"
                          variant="secondary"
                          onPress={() => {
                            const { _id: _removed, ...rest } = doc;
                            setEditing({ doc, json: JSON.stringify(rest, null, 2) });
                          }}
                        />
                        <Button
                          label="Delete"
                          variant="secondary"
                          onPress={() => confirmDelete(doc)}
                        />
                      </View>
                    </>
                  ) : null}
                </View>
              );
            })}
          </Card>

          <View style={styles.footer}>
            <Text style={styles.footerText}>
              {totalCount} doc{totalCount === 1 ? "" : "s"}
              {appliedFilter !== "{}" ? " (filtered)" : ""}
              {stats ? ` · ${stats.nindexes} indexes` : ""}
            </Text>
            <View style={styles.pager}>
              <Button
                label="Prev"
                variant="secondary"
                disabled={page === 0}
                onPress={() => setPage((p) => Math.max(0, p - 1))}
              />
              <Text style={styles.footerText}>
                {page + 1} / {totalPages}
              </Text>
              <Button
                label="Next"
                variant="secondary"
                disabled={page >= totalPages - 1}
                onPress={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
              />
            </View>
          </View>

          <Button label="Insert document" onPress={() => setInserting("{\n  \n}")} />
        </ScrollView>
      )}
    </KeyboardAvoider>
  );
}

function JsonEditor({
  title,
  json,
  onChange,
  onCancel,
  onSave,
  saveLabel = "Save",
}: {
  title: string;
  json: string;
  onChange: (json: string) => void;
  onCancel: () => void;
  onSave: () => void;
  saveLabel?: string;
}) {
  return (
    <KeyboardAvoider style={styles.container}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Card>
          <SectionTitle>{title}</SectionTitle>
          <TextInput
            value={json}
            onChangeText={onChange}
            multiline
            autoCapitalize="none"
            autoCorrect={false}
            style={styles.jsonInput}
          />
          <View style={styles.docActions}>
            <Button label="Cancel" variant="secondary" onPress={onCancel} />
            <Button label={saveLabel} onPress={onSave} />
          </View>
        </Card>
      </ScrollView>
    </KeyboardAvoider>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.lg, gap: spacing.md },
  chipRow: { gap: spacing.xs, padding: spacing.sm },
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
  filterRow: {
    flexDirection: "row",
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.sm,
    alignItems: "center",
  },
  filterInput: {
    flex: 1,
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.md,
    color: colors.text,
    fontFamily: "monospace",
    fontSize: 12,
    padding: spacing.sm,
  },
  error: { color: colors.danger, fontSize: 12, paddingHorizontal: spacing.md },
  docRow: { paddingVertical: spacing.sm, gap: 2 },
  docId: { color: colors.accent, fontFamily: "monospace", fontSize: 12 },
  docPreview: { color: colors.textMuted, fontSize: 12 },
  docJson: {
    color: colors.textSecondary,
    fontFamily: "monospace",
    fontSize: 11,
    marginTop: spacing.xs,
  },
  docActions: { flexDirection: "row", gap: spacing.sm, justifyContent: "flex-end" },
  footer: { gap: spacing.sm },
  footerText: { color: colors.textMuted, fontSize: 12 },
  pager: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  jsonInput: {
    backgroundColor: colors.background,
    borderColor: colors.border,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.md,
    color: colors.text,
    fontFamily: "monospace",
    fontSize: 12,
    minHeight: 240,
    padding: spacing.sm,
    textAlignVertical: "top",
  },
});
