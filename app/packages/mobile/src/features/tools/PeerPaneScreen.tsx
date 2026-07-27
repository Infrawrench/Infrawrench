import { useState } from "react";
import { Alert, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import type { PeerPaneResource, PeerPaneSchema } from "@infrawrench/plugin-base";
import { useOrgApi } from "@/lib/auth/AuthProvider";
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
import { PromptCommandSheet } from "@/components/PromptCommandSheet";
import { colors, spacing } from "@/lib/theme";

/**
 * A peer pane — the cross-plugin tab a resource picks up from its integrations
 * (Kubernetes workloads inside a managed cluster, tables inside a managed
 * database). The detail payload only carries stubs; the pane itself is built
 * on demand by `POST /resources/:pluginId/:typeId/peer-panes`, same as web.
 *
 * Items navigate into the peer plugin's own resource page, which is why the
 * link carries `parentResourceId` — the peer client can only be constructed
 * from the parent resource's credentials.
 */

interface PeerPaneResponse {
  tabLabel: string;
  pluginLogoSvg: string;
  schema: PeerPaneSchema;
  peerPluginId: string;
}

export function PeerPaneScreen({
  pluginId,
  resourceTypeId,
  resourceId,
  accountId,
  parentResourceId,
  peerPluginId,
}: {
  pluginId: string;
  resourceTypeId: string;
  resourceId: string;
  accountId: string;
  parentResourceId?: string | undefined;
  peerPluginId: string;
}) {
  const router = useRouter();
  const { api, orgId } = useOrgApi();
  const [promptOpen, setPromptOpen] = useState(false);

  const panes = useQuery({
    queryKey: ["peer-panes", orgId, pluginId, resourceTypeId, resourceId, peerPluginId],
    queryFn: () =>
      api.org<PeerPaneResponse[]>(
        orgId,
        `/resources/${encodeURIComponent(pluginId)}/${encodeURIComponent(resourceTypeId)}/peer-panes`,
        {
          method: "POST",
          body: JSON.stringify({
            accountId,
            resourceId,
            ...(parentResourceId ? { parentResourceId } : {}),
          }),
        },
      ),
  });

  if (panes.isLoading) return <LoadingView />;
  if (panes.isError) {
    return (
      <ErrorView
        message={panes.error instanceof Error ? panes.error.message : "Failed to load pane"}
        onRetry={() => void panes.refetch()}
      />
    );
  }

  const pane = (panes.data ?? []).find((p) => p.peerPluginId === peerPluginId);
  if (!pane) return <EmptyView message="This integration is no longer available." />;

  /**
   * Exec attaches to the pod through the CLUSTER resource — the server
   * resolves its kubeconfig via this peer integration, so the link carries the
   * parent's id, not the pod's.
   */
  const execHref = (item: PeerPaneResource) => {
    const search = new URLSearchParams({
      accountId,
      resourceId,
      peerPluginId,
      podName: item.displayName,
    });
    if (item.namespace) search.set("namespace", item.namespace);
    if (item.containerName) search.set("containerName", item.containerName);
    return `/org/${orgId}/terminal/k8s-exec?${search.toString()}`;
  };

  const { schema } = pane;
  const guidance = schema.guidance;

  return (
    <Screen onRefresh={() => void panes.refetch()} refreshing={panes.isRefetching}>
      {guidance ? (
        <Card>
          <SectionTitle>{guidance.title}</SectionTitle>
          {guidance.suggestions.map((line, i) => (
            <Text key={i} style={styles.suggestion}>
              • {line}
            </Text>
          ))}
          {guidance.action ? (
            <>
              <View style={styles.spacer} />
              <Row title={guidance.action.label} onPress={() => setPromptOpen(true)} />
              <PromptCommandSheet
                visible={promptOpen}
                title={guidance.action.title ?? guidance.action.label}
                description={guidance.action.description}
                fields={guidance.action.fields}
                submitLabel={guidance.action.submitLabel ?? "Submit"}
                onCancel={() => setPromptOpen(false)}
                onSubmit={async (values) => {
                  // The CTA fixes the PARENT resource (minting a DB user, say),
                  // so the command goes to it, not to the peer.
                  await api.org(orgId, "/resources/nosql-command", {
                    method: "POST",
                    body: JSON.stringify({
                      pluginId,
                      accountId,
                      resourceTypeId,
                      resourceId,
                      command: guidance.action!.command,
                      args: [JSON.stringify(values)],
                      ...(parentResourceId ? { parentResourceId } : {}),
                    }),
                  });
                  setPromptOpen(false);
                  await panes.refetch();
                  Alert.alert("Done", "Reloading the integration.");
                }}
              />
            </>
          ) : null}
        </Card>
      ) : null}

      {schema.resourceGroups.map((group) => (
        <Card key={`${group.pluginId}:${group.resourceTypeId}:${group.title}`}>
          <SectionTitle>{group.title}</SectionTitle>
          {group.items.length === 0 ? (
            <Text style={styles.empty}>Nothing here yet.</Text>
          ) : (
            <RowGroup>
              {group.items.map((item) => (
                <Row
                  key={item.id}
                  title={item.displayName}
                  subtitle={[item.subtitle, item.namespace].filter(Boolean).join(" · ")}
                  right={
                    item.supportsExec ? (
                      <Button
                        label="Shell"
                        variant="secondary"
                        onPress={() => router.push(execHref(item))}
                      />
                    ) : undefined
                  }
                  onPress={() =>
                    router.push(
                      `/org/${orgId}/resources/${encodeURIComponent(item.pluginId)}/${encodeURIComponent(item.resourceTypeId)}/${encodeURIComponent(item.id)}?accountId=${encodeURIComponent(accountId)}&parentResourceId=${encodeURIComponent(resourceId)}`,
                    )
                  }
                />
              ))}
            </RowGroup>
          )}
        </Card>
      ))}

      {schema.resourceGroups.length === 0 && !guidance ? (
        <EmptyView message="This integration reported nothing to show." />
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  suggestion: { color: colors.textMuted, fontSize: 13, lineHeight: 19 },
  empty: { color: colors.textFaint, fontSize: 12 },
  spacer: { height: spacing.sm },
});
