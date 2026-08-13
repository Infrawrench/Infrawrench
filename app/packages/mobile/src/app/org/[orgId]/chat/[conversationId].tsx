import { useCallback, useMemo, useRef, useState } from "react";
import { useLocalSearchParams } from "expo-router";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CHAT_MODELS,
  createBearerChatClient,
  microsToUsd,
  type ChatContentBlock,
  type ChatConversationMessage,
  type ChatPendingAction,
  type ChatPendingSecretRequest,
} from "@infrawrench/client-core";
import { useOrgApi } from "@/lib/auth/AuthProvider";
import { Button, ErrorView, LoadingView } from "@/components/ui";
import { KeyboardAvoider } from "@/components/KeyboardAvoider";
import { ChatMarkdown } from "@/components/ChatMarkdown";
import { colors, radii, spacing } from "@/lib/theme";

interface StreamingState {
  active: boolean;
  /** Optimistic echo of the user message until the reload swaps in the persisted copy. */
  userText?: string | undefined;
  /** Buffered text for the in-flight assistant message. */
  text: string;
  toolUses: Array<{ id: string; name: string; executed?: boolean }>;
  error?: string | undefined;
}

export default function ConversationScreen() {
  const { conversationId } = useLocalSearchParams<{ conversationId: string }>();
  const { api, orgId } = useOrgApi();
  const queryClient = useQueryClient();
  const client = useMemo(() => createBearerChatClient(api, orgId), [api, orgId]);
  const scrollRef = useRef<ScrollView>(null);

  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState<StreamingState>({
    active: false,
    text: "",
    toolUses: [],
  });
  /** Seconds remaining of a client-side sleep the agent requested. */
  const [sleeping, setSleeping] = useState<number | null>(null);
  /**
   * tool_use ids of sleeps still counting down — their persisted "Slept N
   * seconds" markers stay hidden until the wait has actually happened.
   */
  const [activeSleepIds, setActiveSleepIds] = useState<ReadonlySet<string>>(new Set());
  // Ref mirror for callbacks that must not resume mid-countdown (approving a
  // destructive action while a sleep from the same batch is still running).
  const sleepingRef = useRef(false);
  const [expandedTools, setExpandedTools] = useState<ReadonlySet<string>>(new Set());

  const detailKey = ["chat-conversation", orgId, conversationId] as const;
  const spendKey = ["chat-spend", orgId] as const;

  const detail = useQuery({
    queryKey: detailKey,
    queryFn: () => client.getConversation(conversationId),
  });

  const spend = useQuery({
    queryKey: spendKey,
    queryFn: () => client.getSpend(),
  });

  const reload = useCallback(
    async (opts?: { clearStreamingBuffer?: boolean }) => {
      const [data, s] = await Promise.all([
        client.getConversation(conversationId),
        client.getSpend(),
      ]);
      // Swap persisted data in and clear the streaming buffer in the same
      // synchronous block so React batches them — clearing a render later
      // flashes the turn's text twice (persisted + still-buffered).
      queryClient.setQueryData(detailKey, data);
      queryClient.setQueryData(spendKey, s);
      if (opts?.clearStreamingBuffer) {
        setStreaming((st) => ({ ...st, userText: undefined, text: "", toolUses: [] }));
      }
    },
    [client, conversationId, queryClient, detailKey, spendKey],
  );

  const startStream = useCallback(
    async (body: { text?: string; resume?: boolean }) => {
      setStreaming({ active: true, userText: body.text, text: "", toolUses: [] });
      // Longest sleep the agent requested this turn; the wait runs here on
      // the client after the stream suspends, then hands back to the server.
      let sleepSeconds = 0;

      try {
        for await (const ev of client.streamTurn(conversationId, body)) {
          if (ev.type === "text_delta") {
            const delta = ev["delta"] as string;
            setStreaming((s) => ({ ...s, text: s.text + delta }));
          } else if (ev.type === "sleep") {
            sleepSeconds = Math.max(sleepSeconds, Number(ev["seconds"]) || 0);
            const toolUseId = ev["toolUseId"] as string;
            setActiveSleepIds((ids) => new Set(ids).add(toolUseId));
          } else if (ev.type === "tool_use_start") {
            // Sleep renders as its own indicator, not as a tool card.
            if (ev["name"] === "sleep") continue;
            setStreaming((s) => ({
              ...s,
              toolUses: [
                ...s.toolUses,
                { id: ev["toolUseId"] as string, name: ev["name"] as string },
              ],
            }));
          } else if (ev.type === "tool_executed") {
            const id = ev["toolUseId"] as string;
            setStreaming((s) => ({
              ...s,
              toolUses: s.toolUses.map((t) => (t.id === id ? { ...t, executed: true } : t)),
            }));
          } else if (ev.type === "turn_end") {
            if (ev["hasPending"]) break;
            // Not necessarily the end of the loop: after auto-run tools the
            // server feeds the results back to the model and streams another
            // assistant message. Swap the in-flight buffer for the persisted
            // messages and keep reading; the stream closes when the model
            // really is done.
            await reload({ clearStreamingBuffer: true });
          } else if (ev.type === "spend_blocked") {
            const cap = microsToUsd(Number(ev["monthlyCapMicros"]));
            setStreaming((s) => ({
              ...s,
              error: ev["freeTier"]
                ? `Free-tier chat limit reached ($${cap}/month). Add a payment method in Settings → Billing to keep chatting, or wait for next month.`
                : `Monthly chat spend cap reached ($${cap}). Increase the cap in org settings or wait for next month.`,
            }));
            break;
          } else if (ev.type === "error") {
            const message = ev["message"];
            setStreaming((s) => ({
              ...s,
              error: typeof message === "string" ? message : "The agent failed.",
            }));
            break;
          }
          // pending_action is persisted server-side; the reload picks it up.
        }
      } catch (e) {
        setStreaming((s) => ({
          ...s,
          error: e instanceof Error ? e.message : "Chat stream failed",
        }));
      }

      setStreaming((s) => ({ ...s, active: false }));
      await reload({ clearStreamingBuffer: true });
      void queryClient.invalidateQueries({ queryKey: ["chat-conversations", orgId] });

      if (sleepSeconds > 0) {
        // Client-side sleep: count down, then hand back to the server — but
        // only when nothing else is still awaiting approval (a sleep can land
        // in the same batch as a destructive tool).
        sleepingRef.current = true;
        try {
          for (let remaining = sleepSeconds; remaining > 0; remaining--) {
            setSleeping(remaining);
            await new Promise((resolve) => setTimeout(resolve, 1000));
          }
        } finally {
          sleepingRef.current = false;
          setSleeping(null);
          setActiveSleepIds(new Set());
        }
        const data = await client.getConversation(conversationId);
        const unresolved = data.pendingActions.some(
          (p) => p.status === "pending" || p.status === "approved",
        );
        const secretUnresolved = data.pendingSecretRequests.some(
          (request) => request.status === "pending" || request.status === "submitting",
        );
        if (!unresolved && !secretUnresolved) await startStream({ resume: true });
      }
    },
    [client, conversationId, queryClient, orgId, reload],
  );

  const send = useCallback(() => {
    const text = input.trim();
    if (!text || streaming.active || sleeping != null) return;
    setInput("");
    void startStream({ text });
  }, [input, streaming.active, sleeping, startStream]);

  const changeModel = useCallback(
    async (model: string) => {
      const current =
        queryClient.getQueryData<Awaited<ReturnType<typeof client.getConversation>>>(detailKey);
      if (!current || model === current.conversation.model) return;
      // Optimistic — the picker shouldn't snap back while the PATCH is in flight.
      queryClient.setQueryData(detailKey, {
        ...current,
        conversation: { ...current.conversation, model },
      });
      try {
        await client.setConversationModel(conversationId, model);
        void queryClient.invalidateQueries({ queryKey: ["chat-conversations", orgId] });
      } catch (e) {
        queryClient.setQueryData(detailKey, current);
        setStreaming((s) => ({
          ...s,
          error: e instanceof Error ? e.message : "Failed to change model",
        }));
      }
    },
    [client, conversationId, queryClient, orgId, detailKey],
  );

  const resolveAction = useCallback(
    async (pending: ChatPendingAction, action: "approve" | "reject") => {
      try {
        await client.resolvePendingAction(conversationId, pending.id, action);
        await reload();
        // A sleep from the same tool batch is still counting down — it will
        // do its own resolved-check and resume when it finishes.
        if (sleepingRef.current) return;
        const fresh = await client.getConversation(conversationId);
        const unresolved = fresh.pendingActions.some(
          (p) => p.status === "pending" || p.status === "approved",
        );
        const secretUnresolved = fresh.pendingSecretRequests.some(
          (request) => request.status === "pending" || request.status === "submitting",
        );
        if (
          !unresolved &&
          !secretUnresolved &&
          fresh.pendingActions.length + fresh.pendingSecretRequests.length > 0
        ) {
          await startStream({ resume: true });
        }
      } catch (e) {
        setStreaming((s) => ({
          ...s,
          error: e instanceof Error ? e.message : "Failed to resolve action",
        }));
      }
    },
    [client, conversationId, reload, startStream],
  );

  const submitSecret = useCallback(
    async (request: ChatPendingSecretRequest, value: string) => {
      try {
        await client.submitSecretRequest(conversationId, request.id, value);
        await reload();
        if (sleepingRef.current) return;
        const fresh = await client.getConversation(conversationId);
        const unresolved = fresh.pendingActions.some(
          (item) => item.status === "pending" || item.status === "approved",
        );
        const secretUnresolved = fresh.pendingSecretRequests.some(
          (item) => item.status === "pending" || item.status === "submitting",
        );
        if (!unresolved && !secretUnresolved) await startStream({ resume: true });
      } catch {
        throw new Error("Secret could not be stored. Try again.");
      }
    },
    [client, conversationId, reload, startStream],
  );

  const toggleTool = useCallback((id: string) => {
    setExpandedTools((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const messages = detail.data?.messages ?? [];
  const pendingActions = detail.data?.pendingActions ?? [];
  const conversation = detail.data?.conversation;

  const pendingByToolUseId = useMemo(
    () => new Map(pendingActions.map((p) => [p.toolUseId, p])),
    [pendingActions],
  );
  const pendingSecretsByToolUseId = useMemo(
    () =>
      new Map(
        (detail.data?.pendingSecretRequests ?? []).map((request) => [request.toolUseId, request]),
      ),
    [detail.data?.pendingSecretRequests],
  );

  // Tool results live in follow-up user messages; index them by tool_use_id so
  // each result renders inside its tool card instead of as a user bubble.
  const toolResultsById = useMemo(() => {
    const m = new Map<string, { text: string; isError: boolean }>();
    for (const msg of messages) {
      for (const block of msg.content) {
        if (block.type !== "tool_result") continue;
        const text = Array.isArray(block.content)
          ? block.content.map((c) => c.text).join("\n")
          : block.content;
        m.set(block.tool_use_id, { text, isError: !!block.is_error });
      }
    }
    return m;
  }, [messages]);

  // Messages that are pure tool plumbing (only tool_result blocks) are hidden;
  // their content shows up inside the corresponding tool card.
  const visibleMessages = useMemo(
    () => messages.filter((m) => !m.content.every((b) => b.type === "tool_result")),
    [messages],
  );

  if (detail.isLoading) return <LoadingView />;
  if (detail.isError) {
    return (
      <ErrorView
        message={detail.error instanceof Error ? detail.error.message : "Failed to load"}
        onRetry={() => void detail.refetch()}
      />
    );
  }

  return (
    <KeyboardAvoider style={{ backgroundColor: colors.background }}>
      <View style={styles.header}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0 }}>
          <View style={styles.modelRow}>
            {CHAT_MODELS.map((m) => {
              const selected = conversation?.model === m.id;
              return (
                <Pressable
                  key={m.id}
                  accessibilityRole="button"
                  disabled={streaming.active}
                  onPress={() => void changeModel(m.id)}
                  style={[styles.modelChip, selected && styles.modelChipSelected]}
                >
                  <Text style={[styles.modelChipText, selected && styles.modelChipTextSelected]}>
                    {m.label}
                  </Text>
                </Pressable>
              );
            })}
            {conversation && !CHAT_MODELS.some((m) => m.id === conversation.model) && (
              <View style={[styles.modelChip, styles.modelChipSelected]}>
                <Text style={styles.modelChipTextSelected}>{conversation.model} (legacy)</Text>
              </View>
            )}
          </View>
        </ScrollView>
        {spend.data ? (
          <Text style={styles.spendLine}>
            Spent this month: ${microsToUsd(spend.data.monthToDateMicros)}
            {spend.data.monthlyCapMicros != null
              ? ` / $${microsToUsd(spend.data.monthlyCapMicros)}`
              : ""}
            {spend.data.freeTier
              ? " (free tier)"
              : spend.data.complimentary
                ? " (complimentary)"
                : ""}
            {spend.data.exceeded ? " — cap reached" : ""}
          </Text>
        ) : null}
      </View>
      <ScrollView
        ref={scrollRef}
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: spacing.lg, gap: spacing.sm }}
        onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: true })}
      >
        {visibleMessages.map((m) => (
          <MessageView
            key={m.id}
            message={m}
            pendingByToolUseId={pendingByToolUseId}
            pendingSecretsByToolUseId={pendingSecretsByToolUseId}
            toolResults={toolResultsById}
            activeSleepIds={activeSleepIds}
            expandedTools={expandedTools}
            onToggleTool={toggleTool}
            onResolve={resolveAction}
            onSubmitSecret={submitSecret}
          />
        ))}
        {streaming.userText != null && (
          <View style={[styles.bubble, styles.bubbleUser]}>
            <Text style={styles.userText}>{streaming.userText}</Text>
          </View>
        )}
        {streaming.active && (
          <View style={{ gap: spacing.sm }}>
            {streaming.text.length > 0 && <ChatMarkdown text={streaming.text} />}
            {streaming.toolUses.map((t) => (
              <View key={t.id} style={styles.toolCard}>
                <View style={styles.toolCardHeader}>
                  <Text style={styles.toolName}>{t.name}</Text>
                  <Text style={t.executed ? styles.toolStatusDone : styles.toolStatusMuted}>
                    {t.executed ? "Done" : "Running…"}
                  </Text>
                </View>
              </View>
            ))}
            {streaming.text.length === 0 && streaming.toolUses.length === 0 && (
              <Text style={styles.faintLine}>Thinking…</Text>
            )}
          </View>
        )}
        {sleeping != null && (
          <Text style={styles.faintLine}>
            Sleeping {sleeping} second{sleeping === 1 ? "" : "s"}…
          </Text>
        )}
        {streaming.error != null && <Text style={styles.errorLine}>{streaming.error}</Text>}
      </ScrollView>
      <View style={styles.inputRow}>
        <TextInput
          style={styles.input}
          value={input}
          onChangeText={setInput}
          placeholder="Ask about your infrastructure…"
          placeholderTextColor={colors.textFaint}
          multiline
          editable={!streaming.active && sleeping == null}
        />
        <Pressable
          accessibilityRole="button"
          onPress={send}
          disabled={streaming.active || sleeping != null || input.trim().length === 0}
          style={({ pressed }) => [
            styles.sendButton,
            (pressed || streaming.active || sleeping != null || input.trim().length === 0) && {
              opacity: 0.5,
            },
          ]}
        >
          <Text style={styles.sendLabel}>
            {streaming.active || sleeping != null ? "…" : "Send"}
          </Text>
        </Pressable>
      </View>
    </KeyboardAvoider>
  );
}

