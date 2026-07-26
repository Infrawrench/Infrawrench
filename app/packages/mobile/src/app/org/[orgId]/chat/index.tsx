import { useMemo, useState } from "react";
import { useRouter } from "expo-router";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CHAT_MODELS, DEFAULT_CHAT_MODEL, createBearerChatClient } from "@infrawrench/client-core";
import { useOrgApi } from "@/lib/auth/AuthProvider";
import { Button, Card, EmptyView, ErrorView, LoadingView, Row, Screen } from "@/components/ui";
import { colors, radii, spacing } from "@/lib/theme";

export default function ChatListScreen() {
  const router = useRouter();
  const { api, orgId } = useOrgApi();
  const queryClient = useQueryClient();
  const client = useMemo(() => createBearerChatClient(api, orgId), [api, orgId]);
  const [model, setModel] = useState(DEFAULT_CHAT_MODEL);

  const conversations = useQuery({
    queryKey: ["chat-conversations", orgId],
    queryFn: () => client.listConversations(),
  });

  const create = useMutation({
    mutationFn: () => client.createConversation(model),
    onSuccess: ({ id }) => {
      void queryClient.invalidateQueries({ queryKey: ["chat-conversations", orgId] });
      router.push(`/org/${orgId}/chat/${id}`);
    },
    onError: (e) =>
      Alert.alert("New chat failed", e instanceof Error ? e.message : "Unknown error"),
  });

  const archive = useMutation({
    mutationFn: (id: string) => client.archiveConversation(id),
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: ["chat-conversations", orgId] }),
    onError: (e) => Alert.alert("Archive failed", e instanceof Error ? e.message : "Unknown error"),
  });

  // Web archives on a bare click; on a phone a mis-tap is too easy — confirm.
  const confirmArchive = (id: string, title: string) =>
    Alert.alert("Archive chat?", title, [
      { text: "Cancel", style: "cancel" },
      { text: "Archive", style: "destructive", onPress: () => archive.mutate(id) },
    ]);

  if (conversations.isLoading) return <LoadingView />;
  if (conversations.isError) {
    return (
      <ErrorView
        message={
          conversations.error instanceof Error ? conversations.error.message : "Failed to load"
        }
        onRetry={() => void conversations.refetch()}
      />
    );
  }

  const list = conversations.data ?? [];
  const selectedModel = CHAT_MODELS.find((m) => m.id === model);

  return (
    <Screen onRefresh={() => void conversations.refetch()} refreshing={conversations.isRefetching}>
      <View style={styles.modelRow}>
        {CHAT_MODELS.map((m) => {
          const selected = m.id === model;
          return (
            <Pressable
              key={m.id}
              accessibilityRole="button"
              onPress={() => setModel(m.id)}
              style={[styles.modelChip, selected && styles.modelChipSelected]}
            >
              <Text style={[styles.modelChipText, selected && styles.modelChipTextSelected]}>
                {m.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
      {selectedModel ? <Text style={styles.modelHint}>{selectedModel.description}</Text> : null}
      <Button
        label={create.isPending ? "Creating…" : "New chat"}
        disabled={create.isPending}
        onPress={() => create.mutate()}
      />
      {list.length === 0 ? (
        <EmptyView message="No conversations yet. Start a new chat to ask about your infrastructure." />
      ) : (
        <Card list>
          {list.map((c) => (
            <Row
              key={c.id}
              title={c.title}
              subtitle={`${new Date(c.updatedAt).toLocaleString()} · ${
                CHAT_MODELS.find((m) => m.id === c.model)?.label ?? c.model
              }`}
              onPress={() => router.push(`/org/${orgId}/chat/${c.id}`)}
              right={
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Archive ${c.title}`}
                  hitSlop={spacing.sm}
                  disabled={archive.isPending}
                  onPress={() => confirmArchive(c.id, c.title)}
                >
                  <Text style={styles.archiveLabel}>Archive</Text>
                </Pressable>
              }
            />
          ))}
        </Card>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  modelRow: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  modelChip: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  modelChipSelected: { borderColor: colors.accent, backgroundColor: colors.surfaceOverlay },
  modelChipText: { color: colors.textMuted, fontSize: 12 },
  modelChipTextSelected: { color: colors.text, fontSize: 12, fontWeight: "600" },
  modelHint: { color: colors.textFaint, fontSize: 12 },
  archiveLabel: { color: colors.textFaint, fontSize: 12 },
});
