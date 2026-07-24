import { useMemo } from "react";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useOrgApi } from "@/lib/auth/AuthProvider";
import {
  Button,
  Card,
  EmptyView,
  ErrorView,
  LoadingView,
  Row,
  Screen,
  SectionTitle,
} from "@/components/ui";

interface ResourceRow {
  id: string;
  pluginId: string;
  resourceTypeId: string;
  accountId: string;
  displayName: string;
  externalId: string | null;
  parentResourceId: string | null;
}

export default function AccountResources() {
  const router = useRouter();
  const { accountId } = useLocalSearchParams<{ accountId: string }>();
  const { api, orgId } = useOrgApi();
  const queryClient = useQueryClient();

  const resources = useQuery({
    queryKey: ["account-resources", orgId, accountId],
    queryFn: () =>
      api.org<ResourceRow[]>(
        orgId,
        `/accounts/${encodeURIComponent(accountId)}/resources?topLevelOnly=true`,
      ),
  });

  const sync = useMutation({
    mutationFn: () =>
      api.org(orgId, `/accounts/${encodeURIComponent(accountId)}/sync`, { method: "POST" }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["account-resources", orgId, accountId] }),
  });

  const grouped = useMemo(() => {
    const groups = new Map<string, ResourceRow[]>();
    for (const r of resources.data ?? []) {
      const list = groups.get(r.resourceTypeId) ?? [];
      list.push(r);
      groups.set(r.resourceTypeId, list);
    }
    return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [resources.data]);

  if (resources.isLoading) return <LoadingView />;
  if (resources.isError) {
    return (
      <ErrorView
        message={resources.error instanceof Error ? resources.error.message : "Failed to load"}
        onRetry={() => void resources.refetch()}
      />
    );
  }

  return (
    <Screen onRefresh={() => void resources.refetch()} refreshing={resources.isRefetching}>
      <Button
        label={sync.isPending ? "Syncing…" : "Sync from provider"}
        variant="secondary"
        disabled={sync.isPending}
        onPress={() => sync.mutate()}
      />
      {grouped.length === 0 ? (
        <EmptyView message="No resources synced for this account yet." />
      ) : (
        grouped.map(([typeId, rows]) => (
          <Card key={typeId}>
            <SectionTitle>{typeId}</SectionTitle>
            {rows.map((r) => (
              <Row
                key={r.id}
                title={r.displayName}
                subtitle={r.externalId ?? undefined}
                onPress={() =>
                  router.push(
                    `/org/${orgId}/resources/${encodeURIComponent(r.pluginId)}/${encodeURIComponent(r.resourceTypeId)}/${encodeURIComponent(r.id)}`,
                  )
                }
              />
            ))}
          </Card>
        ))
      )}
    </Screen>
  );
}
