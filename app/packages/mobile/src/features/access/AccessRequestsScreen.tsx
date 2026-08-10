import { useState } from "react";
import { Alert, Text, View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  decideAccessRequest,
  fetchAccessRequests,
  formatGrantDuration,
  isAccessDecisionConflict,
  isAccessDecisionForbidden,
  revokeAccessGrant,
  type AccessRequest,
} from "@infrawrench/client-core";
import { useOrgApi } from "@/lib/auth/AuthProvider";
import { useOrgPermissions } from "@/lib/permissions";
import { Card, ErrorView, LoadingView, Screen, SectionTitle } from "@/components/ui";
import { colors, spacing } from "@/lib/theme";
import { AccessRequestCard } from "./AccessRequestCard";

/**
 * Break-glass requests on a phone — and the reason this is the mobile surface
 * that most earns its place. A colleague blocked mid-incident, asking for a
 * permission they do not have, is the definition of something you approve from
 * wherever you are; making them wait for you to reach a laptop defeats the
 * point of having the mechanism at all.
 *
 * Read-only in one direction on purpose: you can decide here, but you cannot
 * *raise* a request. Asking needs a permission picker that cannot drift from
 * the server's catalog and a reason someone will read in six months, and
 * neither is a thing to compose one-handed. Raising stays on web and desktop.
 *
 * Deciding is two taps, never one: the card's button opens a confirmation that
 * names who is asking, exactly which permissions, for how long, and why. A
 * single mis-tap must not hand out authority.
 *
 * Requests expire on a timer and grants lapse on their own, so the list is
 * polled rather than fetched once.
 */

const POLL_MS = 15_000;

