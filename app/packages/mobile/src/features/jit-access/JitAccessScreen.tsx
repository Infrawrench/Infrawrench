import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Text, View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  JIT_LIMITS,
  actOnJitRequest,
  createJitRequest,
  extendJitRequest,
  fetchJitPolicies,
  fetchJitPrincipal,
  fetchJitRequests,
  formatElevationCountdown,
  formatGrantDuration,
  isJitConflict,
  jitExtensionHeadroom,
  jitStatusLabel,
  type JitAccessRequest,
  type JitPolicy,
  type JitRequestAction,
} from "@infrawrench/client-core";
import { useOrgApi } from "@/lib/auth/AuthProvider";
import { useOrgPermissions } from "@/lib/permissions";
import { Button, Card, ErrorView, LoadingView, Screen, SectionTitle } from "@/components/ui";
import { ChipSelect, Sheet, SheetActions, TextField } from "@/components/form";
import { colors, radii, spacing } from "@/lib/theme";

/**
 * Just-in-time access on a phone: ask for a cloud role under a policy, and
 * approve or deny a colleague's ask. The native counterpart of the shared web
 * panel (`ui/src/jit-access/JitAccessPanel.tsx`); mobile cannot load that one.
 *
 * Unlike break-glass, raising works here too: every choice comes from a policy
 * an admin wrote (pickers, not a permission catalog), so the form is chips and
 * one reason field.
 *
 * Deciding is two taps, never one, including from the notification's own
 * Approve/Deny buttons: those open the app on this screen with `action=` and
 * the same confirmation that names who, what, where and for how long.
 */

const POLL_MS = 15_000;
const DURATIONS = [15, 30, 60, 120, 240, 480, 720];