function MessageView({
  message,
  pendingByToolUseId,
  pendingSecretsByToolUseId,
  toolResults,
  activeSleepIds,
  expandedTools,
  onToggleTool,
  onResolve,
  onSubmitSecret,
}: {
  message: ChatConversationMessage;
  pendingByToolUseId: Map<string, ChatPendingAction>;
  pendingSecretsByToolUseId: Map<string, ChatPendingSecretRequest>;
  toolResults: Map<string, { text: string; isError: boolean }>;
  activeSleepIds: ReadonlySet<string>;
  expandedTools: ReadonlySet<string>;
  onToggleTool: (id: string) => void;
  onResolve: (pending: ChatPendingAction, action: "approve" | "reject") => Promise<void>;
  onSubmitSecret: (request: ChatPendingSecretRequest, value: string) => Promise<void>;
}) {
  // DM layout: the user's messages are right-aligned bubbles, the assistant
  // replies flow plainly on the left.
  if (message.role === "user") {
    const text = message.content
      .filter((b): b is Extract<ChatContentBlock, { type: "text" }> => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    return (
      <View style={[styles.bubble, styles.bubbleUser]}>
        <Text style={styles.userText}>{text}</Text>
      </View>
    );
  }
  return (
    <View style={{ gap: spacing.sm }}>
      {message.content.map((block, i) => (
        <BlockView
          key={i}
          block={block}
          pending={block.type === "tool_use" ? pendingByToolUseId.get(block.id) : undefined}
          pendingSecret={
            block.type === "tool_use" ? pendingSecretsByToolUseId.get(block.id) : undefined
          }
          result={block.type === "tool_use" ? toolResults.get(block.id) : undefined}
          sleepInProgress={block.type === "tool_use" && activeSleepIds.has(block.id)}
          expanded={block.type === "tool_use" && expandedTools.has(block.id)}
          onToggle={onToggleTool}
          onResolve={onResolve}
          onSubmitSecret={onSubmitSecret}
        />
      ))}
    </View>
  );
}

function BlockView({
  block,
  pending,
  pendingSecret,
  result,
  sleepInProgress,
  expanded,
  onToggle,
  onResolve,
  onSubmitSecret,
}: {
  block: ChatContentBlock;
  pending: ChatPendingAction | undefined;
  pendingSecret: ChatPendingSecretRequest | undefined;
  result: { text: string; isError: boolean } | undefined;
  /** True while this sleep tool_use is still counting down client-side. */
  sleepInProgress: boolean;
  expanded: boolean;
  onToggle: (id: string) => void;
  onResolve: (pending: ChatPendingAction, action: "approve" | "reject") => Promise<void>;
  onSubmitSecret: (request: ChatPendingSecretRequest, value: string) => Promise<void>;
}) {
  // Approve executes the tool synchronously server-side (a workflow run can
  // take minutes), so the buttons must lock and the label must say the action
  // is underway — otherwise the card looks hung and invites a second tap.
  const [resolving, setResolving] = useState<"approve" | "reject" | null>(null);

  async function resolve(target: ChatPendingAction, action: "approve" | "reject"): Promise<void> {
    if (resolving) return;
    setResolving(action);
    try {
      await onResolve(target, action);
    } finally {
      setResolving(null);
    }
  }

  if (block.type === "text") {
    return <ChatMarkdown text={block.text} />;
  }
  if (block.type !== "tool_use") {
    // tool_result blocks render inside their tool card; nothing standalone.
    return null;
  }
  // Sleep is not a real tool call — render it as a quiet marker, matching the
  // live "Sleeping N seconds…" indicator. While the countdown is still
  // running, show nothing here (the live indicator covers it): the past tense
  // would be a lie.
  if (block.name === "sleep") {
    if (sleepInProgress) return null;
    const secs = Number(block.input["seconds"]);
    return (
      <Text style={styles.sleepMarker}>Slept {Number.isFinite(secs) ? secs : "a few"} seconds</Text>
    );
  }
  if (block.name === "write_workflow_secret") {
    return pendingSecret ? (
      <MobileSecretRequest request={pendingSecret} onSubmit={onSubmitSecret} />
    ) : null;
  }

  const status = pending?.status ?? (result?.isError ? "errored" : "executed");
  const statusLabel =
    status === "pending"
      ? resolving === "approve"
        ? "Running…"
        : resolving === "reject"
          ? "Rejecting…"
          : "Pending approval"
      : status === "approved"
        ? "Running…"
        : status === "rejected"
          ? "Rejected"
          : status === "errored"
            ? "Errored"
            : "Done";
  const statusStyle =
    status === "pending" && !resolving
      ? styles.toolStatusWarning
      : status === "rejected" || status === "errored"
        ? styles.toolStatusError
        : status === "executed"
          ? styles.toolStatusDone
          : styles.toolStatusMuted;
  const resultText = pending?.result ?? result?.text;
  // While awaiting approval the input must be visible — the user is deciding
  // whether to run it. Otherwise collapsed until tapped.
  const showDetails = expanded || status === "pending";

  return (
    <View style={styles.toolCard}>
      <Pressable
        accessibilityRole="button"
        onPress={() => onToggle(block.id)}
        style={styles.toolCardHeader}
      >
        <Text style={styles.toolName}>{block.name}</Text>
        <Text style={statusStyle}>{statusLabel}</Text>
      </Pressable>
      {pending?.status === "pending" && (
        <View style={styles.toolActions}>
          <Button
            label="Approve"
            disabled={resolving !== null}
            onPress={() => void resolve(pending, "approve")}
          />
          <Button
            label="Reject"
            variant="secondary"
            disabled={resolving !== null}
            onPress={() => void resolve(pending, "reject")}
          />
        </View>
      )}
      {showDetails && (
        <View style={styles.toolDetails}>
          <Text style={styles.toolDetailLabel}>Input</Text>
          <Text style={styles.toolDetailText}>{JSON.stringify(block.input, null, 2)}</Text>
          {resultText != null && (
            <>
              <Text style={styles.toolDetailLabel}>
                Result{(pending?.isError ?? result?.isError) ? " (error)" : ""}
              </Text>
              <Text style={styles.toolDetailText}>{resultText}</Text>
            </>
          )}
        </View>
      )}
    </View>
  );
}

function MobileSecretRequest({
  request,
  onSubmit,
}: {
  request: ChatPendingSecretRequest;
  onSubmit: (request: ChatPendingSecretRequest, value: string) => Promise<void>;
}) {
  const [value, setValue] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const resolved = request.status === "stored";

  async function submit(): Promise<void> {
    if (submitting || resolved || value.length === 0) return;
    const submittedValue = value;
    setValue("");
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit(request, submittedValue);
    } catch {
      setError("Secret could not be stored. Try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <View style={styles.toolCard}>
      <View style={styles.toolCardHeader}>
        <Text style={styles.secretTitle}>{request.title ?? `Enter ${request.name}`}</Text>
        <Text style={resolved ? styles.toolStatusDone : styles.toolStatusWarning}>
          {resolved ? "Stored" : submitting ? "Storing…" : "Value required"}
        </Text>
      </View>
      {request.description ? (
        <Text style={styles.secretDescription}>{request.description}</Text>
      ) : null}
      {!resolved && (
        <View style={styles.secretForm}>
          <TextInput
            style={styles.secretInput}
            value={value}
            onChangeText={setValue}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            editable={!submitting && request.status !== "submitting"}
            onSubmitEditing={() => void submit()}
            accessibilityLabel={request.title ?? `Secret value for ${request.name}`}
          />
          <Button
            label={submitting ? "Storing…" : "Store"}
            disabled={submitting || request.status === "submitting" || value.length === 0}
            onPress={() => void submit()}
          />
          {error ? <Text style={styles.errorLine}>{error}</Text> : null}
          <Text style={styles.secretHint}>
            Sent directly to encrypted secret storage. It is never shown to the model.
          </Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    gap: spacing.xs,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: spacing.xs,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  modelRow: { flexDirection: "row", gap: spacing.sm },
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
  spendLine: { color: colors.textMuted, fontSize: 12 },
  bubble: {
    borderRadius: radii.md,
    padding: spacing.md,
    maxWidth: "88%",
  },
  bubbleUser: {
    alignSelf: "flex-end",
    backgroundColor: colors.accentPressed,
  },
  userText: { color: "#fff", fontSize: 15, lineHeight: 21 },
  faintLine: { color: colors.textFaint, fontSize: 13 },
  sleepMarker: { color: colors.textFaint, fontSize: 12, fontStyle: "italic" },
  errorLine: { color: colors.danger, fontSize: 13 },
  toolCard: {
    alignSelf: "stretch",
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radii.sm,
  },
  toolCardHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  toolName: { color: colors.textSecondary, fontSize: 12, fontFamily: "Menlo" },
  toolStatusMuted: { color: colors.textMuted, fontSize: 12 },
  toolStatusDone: { color: colors.success, fontSize: 12 },
  toolStatusWarning: { color: colors.warning, fontSize: 12 },
  toolStatusError: { color: colors.danger, fontSize: 12 },
  toolActions: {
    flexDirection: "row",
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.sm,
  },
  toolDetails: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    padding: spacing.md,
    gap: spacing.xs,
  },
  toolDetailLabel: { color: colors.textFaint, fontSize: 11 },
  toolDetailText: { color: colors.textMuted, fontSize: 11, fontFamily: "Menlo" },
  secretTitle: { color: colors.textSecondary, fontSize: 13, fontWeight: "600" },
  secretDescription: {
    color: colors.textMuted,
    fontSize: 12,
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.sm,
  },
  secretForm: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    padding: spacing.md,
    gap: spacing.sm,
  },
  secretInput: {
    color: colors.text,
    backgroundColor: colors.background,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radii.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  secretHint: { color: colors.textFaint, fontSize: 11 },
  inputRow: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: spacing.sm,
    padding: spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    backgroundColor: colors.surface,
  },
  input: {
    flex: 1,
    color: colors.text,
    fontSize: 15,
    backgroundColor: colors.background,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radii.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    maxHeight: 120,
  },
  sendButton: {
    backgroundColor: colors.accent,
    borderRadius: radii.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm + 2,
  },
  sendLabel: { color: "#fff", fontSize: 14, fontWeight: "600" },
});
