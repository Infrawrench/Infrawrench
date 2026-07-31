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
  if (list.length === 0) {
    return (
      <EmptyView message="No accounts connected. Add provider accounts on the web or desktop app." />
    );
  }

  return (
    <Screen onRefresh={() => void accounts.refetch()} refreshing={accounts.isRefetching}>
      {/*
        The change timeline is org-wide but it is about resources, so it hangs
        off this tab rather than earning a seventh one — the tab bar is already
        at the width where labels ellipsize.
      */}
      <Card list>
        <Row
          title="Changes"
          subtitle="What appeared, changed or disappeared"
          onPress={() => router.push(`/org/${orgId}/changes`)}
        />
      </Card>
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
    </Screen>
  );
}