export default function JitAccessScreen() {
  const { api, orgId } = useOrgApi();
  const queryClient = useQueryClient();
  const { has, loading: permsLoading } = useOrgPermissions();
  const canRead = has("access:read");
  const canRequest = has("access:request");
  const { requestId: focusedId, action } = useLocalSearchParams<{
    requestId?: string;
    action?: string;
  }>();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const resolvePrincipal = useCallback(
    (policyId: string) => fetchJitPrincipal(api, orgId, policyId),
    [api, orgId],
  );

  const requestsKey = ["jit-requests", orgId] as const;
  const requests = useQuery({
    queryKey: requestsKey,
    queryFn: () => fetchJitRequests(api, orgId),
    enabled: canRead,
    refetchInterval: POLL_MS,
  });
  const policies = useQuery({
    queryKey: ["jit-policies", orgId],
    queryFn: () => fetchJitPolicies(api, orgId),
    enabled: canRead,
  });

  const act = useMutation({
    mutationFn: async (args: {
      request: JitAccessRequest;
      action: JitRequestAction | "extend";
      minutes?: number;
    }) =>
      args.action === "extend"
        ? extendJitRequest(api, orgId, args.request.id, args.minutes ?? 30)
        : actOnJitRequest(api, orgId, args.request.id, args.action),
    onMutate: ({ request }) => setBusyId(request.id),
    onError: (error) => {
      Alert.alert(
        isJitConflict(error) ? "Already handled" : "That did not work",
        error instanceof Error ? error.message : "The change could not be made.",
      );
    },
    onSettled: () => {
      setBusyId(null);
      void queryClient.invalidateQueries({ queryKey: requestsKey });
    },
  });

  const confirm = (request: JitAccessRequest, what: JitRequestAction | "extend", minutes = 30) => {
    const who = request.userName ?? "A member";
    const where = `${request.roleName} on ${request.scopeName}${request.accountName ? ` (${request.accountName})` : ""}`;
    const titles: Record<JitRequestAction | "extend", string> = {
      approve: `Approve ${who}?`,
      deny: `Deny ${who}?`,
      cancel: "Cancel your request?",
      revoke: "End this grant now?",
      extend: `Extend by ${formatGrantDuration(minutes)}?`,
    };
    const detail = [
      request.reason,
      "",
      `Role: ${where}`,
      `Granted to: ${request.principalName}${request.principalMatched ? "" : " (not matched from the requester's email)"}`,
      `Duration: ${formatGrantDuration(request.durationMinutes + request.extendedMinutes)}`,
      ...(request.ticket ? [`Ticket: ${request.ticket}`] : []),
    ].join("\n");
    Alert.alert(titles[what], detail, [
      { text: "Back", style: "cancel" },
      {
        text: what === "approve" ? "Approve" : what === "extend" ? "Extend" : "Confirm",
        style: what === "approve" || what === "extend" ? "default" : "destructive",
        onPress: () => act.mutate({ request, action: what, minutes }),
      },
    ]);
  };

  // A notification action button lands here with `action=`; open its
  // confirmation once the request has loaded, and only once.
  const actionHandled = useRef(false);
  useEffect(() => {
    if (actionHandled.current || !focusedId || (action !== "approve" && action !== "deny")) return;
    const request = requests.data?.find((r) => r.id === focusedId);
    if (!request) return;
    actionHandled.current = true;
    if (request.canDecide) confirm(request, action);
    else
      Alert.alert(
        "Nothing to decide",
        "This request has already been handled, or is not yours to decide.",
      );
    // `confirm` is recreated each render; the ref makes this fire once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requests.data, focusedId, action]);

  const groups = useMemo(() => {
    const rows = requests.data ?? [];
    const holding = new Set(["granting", "active", "revoking", "revoke_failed"]);
    const pending = rows.filter((r) => r.status === "pending");
    return {
      pending: focusedId
        ? [...pending].sort((a, b) => (a.id === focusedId ? -1 : b.id === focusedId ? 1 : 0))
        : pending,
      holding: rows.filter((r) => holding.has(r.status)),
      recent: rows.filter((r) => r.status !== "pending" && !holding.has(r.status)).slice(0, 20),
    };
  }, [requests.data, focusedId]);

  if (permsLoading || (canRead && requests.isLoading)) return <LoadingView />;
  if (!canRead) {
    return (
      <Screen>
        <SectionTitle>Just-in-time access</SectionTitle>
        <Card>
          <Text style={{ color: colors.textMuted, fontSize: 13 }}>
            Your role does not include access:read, so you cannot see just-in-time access requests.
          </Text>
        </Card>
      </Screen>
    );
  }
  if (requests.isError) {
    return (
      <ErrorView
        message={
          requests.error instanceof Error ? requests.error.message : "Failed to load requests"
        }
        onRetry={() => void requests.refetch()}
      />
    );
  }

  const requestable = (policies.data ?? []).filter((p) => p.canRequest);
  const maxFor = (r: JitAccessRequest) =>
    policies.data?.find((p) => p.id === r.policyId)?.maxDurationMinutes ?? 0;

  const renderCard = (r: JitAccessRequest) => (
    <JitRequestCard
      key={r.id}
      request={r}
      busy={busyId === r.id}
      highlighted={r.id === focusedId}
      headroom={jitExtensionHeadroom(r, maxFor(r))}
      onAction={(what, minutes) => confirm(r, what, minutes)}
    />
  );

  return (
    <Screen onRefresh={() => void requests.refetch()} refreshing={requests.isRefetching}>
      {canRequest && requestable.length > 0 ? (
        <Button label="Request access" onPress={() => setAsking(true)} />
      ) : null}

      <SectionTitle>Waiting for a decision</SectionTitle>
      {groups.pending.length === 0 ? (
        <Card>
          <Text style={{ color: colors.textMuted, fontSize: 13 }}>Nothing is waiting.</Text>
        </Card>
      ) : (
        <View style={{ gap: spacing.md }}>{groups.pending.map(renderCard)}</View>
      )}

      {groups.holding.length > 0 ? (
        <>
          <SectionTitle>Granted now</SectionTitle>
          <View style={{ gap: spacing.md }}>{groups.holding.map(renderCard)}</View>
        </>
      ) : null}

      {groups.recent.length > 0 ? (
        <>
          <SectionTitle>Recent</SectionTitle>
          <View style={{ gap: spacing.md }}>{groups.recent.map(renderCard)}</View>
        </>
      ) : null}

      {asking ? (
        <RequestSheet
          policies={requestable}
          onClose={() => setAsking(false)}
          onSubmit={async (input) => {
            await createJitRequest(api, orgId, input);
            setAsking(false);
            void queryClient.invalidateQueries({ queryKey: requestsKey });
          }}
          resolvePrincipal={resolvePrincipal}
        />
      ) : null}
    </Screen>
  );
}

function JitRequestCard({
  request: r,
  busy,
  highlighted,
  headroom,
  onAction,
}: {
  request: JitAccessRequest;
  busy: boolean;
  highlighted: boolean;
  headroom: number;
  onAction: (what: JitRequestAction | "extend", minutes?: number) => void;
}) {
  const failing = r.status === "revoke_failed" || r.status === "grant_failed";
  return (
    <View
      style={{
        backgroundColor: colors.surface,
        borderColor: failing ? colors.danger : highlighted ? colors.warning : colors.border,
        borderWidth: highlighted || failing ? 1.5 : 1,
        borderRadius: radii.md,
        padding: spacing.lg,
        gap: spacing.sm,
      }}
    >
      {highlighted ? (
        <Text style={{ color: colors.warning, fontSize: 11, fontWeight: "600" }}>
          From your notification
        </Text>
      ) : null}
      <Text style={{ color: colors.text, fontSize: 15, fontWeight: "600" }}>
        {r.roleName} on {r.scopeName}
      </Text>
      <Text style={{ color: colors.textMuted, fontSize: 12 }}>
        {jitStatusLabel(r.status)} · {r.userName ?? "A member"} for {r.principalName} ·{" "}
        {formatGrantDuration(r.durationMinutes + r.extendedMinutes)}
        {r.status === "pending" ? ` · ${formatElevationCountdown(r.requestExpiresAt)}` : ""}
        {r.status === "active" && r.grantExpiresAt
          ? ` · ${formatElevationCountdown(r.grantExpiresAt)}`
          : ""}
      </Text>
      {!r.principalMatched ? (
        <Text style={{ color: colors.warning, fontSize: 12 }}>
          Granted to a principal not matched from the requester&apos;s email.
        </Text>
      ) : null}
      <Text style={{ color: colors.textSecondary, fontSize: 14 }}>{r.reason}</Text>
      {r.lastError && failing ? (
        <Text style={{ color: colors.danger, fontSize: 12 }}>{r.lastError}</Text>
      ) : null}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.sm }}>
        {r.canDecide ? (
          <>
            <Button label="Approve" disabled={busy} onPress={() => onAction("approve")} />
            <Button
              label="Deny"
              variant="danger"
              disabled={busy}
              onPress={() => onAction("deny")}
            />
          </>
        ) : null}
        {r.canCancel ? (
          <Button
            label="Cancel"
            variant="secondary"
            disabled={busy}
            onPress={() => onAction("cancel")}
          />
        ) : null}
        {r.canExtend && headroom >= 30 ? (
          <Button
            label="Extend 30m"
            variant="secondary"
            disabled={busy}
            onPress={() => onAction("extend", 30)}
          />
        ) : null}
        {r.canRevoke ? (
          <Button
            label="Revoke"
            variant="danger"
            disabled={busy}
            onPress={() => onAction("revoke")}
          />
        ) : null}
      </View>
    </View>
  );
}

