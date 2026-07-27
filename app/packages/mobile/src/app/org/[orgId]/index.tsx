import { useState } from "react";
import { Alert, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Dashboard } from "@infrawrench/client-core";
import { useOrgApi } from "@/lib/auth/AuthProvider";
import { TextField } from "@/components/form";
import { Button, Card, ErrorView, LoadingView, Row, Screen } from "@/components/ui";
import { colors, spacing } from "@/lib/theme";

/**
 * The Dashboards tab: every dashboard in the org, default first. Tapping one
 * opens it on its own screen, which carries the dashboard's name in the header
 * and a back button to this list.
 *
 * This used to render the default dashboard inline with the others listed
 * underneath, which made the default the only one that felt like a place —
 * you saw its cards before you saw that alternatives existed.
 *
 * Creating one is an inline form rather than a sheet: a dashboard is a name and
 * nothing else, and everything that fills it lives one screen deeper, on the
 * dashboard itself.
 */
export default function OrgDashboards() {
  const router = useRouter();
  const { api, orgId } = useOrgApi();
  const queryClient = useQueryClient();
  const [name, setName] = useState<string | null>(null);

  const dashboards = useQuery({
    queryKey: ["dashboards", orgId],
    queryFn: () => api.org<Dashboard[]>(orgId, "/dashboards"),
  });

  const create = useMutation({
    mutationFn: (dashboardName: string) =>
      api.org<Dashboard>(orgId, "/dashboards", {
        method: "POST",
        body: JSON.stringify({ name: dashboardName }),
      }),
    onSuccess: (created) => {
      setName(null);
      void queryClient.invalidateQueries({ queryKey: ["dashboards", orgId] });
      // Straight into the new dashboard — it is empty, and adding the first
      // card is the only reason to have made it.
      if (created?.id) router.push(`/org/${orgId}/dashboard/${created.id}`);
    },
    onError: (e) =>
      Alert.alert("Couldn't create", e instanceof Error ? e.message : "Unknown error"),
  });

  if (dashboards.isLoading) return <LoadingView />;
  if (dashboards.isError) {
    return (
      <ErrorView
        message={dashboards.error instanceof Error ? dashboards.error.message : "Failed to load"}
        onRetry={() => void dashboards.refetch()}
      />
    );
  }

  // Default first, then alphabetical — the order the sidebar uses on web.
  const list = [...(dashboards.data ?? [])].sort((a, b) => {
    if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  const submit = () => {
    const trimmed = (name ?? "").trim();
    if (trimmed) create.mutate(trimmed);
  };

  return (
    <Screen onRefresh={() => void dashboards.refetch()} refreshing={dashboards.isRefetching}>
      {list.length === 0 ? (
        <Text style={{ color: colors.textMuted, fontSize: 13 }}>
          No dashboards in this organization yet. Make one and pin the resources, cost graphs, and
          budgets you want to see first.
        </Text>
      ) : (
        <Card list>
          {list.map((dashboard) => (
            <Row
              key={dashboard.id}
              title={dashboard.name}
              {...(dashboard.isDefault ? { subtitle: "Default" } : {})}
              onPress={() => router.push(`/org/${orgId}/dashboard/${dashboard.id}`)}
            />
          ))}
        </Card>
      )}

      {name === null ? (
        <Button label="New dashboard" variant="secondary" onPress={() => setName("")} />
      ) : (
        <Card>
          <TextField
            label="Dashboard name"
            value={name}
            onChangeText={setName}
            placeholder="e.g. Production"
            autoCapitalize="sentences"
            autoFocus
            onSubmitEditing={submit}
          />
          <View style={{ flexDirection: "row", gap: spacing.sm }}>
            <Button label="Cancel" variant="secondary" onPress={() => setName(null)} />
            <Button
              label={create.isPending ? "Creating…" : "Create"}
              disabled={create.isPending || !name.trim()}
              onPress={submit}
            />
          </View>
        </Card>
      )}
    </Screen>
  );
}
