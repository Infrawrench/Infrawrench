import { useRouter } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { useOrgApi } from "@/lib/auth/AuthProvider";
import { Card, EmptyView, ErrorView, LoadingView, Row, Screen } from "@/components/ui";

interface Account {
  id: string;
  pluginId: string;
  displayName: string;
  createdAt: string;
}

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
