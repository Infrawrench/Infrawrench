import { useMemo, useState } from "react";
import { StyleSheet, TextInput } from "react-native";
import { Redirect, useLocalSearchParams, useRouter } from "expo-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getAccountRootType,
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

  // Account-root plugins (UploadThing) hold exactly one instance of their root
  // type, and that instance *is* the account. Web and desktop swap the account
  // page's body for the resource's detail view; the phone has one screen per
  // route, so the equivalent is to redirect — same destination, and Back still
  // lands on the accounts list rather than on a page holding a single row.
  const accountRoot = useMemo(() => {
    const rootTypeId = getAccountRootType(detail.data?.resourceTypes ?? [])?.id;
    if (!rootTypeId) return null;
    return (resources.data ?? []).find((r) => r.resourceTypeId === rootTypeId) ?? null;
  }, [detail.data, resources.data]);

  if (resources.isLoading) return <LoadingView />;
  // The type list is the only thing that says whether this account has a root,
  // and it is fetched alongside the rows rather than before them — so rendering
  // the inventory while it is still in flight would flash a screen we are about
  // to redirect away from. Wait for it. On error we carry on: the fallback type
  // list below (ids as titles) is better than a dead end, and an account that
  // *does* have a root will pick it up on the next successful fetch.
  if (detail.isLoading) return <LoadingView />;
  if (resources.isError) {
    return (
      <ErrorView
        message={resources.error instanceof Error ? resources.error.message : "Failed to load"}
        onRetry={() => void resources.refetch()}
      />
    );
  }

  // Only redirect once a root row actually exists — before the first sync
  // lands there is nothing to redirect to, and the inventory is the right
  // fallback rather than a detail screen for an id we do not have.
  if (accountRoot) {
    return (
      <Redirect
        href={`/org/${orgId}/resources/${encodeURIComponent(accountRoot.pluginId)}/${encodeURIComponent(accountRoot.resourceTypeId)}/${encodeURIComponent(accountRoot.id)}`}
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
