import { useState } from "react";
import { Alert, Text, View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  decideWorkflowApproval,
  fetchWorkflowApprovals,
  formatApprovalExpiry,
  isApprovalConflict,
  type ApprovalDecision,
  type WorkflowApproval,
} from "@infrawrench/client-core";
import { useOrgApi } from "@/lib/auth/AuthProvider";
import { useOrgPermissions } from "@/lib/permissions";
import { Card, ErrorView, LoadingView, Screen, SectionTitle } from "@/components/ui";
import { colors, spacing } from "@/lib/theme";
import { ApprovalCard } from "./ApprovalCard";

/**
 * Org-wide approvals inbox — every run in the org suspended on
 * `infra.waitForApproval(...)`, and the place a `workflow_approval` push lands.
 *
 * Deciding here starts (or fails) a workflow run against real infrastructure
 * from a device that lives in a pocket, so a decision is deliberately two
 * steps: the card's button only opens a confirmation that names the request,
 * the workflow, the run and the deadline, and the decision is sent from there.
 * A single mis-tap can't land one.
 *
 * Permissions mirror web's approvals page: the listing needs `workflows:read`
 * and deciding needs `workflows:approve`, so a reader sees what is waiting with
 * no buttons on it. The server enforces both regardless.
 *
 * Requests expire on a timer, so the list is polled rather than fetched once —
 * a card that has gone stale would otherwise sit there offering a decision the
 * waiting run would ignore.
 */

const POLL_MS = 15_000;

export default function ApprovalsScreen() {
  const { api, orgId } = useOrgApi();
  const queryClient = useQueryClient();
  const { has, loading: permsLoading } = useOrgPermissions();
  const canRead = has("workflows:read");
  const canDecide = has("workflows:approve");

  // The push payload carries the request it was raised for; the deep link
  // passes it through so the inbox can put that card first and say so.
  const { approvalId: focusedId } = useLocalSearchParams<{ approvalId?: string }>();

  const [decidingId, setDecidingId] = useState<string | null>(null);

  const approvalsKey = ["workflow-approvals", orgId] as const;
  const list = useQuery({
    queryKey: approvalsKey,
    queryFn: () => fetchWorkflowApprovals(api, orgId, "pending"),
    enabled: canRead,
    refetchInterval: POLL_MS,
  });

  const decide = useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: ApprovalDecision }) =>
      decideWorkflowApproval(api, orgId, id, decision),
    onMutate: ({ id }) => setDecidingId(id),
    onSuccess: (_result, { decision }) => {
      Alert.alert(
        decision === "approve" ? "Approved" : "Denied",
        decision === "approve"
          ? "The run has been released and continues from where it paused."
          : "The run was told no and fails at this step.",
      );
    },
    onError: (error) => {
      // A conflict means someone else landed a decision first, or the window
      // closed while this screen was open. Never retry it — say so and re-list.
      if (isApprovalConflict(error)) {
        Alert.alert(
          "Already decided",
          "Someone else decided this request first, or it expired before this decision arrived. Nothing was changed.",
        );
        return;
      }
      Alert.alert(
        "Decision failed",
        error instanceof Error ? error.message : "The decision could not be recorded.",
      );
    },
    onSettled: () => {
      setDecidingId(null);
      void queryClient.invalidateQueries({ queryKey: approvalsKey });
    },
  });

  /** Step two: name exactly what is being decided, then send it. */
  const confirmDecide = (approval: WorkflowApproval, decision: ApprovalDecision) => {
    const detail = [
      approval.message,
      "",
      `Workflow: ${approval.workflowName ?? "Deleted workflow"}`,
      `Run: ${approval.runId}`,
      `Deadline: ${new Date(approval.expiresAt).toLocaleString()} (${formatApprovalExpiry(approval.expiresAt)})`,
      "",
      decision === "approve"
        ? "Approving releases the suspended run, which continues against this organization's real infrastructure."
        : "Denying fails the run at this step. It cannot be undone — the workflow has to be run again.",
    ].join("\n");

    Alert.alert(
      decision === "approve" ? `Approve “${approval.title}”?` : `Deny “${approval.title}”?`,
      detail,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: decision === "approve" ? "Approve" : "Deny",
          style: decision === "approve" ? "default" : "destructive",
          onPress: () => decide.mutate({ id: approval.id, decision }),
        },
      ],
    );
  };

  if (permsLoading || (canRead && list.isLoading)) return <LoadingView />;

  if (!canRead) {
    return (
      <Screen>
        <SectionTitle>Approvals</SectionTitle>
        <Card>
          <Text style={{ color: colors.textMuted, fontSize: 13 }}>
            Your role does not include workflows:read, so you cannot see this organization&apos;s
            approval requests.
          </Text>
        </Card>
      </Screen>
    );
  }

  if (list.isError) {
    return (
      <ErrorView
        message={list.error instanceof Error ? list.error.message : "Failed to load approvals"}
        onRetry={() => void list.refetch()}
      />
    );
  }

  const approvals = list.data ?? [];
  // The deep-linked request first — it is why the screen was opened.
  const ordered = focusedId
    ? [...approvals].sort((a, b) => (a.id === focusedId ? -1 : b.id === focusedId ? 1 : 0))
    : approvals;
  const focusedMissing = Boolean(focusedId) && !approvals.some((a) => a.id === focusedId);

  return (
    <Screen onRefresh={() => void list.refetch()} refreshing={list.isRefetching}>
      <SectionTitle>Waiting on a human</SectionTitle>

      {!canDecide ? (
        <Card>
          <Text style={{ color: colors.textMuted, fontSize: 13 }}>
            You can see what is waiting, but deciding needs the workflows:approve permission.
          </Text>
        </Card>
      ) : null}

      {focusedMissing ? (
        <Card>
          <Text style={{ color: colors.warning, fontSize: 13 }}>
            The request your notification was about is no longer pending — someone decided it, or it
            expired and was treated as a denial.
          </Text>
        </Card>
      ) : null}

      {ordered.length === 0 ? (
        <Card>
          <Text style={{ color: colors.textMuted, fontSize: 13 }}>
            Nothing waiting. Requests appear here while a workflow run is suspended on
            infra.waitForApproval(...).
          </Text>
        </Card>
      ) : (
        <View style={{ gap: spacing.md }}>
          {ordered.map((approval) => (
            <ApprovalCard
              key={approval.id}
              approval={approval}
              canDecide={canDecide}
              deciding={decidingId === approval.id}
              highlighted={approval.id === focusedId}
              onDecide={(decision) => confirmDecide(approval, decision)}
            />
          ))}
        </View>
      )}

      <Text style={{ color: colors.textFaint, fontSize: 12 }}>
        Approval requests also go to Slack, Teams and SMS wherever the Pages trigger is on. Whoever
        answers first decides — a second answer is refused rather than overwriting the first.
      </Text>
    </Screen>
  );
}
