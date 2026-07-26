import { Alert, Text } from "react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useOrgApi } from "@/lib/auth/AuthProvider";
import { Button, Card, EmptyView, ErrorView, LoadingView, Row, Screen } from "@/components/ui";
import { colors } from "@/lib/theme";

/** Shape of GET /api/org/:orgId/api-keys (web api/routes/api-keys.ts). */
interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  needsRotation: boolean;
}

export default function ApiKeysScreen() {
  const { api, orgId } = useOrgApi();
  const queryClient = useQueryClient();

  const keys = useQuery({
    queryKey: ["api-keys", orgId],
    queryFn: () => api.org<ApiKey[]>(orgId, "/api-keys"),
  });

  const revoke = useMutation({
    mutationFn: (id: string) =>
      api.org(orgId, `/api-keys/${encodeURIComponent(id)}/revoke`, { method: "POST" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["api-keys", orgId] }),
    onError: (e) => Alert.alert("Revoke failed", e instanceof Error ? e.message : "Unknown error"),
  });

  if (keys.isLoading) return <LoadingView />;
  if (keys.isError) {
    return (
      <ErrorView
        message={keys.error instanceof Error ? keys.error.message : "Failed to load"}
        onRetry={() => void keys.refetch()}
      />
    );
  }

  const list = keys.data ?? [];

  const confirmRevoke = (key: ApiKey) => {
    Alert.alert("Revoke API key", `Revoke "${key.name}" (${key.prefix}…)? This cannot be undone.`, [
      { text: "Cancel", style: "cancel" },
      { text: "Revoke", style: "destructive", onPress: () => revoke.mutate(key.id) },
    ]);
  };

  return (
    <Screen onRefresh={() => void keys.refetch()} refreshing={keys.isRefetching}>
      {list.length === 0 ? (
        <EmptyView message="No API keys yet." />
      ) : (
        <Card list>
          {list.map((k) => (
            <Row
              key={k.id}
              title={k.name}
              subtitle={`${k.prefix}… · ${k.scopes.join(", ") || "no scopes"}${
                k.lastUsedAt ? ` · last used ${new Date(k.lastUsedAt).toLocaleDateString()}` : ""
              }`}
              right={
                k.revokedAt ? (
                  <Text style={{ color: colors.textMuted, fontSize: 12 }}>Revoked</Text>
                ) : (
                  <Button
                    label="Revoke"
                    variant="secondary"
                    disabled={revoke.isPending}
                    onPress={() => confirmRevoke(k)}
                  />
                )
              }
            />
          ))}
        </Card>
      )}
      <Text style={{ color: colors.textMuted, fontSize: 12 }}>
        New API keys can only be created on the web app.
      </Text>
    </Screen>
  );
}