function RequestSheet({
  policies,
  onClose,
  onSubmit,
  resolvePrincipal,
}: {
  policies: JitPolicy[];
  onClose: () => void;
  onSubmit: (input: {
    policyId: string;
    scopeId: string;
    roleId: string;
    durationMinutes: number;
    reason: string;
    ticket?: string;
  }) => Promise<void>;
  resolvePrincipal: (policyId: string) => Promise<{ principal: { name: string } | null } | null>;
}) {
  const [policyId, setPolicyId] = useState(policies[0]?.id ?? "");
  const policy = policies.find((p) => p.id === policyId) ?? null;
  const [target, setTarget] = useState("0");
  const [duration, setDuration] = useState(String(policy?.defaultDurationMinutes ?? 60));
  const [reason, setReason] = useState("");
  const [ticket, setTicket] = useState("");
  const [principal, setPrincipal] = useState<string | null | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!policy) return;
    setTarget("0");
    setDuration(String(policy.defaultDurationMinutes));
    setPrincipal(undefined);
    let cancelled = false;
    resolvePrincipal(policy.id)
      .then((res) => {
        if (!cancelled) setPrincipal(res?.principal?.name ?? null);
      })
      .catch(() => {
        if (!cancelled) setPrincipal(null);
      });
    return () => {
      cancelled = true;
    };
  }, [policy, resolvePrincipal]);

  const chosen = policy?.targets[Number(target)];
  const reasonOk = !policy?.requireReason || reason.trim().length >= JIT_LIMITS.minReasonLength;
  const ticketOk = !policy?.requireTicket || ticket.trim().length > 0;

  return (
    <Sheet
      visible
      title="Request access"
      description="Pick a role from a policy, say why, and an approver is notified."
      onClose={onClose}
      footer={
        <SheetActions
          onCancel={onClose}
          submitLabel="Send request"
          submitting={submitting}
          disabled={!chosen || !reasonOk || !ticketOk || !principal}
          onSubmit={() => {
            if (!policy || !chosen) return;
            setSubmitting(true);
            onSubmit({
              policyId: policy.id,
              scopeId: chosen.scopeId,
              roleId: chosen.roleId,
              durationMinutes: Number(duration),
              reason: reason.trim(),
              ...(ticket.trim() ? { ticket: ticket.trim() } : {}),
            })
              .catch((e: unknown) =>
                Alert.alert("Request failed", e instanceof Error ? e.message : "Try again."),
              )
              .finally(() => setSubmitting(false));
          }}
        />
      }
    >
      <ChipSelect
        label="Policy"
        options={policies.map((p) => ({ value: p.id, label: p.name }))}
        value={policyId}
        onChange={setPolicyId}
      />
      <ChipSelect
        label={policy?.labels?.roleLabel ?? "Role"}
        options={(policy?.targets ?? []).map((t, i) => ({
          value: String(i),
          label: `${t.roleName} · ${t.scopeName}`,
        }))}
        value={target}
        onChange={setTarget}
      />
      <ChipSelect
        label="For how long"
        options={DURATIONS.filter((m) => m <= (policy?.maxDurationMinutes ?? 0)).map((m) => ({
          value: String(m),
          label: formatGrantDuration(m),
        }))}
        value={duration}
        onChange={setDuration}
      />
      <Text style={{ color: principal === null ? colors.danger : colors.textMuted, fontSize: 12 }}>
        {principal === undefined
          ? "Looking you up in the provider…"
          : principal === null
            ? "Nobody in the provider matches your email. Request this one from the web or desktop app, where you can pick yourself from the provider's list."
            : `Granted to ${principal}`}
      </Text>
      <TextField
        label={policy?.requireReason ? "Reason (required)" : "Reason"}
        value={reason}
        onChangeText={setReason}
        multiline
        numberOfLines={3}
        maxLength={JIT_LIMITS.maxReasonLength}
        placeholder="What you need it for"
      />
      <TextField
        label={policy?.requireTicket ? "Ticket (required)" : "Ticket (optional)"}
        value={ticket}
        onChangeText={setTicket}
        maxLength={JIT_LIMITS.maxTicketLength}
        autoCapitalize="characters"
      />
    </Sheet>
  );
}
