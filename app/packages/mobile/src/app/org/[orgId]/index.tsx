import { useState } from "react";
import { Alert, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { SEARCH_KIND_LABELS, listStarred, type Dashboard } from "@infrawrench/client-core";
import { useOrgApi } from "@/lib/auth/AuthProvider";
import { starredItemHref } from "@/lib/starred";
import { TextField } from "@/components/form";
import { Button, Card, ErrorView, LoadingView, Row, Screen, SectionTitle } from "@/components/ui";
import { ProviderIncidentNotice } from "@/components/ProviderIncidentNotice";
import { colors, spacing } from "@/lib/theme";

/**
 * The Dashboards tab: every dashboard in the org, default first. Tapping one
 * opens it on its own screen, which carries the dashboard's name in the header
 * and a back button to this list.
 *
 * The default is deliberately not rendered inline above the list: that makes
 * it the only dashboard that feels like a place, because you see its cards
 * before you see that alternatives exist.
 *
 * Creating one is an inline form rather than a sheet: a dashboard is a name and
 * nothing else, and everything that fills it lives one screen deeper, on the
 * dashboard itself.
 */
/** "Your default" marks where you land; "Organization default" the fallback. */
function dashboardSubtitle(d: Dashboard): { subtitle?: string } {
  if (d.isResolvedDefault && d.isDefault)
    return { subtitle: "Your default · Organization default" };
  if (d.isResolvedDefault) return { subtitle: "Your default" };
  if (d.isDefault) return { subtitle: "Organization default" };
  return {};
}

export default function OrgDashboards() {
  const router = useRouter();
  const { api, orgId } = useOrgApi();
  const queryClient = useQueryClient();
  const [name, setName] = useState<string | null>(null);

  const dashboards = useQuery({
    queryKey: ["dashboards", orgId],
    queryFn: () => api.org<Dashboard[]>(orgId, "/dashboards"),
  });

  // Stars are optional garnish on this screen: a failure leaves the section out.
  const starred = useQuery({
    queryKey: ["starred", orgId],
    queryFn: () => listStarred(api, orgId),
  });
  const starredItems = starred.data ?? [];

  const create = useMutation({
    mutationFn: (dashboardName: string) =>
      api.org<Dashboard>(orgId, "/dashboards", {
        method: "POST",
        body: JSON.stringify({ name: dashboardName }),
      }),
    onSuccess: (created) => {
      setName(null);
      void queryClient.invalidateQueries({ queryKey: ["dashboards", orgId] });
      // Straight into the new dashboard: it is empty, and adding the first
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

  // The one you land on first (your own default, else your role's, else the
  // org's), then the org default, then alphabetical. An older server sends no
  // `isResolvedDefault`, which leaves the org default first as before.
  const list = [...(dashboards.data ?? [])].sort((a, b) => {
    const landA = a.isResolvedDefault === true;
    const landB = b.isResolvedDefault === true;
    if (landA !== landB) return landA ? -1 : 1;
    if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  const submit = () => {
    const trimmed = (name ?? "").trim();
    if (trimmed) create.mutate(trimmed);
  };

  return (
    <Screen
      onRefresh={() => {
        void dashboards.refetch();
        void starred.refetch();
      }}
      refreshing={dashboards.isRefetching}
    >
      <ProviderIncidentNotice />

      {/*
        The member's stars, the same list Cmd+K opens with on web and desktop.
        Read-only here: starring happens from a page header or the palette.
        Kinds the phone has no screen for are listed but not tappable.
      */}
      {starredItems.length > 0 && (
        <>
          <SectionTitle>Starred</SectionTitle>
          <Card list>
            {starredItems.map((item) => {
              const href = starredItemHref(orgId, item);
              const kindLabel = SEARCH_KIND_LABELS[item.kind].singular;
              return (
                <Row
                  key={`${item.kind}:${item.id}`}
                  title={item.displayName}
                  subtitle={href ? kindLabel : `${kindLabel} · open on web or desktop`}
                  {...(href ? { onPress: () => router.push(href as never) } : {})}
                />
              );
            })}
          </Card>
          <SectionTitle>Dashboards</SectionTitle>
        </>
      )}

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
              {...dashboardSubtitle(dashboard)}
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