export default function AccessRequestsScreen() {
  const { api, orgId } = useOrgApi();
  const queryClient = useQueryClient();
  const { has, loading: permsLoading } = useOrgPermissions();
  const canRead = has("access:read");
  const canDecide = has("access:approve");

  // The push payload carries the request it was raised for; the deep link
  // passes it through so the screen can put that card first and say so.
  const { requestId: focusedId } = useLocalSearchParams<{ requestId?: string }>();

  const [decidingId, setDecidingId] = useState<string | null>(null);

  const key = ["access-requests", orgId] as const;
  const list = useQuery({
    queryKey: key,
    queryFn: () => fetchAccessRequests(api, orgId),
    enabled: canRead,
    refetchInterval: POLL_MS,
  });

  const decide = useMutation({
    mutationFn: ({ request, decision }: { request: AccessRequest; decision: "approve" | "deny" }) =>
      // A live grant's only action is ending it early, which is a revoke
      // rather than a decision — the request was already decided.
      request.active
        ? revokeAccessGrant(api, orgId, request.id)
        : decideAccessRequest(api, orgId, request.id, decision),
    onMutate: ({ request }) => setDecidingId(request.id),
    onSuccess: (_result, { request, decision }) => {
      Alert.alert(
        request.active ? "Ended" : decision === "approve" ? "Approved" : "Denied",
        request.active
          ? "The elevation is over. It stops applying on their next request."
          : decision === "approve"
            ? `They hold those permissions for the next ${formatGrantDuration(request.durationMinutes)}, then lose them automatically.`
            : "They were told no. Nothing was granted.",
      );
    },
    onError: (error) => {
      // Two refusals on principle, and neither should ever be retried: you
      // cannot decide your own request, and you cannot grant what you do not
      // hold. Say which one it was.
      if (isAccessDecisionForbidden(error)) {
        Alert.alert(
          "Not allowed",
          error instanceof Error
            ? error.message
            : "You cannot decide this request — either it is yours, or it asks for permissions you do not hold yourself.",
        );
        return;
      }
      if (isAccessDecisionConflict(error)) {
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
      void queryClient.invalidateQueries({ queryKey: key });
    },
  });

  /** Step two: name exactly what is being handed out, then send it. */
  const confirmDecide = (request: AccessRequest, decision: "approve" | "deny") => {
    const who = request.userName ?? "A member";
    if (request.active) {
      Alert.alert(
        `End ${who}'s elevation now?`,
        `They lose ${request.permissions.join(", ")} immediately.`,
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "End now",
            style: "destructive",
            onPress: () => decide.mutate({ request, decision }),
          },
        ],
      );
      return;
    }

    const detail = [
      request.reason,
      "",
      `Permissions: ${request.permissions.join(", ")}`,
      `Duration: ${formatGrantDuration(request.durationMinutes)}`,
      "",
      decision === "approve"
        ? "Approving gives them those permissions everywhere at once — the apps, the API, terminals and the assistant — until the window closes."
        : "Denying tells them no. They can ask again.",
    ].join("\n");

    Alert.alert(decision === "approve" ? `Approve ${who}?` : `Deny ${who}?`, detail, [
      { text: "Cancel", style: "cancel" },
      {
        text: decision === "approve" ? "Approve" : "Deny",
        style: decision === "approve" ? "default" : "destructive",
        onPress: () => decide.mutate({ request, decision }),
      },
    ]);
  };

  if (permsLoading || (canRead && list.isLoading)) return <LoadingView />;

  if (!canRead) {
    return (
      <Screen>
        <SectionTitle>Break-glass access</SectionTitle>
        <Card>
          <Text style={{ color: colors.textMuted, fontSize: 13 }}>
            Your role does not include access:read, so you cannot see this organization&apos;s
            access requests.
          </Text>
        </Card>
      </Screen>
    );
  }

  if (list.isError) {
    return (
      <ErrorView
        message={
          list.error instanceof Error ? list.error.message : "Failed to load access requests"
        }
        onRetry={() => void list.refetch()}
      />
    );
  }

  const all = list.data ?? [];
  const live = all.filter((r) => r.active);
  const pending = all.filter((r) => r.status === "pending");
  const ordered = focusedId
    ? [...pending].sort((a, b) => (a.id === focusedId ? -1 : b.id === focusedId ? 1 : 0))
    : pending;
  const focusedMissing = Boolean(focusedId) && !pending.some((r) => r.id === focusedId);

  return (
    <Screen onRefresh={() => void list.refetch()} refreshing={list.isRefetching}>
      {!canDecide ? (
        <Card>
          <Text style={{ color: colors.textMuted, fontSize: 13 }}>
            You can see what is waiting, but deciding needs the access:approve permission.
          </Text>
        </Card>
      ) : null}

      {focusedMissing ? (
        <Card>
          <Text style={{ color: colors.warning, fontSize: 13 }}>
            The request your notification was about is no longer waiting — someone decided it, or it
            expired and was treated as a denial.
          </Text>
        </Card>
      ) : null}

      {live.length > 0 ? (
        <>
          <SectionTitle>Live elevations</SectionTitle>
          <View style={{ gap: spacing.md }}>
            {live.map((request) => (
              <AccessRequestCard
                key={request.id}
                request={request}
                canDecide={canDecide}
                deciding={decidingId === request.id}
                onDecide={(decision) => confirmDecide(request, decision)}
              />
            ))}
          </View>
        </>
      ) : null}

      <SectionTitle>Waiting for a decision</SectionTitle>
      {ordered.length === 0 ? (
        <Card>
          <Text style={{ color: colors.textMuted, fontSize: 13 }}>
            Nothing waiting. Requests appear here when someone asks for a permission their role does
            not grant.
          </Text>
        </Card>
      ) : (
        <View style={{ gap: spacing.md }}>
          {ordered.map((request) => (
            <AccessRequestCard
              key={request.id}
              request={request}
              canDecide={canDecide}
              deciding={decidingId === request.id}
              highlighted={request.id === focusedId}
              onDecide={(decision) => confirmDecide(request, decision)}
            />
          ))}
        </View>
      )}

      <Text style={{ color: colors.textFaint, fontSize: 12 }}>
        Raising a request stays on the web and desktop apps — it needs a permission picker and a
        reason somebody will read months from now. Whoever answers first decides; a second answer is
        refused rather than overwriting the first.
      </Text>
    </Screen>
  );
}
