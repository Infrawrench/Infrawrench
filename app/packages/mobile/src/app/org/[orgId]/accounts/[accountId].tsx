import { useMemo, useState } from "react";
import { StyleSheet, TextInput } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getVisibleAccountCategories,
  type AccountDetail,
  type Resource,
  type ResourceTypeSummary,
  type SectionCategoryState,
} from "@infrawrench/client-core";
import { useOrgApi } from "@/lib/auth/AuthProvider";
import { colors, radii, spacing } from "@/lib/theme";
import {
  Button,
  Card,
  EmptyView,
  ErrorView,
  LoadingView,
  Row,
  RowGroup,
  Screen,
  SectionTitle,
} from "@/components/ui";

export default function AccountResources() {
  const router = useRouter();
  const { accountId } = useLocalSearchParams<{ accountId: string }>();
  const { api, orgId } = useOrgApi();
  const queryClient = useQueryClient();
  const [query, setQuery] = useState("");

  // No `topLevelOnly` here: the account page is the account's full inventory,
  // child resources included, matching web and desktop.
  const resources = useQuery({
    queryKey: ["account-resources", orgId, accountId],
    queryFn: () =>
      api.org<Resource[]>(orgId, `/accounts/${encodeURIComponent(accountId)}/resources`),
  });

  // Supplies each section its human-readable plural name.
  const detail = useQuery({
    queryKey: ["account-detail", orgId, accountId],
    queryFn: () =>
      api.org<AccountDetail>(orgId, `/accounts/${encodeURIComponent(accountId)}/detail`),
  });

  const sync = useMutation({
    mutationFn: () =>
      api.org(orgId, `/accounts/${encodeURIComponent(accountId)}/sync`, { method: "POST" }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ["account-resources", orgId, accountId] }),
  });

  const sections = useMemo(() => {
    const byType = new Map<string, Resource[]>();
    for (const r of resources.data ?? []) {
      const list = byType.get(r.resourceTypeId) ?? [];
      list.push(r);
      byType.set(r.resourceTypeId, list);
    }

    // Prefer the plugin's type list so names and ordering match the other
    // surfaces; fall back to the ids present in the rows if detail is slow.
    const types: ResourceTypeSummary[] =
      detail.data?.resourceTypes ??
      [...byType.keys()].map((id) => ({
        id,
        displayName: id,
        pluralDisplayName: id,
        parentTypeId: undefined,
        supportsCreate: false,
      }));

    const categories: SectionCategoryState<ResourceTypeSummary, Resource>[] = types.map(
      (typeDef) => ({
        typeDef,
        loading: false,
        error: null,
        resources: byType.get(typeDef.id) ?? [],
      }),
    );

    return getVisibleAccountCategories(categories, query.trim().toLowerCase());
  }, [resources.data, detail.data, query]);

  if (resources.isLoading) return <LoadingView />;
  if (resources.isError) {
    return (
      <ErrorView
        message={resources.error instanceof Error ? resources.error.message : "Failed to load"}
        onRetry={() => void resources.refetch()}
      />
    );
  }

  const hasAnyResources = (resources.data ?? []).length > 0;

  return (
    <Screen onRefresh={() => void resources.refetch()} refreshing={resources.isRefetching}>
      <Button
        label={sync.isPending ? "Syncing…" : "Sync from provider"}
        variant="secondary"
        disabled={sync.isPending}
        onPress={() => sync.mutate()}
      />
      {hasAnyResources && (
        <TextInput
          style={styles.input}
          placeholder="Search sections or resources…"
          placeholderTextColor={colors.textFaint}
          value={query}
          onChangeText={setQuery}
          autoCapitalize="none"
          autoCorrect={false}
          accessibilityLabel="Search sections or resources"
        />
      )}
      {!hasAnyResources ? (
        <EmptyView message="No resources synced for this account yet." />
      ) : sections.length === 0 ? (
        <EmptyView message={`No sections or resources match “${query.trim()}”.`} />
      ) : (
        sections.map((section) => (
          <Card key={section.typeDef.id}>
            <SectionTitle>
              {section.typeDef.pluralDisplayName}
              {section.resources.length > 0 ? ` (${section.resources.length})` : ""}
            </SectionTitle>
            <RowGroup>
              {section.resources.map((r) => (
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
            </RowGroup>
          </Card>
        ))
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  input: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radii.md,
    color: colors.text,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    fontSize: 15,
  },
});
