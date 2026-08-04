import { useRouter } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { useOrgApi } from "@/lib/auth/AuthProvider";
import { Card, EmptyView, ErrorView, LoadingView, Row, Screen } from "@/components/ui";
import type { Account } from "@infrawrench/client-core";

export default function AccountsScreen() {
  const router = useRouter();
  const { api, orgId } = useOrgApi();

  const accounts = useQuery({
    queryKey: ["accounts", orgId],
    queryFn: () => api.org<Account[]>(orgId, "/accounts"),
  });

  if (accounts.isLoading) return <LoadingView />;
  if (accounts.isError) {
    return (
      <ErrorView
        message={accounts.error instanceof Error ? accounts.error.message : "Failed to load"}
        onRetry={() => void accounts.refetch()}
      />
    );
  }

  const list = accounts.data ?? [];

  return (
    <Screen onRefresh={() => void accounts.refetch()} refreshing={accounts.isRefetching}>
      {/*
        The change timeline, expiry feed and log workspace are org-wide but
        they are about resources, so they hang off this tab rather than earning
        tabs of their own — the tab bar is already at the width where labels
        ellipsize. They render even with zero accounts connected: saved log
        queries and the change feed are org rows, not per-account state.
      */}
      <Card list>
        <Row
          title="Changes"
          subtitle="What appeared, changed or disappeared"
          onPress={() => router.push(`/org/${orgId}/changes`)}
        />
        <Row
          title="Expiring soon"
          subtitle="Certs, domains, tokens and keys with deadlines"
          onPress={() => router.push(`/org/${orgId}/expiring`)}
        />
        <Row
          title="Posture"
          subtitle="Public buckets, world-open ingress, unencrypted disks"
          onPress={() => router.push(`/org/${orgId}/posture`)}
        />
        <Row
          title="Log workspace"
          subtitle="Saved multi-resource log tails and match alerts"
          onPress={() => router.push(`/org/${orgId}/log-workspaces`)}
        />
      </Card>
      {list.length === 0 ? (
        <EmptyView message="No accounts connected. Add provider accounts on the web or desktop app." />
      ) : (
        <Card list>
          {list.map((a) => (
            <Row
              key={a.id}
              title={a.displayName}
              subtitle={a.pluginId}
              onPress={() => router.push(`/org/${orgId}/accounts/${a.id}`)}
            />
          ))}
        </Card>
      )}
    </Screen>
  );
}
