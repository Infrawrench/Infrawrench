import { useMemo, useState } from "react";
import { Alert, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { DetailViewSchema, HostAction, SchemaNode } from "@infrawrench/plugin-base";
import { useOrgApi } from "@/lib/auth/AuthProvider";
import {
  Button,
  Card,
  ErrorView,
  LoadingView,
  Row,
  RowGroup,
  Screen,
  SectionTitle,
} from "@/components/ui";
import { SchemaNodeView } from "@/schema/SchemaRenderer";
import { ActionDispatchProvider, type ActionHandlers } from "@/schema/ActionDispatchContext";
import { PromptCommandSheet } from "@/components/PromptCommandSheet";
import { DockerActionsCard } from "@/features/tools/DockerActionsCard";
import { ResourceChangesCard } from "@/features/changes/ResourceChangesCard";
import { ResourceDependenciesCard } from "@/features/graph/ResourceDependenciesCard";
import { colors } from "@/lib/theme";

/**
 * The mobile counterpart of the web's ResourceDetailClient: fetches the
 * server-rendered DetailViewSchema and wires schema actions to the org API.
 * Interactive capabilities (SSH, SQL, logs, KV, Mongo, peer panes) open their
 * own screens; editor-style capabilities (manifest, bucket policy) and the
 * reroll wizard stay on web/desktop.
 *
 * `accountId` and `parentResourceId` ride in the query string. Child and peer
 * resources aren't always rows in our database, so the server can't always
 * resolve their account from the id alone — and a peer resource's client can
 * only be built from its parent.
 */

type PromptAction = Extract<HostAction, { type: "prompt-nosql-command" }>;

interface DetailResponse {
  detailSchema: DetailViewSchema & { sections?: SchemaNode[] };
  childResources: Array<{
    id: string;
    pluginId: string;
    resourceTypeId: string;
    displayName: string;
    accountId: string;
  }>;
  accountId: string;
  resourceDisplayName: string;
  resourceTypeLabel: string;
  hasSqlEditor: boolean;
  hasSshTerminal: boolean;
  hasKvConsole: boolean;
  hasKvBrowser: boolean;
  hasSftpBrowser: boolean;
  hasDockerActions: boolean;
  kvDriverName?: string | null;
  isMongoDb?: boolean;
  databaseName?: string | null;
  containerId?: string | null;
  sshHost?: string | null;
  defaultSshUsername?: string | null;
  resourceFields?: Record<string, unknown>;
  peerIntegrationStubs?: Array<{
    tabLabel: string;
    pluginLogoSvg: string;
    peerPluginId: string;
  }>;
}

export default function ResourceDetailScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{
    pluginId: string;
    resourceTypeId: string;
    resourceId: string;
    accountId?: string;
    parentResourceId?: string;
    /**
     * Heading to show instead of the resource's own display name. Set by the
     * account screen when it redirects here for an account-root resource —
     * the account *is* this resource, so its name names the thing.
     */
    title?: string;
  }>();
  const { api, orgId } = useOrgApi();
  const queryClient = useQueryClient();
  const [prompt, setPrompt] = useState<PromptAction | null>(null);

  const pluginId = params.pluginId;
  const resourceTypeId = params.resourceTypeId;
  const resourceId = params.resourceId;
  const parentResourceId = params.parentResourceId;
  const title = params.title;
  const queryKey = [
    "resource-detail",
    orgId,
    pluginId,
    resourceTypeId,
    resourceId,
    parentResourceId ?? null,
  ];

  const detail = useQuery({
    queryKey,
    queryFn: () => {
      const search = new URLSearchParams({ resourceId, includePeerPanes: "false" });
      if (params.accountId) search.set("accountId", params.accountId);
      if (parentResourceId) search.set("parentResourceId", parentResourceId);
      return api.org<DetailResponse>(
        orgId,
        `/resources/${encodeURIComponent(pluginId)}/${encodeURIComponent(resourceTypeId)}/detail?${search.toString()}`,
      );
    },
  });

  const data = detail.data;

  const handlers = useMemo<ActionHandlers>(
    () => ({
      navigateToResource: (target) =>
        router.push(
          `/org/${orgId}/resources/${encodeURIComponent(target.pluginId)}/${encodeURIComponent(target.resourceTypeId)}/${encodeURIComponent(target.resourceId)}`,
        ),
      refreshResource: () => void queryClient.invalidateQueries({ queryKey }),
      invokePluginAction: async (actionId, successMessage) => {
        if (!data) return;
        await api.org(orgId, `/resources/invoke-action`, {
          method: "POST",
          body: JSON.stringify({
            pluginId,
            resourceTypeId,
            resourceId,
            accountId: data.accountId,
            actionId,
            ...(parentResourceId ? { parentResourceId } : {}),
          }),
        });
        await queryClient.invalidateQueries({ queryKey });
        if (successMessage) Alert.alert("Done", successMessage);
      },
      rerollSecret: async () => {
        Alert.alert("Not available on mobile", "Reroll secrets from the web or desktop app.");
      },
      rerollParentOutput: async () => {
        Alert.alert("Not available on mobile", "Reroll secrets from the web or desktop app.");
      },
      promptNoSqlCommand: (action) => setPrompt(action),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data, orgId, pluginId, resourceTypeId, resourceId, parentResourceId, router, queryClient, api],
  );

  if (detail.isLoading) return <LoadingView />;
  if (detail.isError || !data) {
    return (
      <ErrorView
        message={detail.error instanceof Error ? detail.error.message : "Failed to load resource"}
        onRetry={() => void detail.refetch()}
      />
    );
  }

  const schemaSections: SchemaNode[] =
    (data.detailSchema as { sections?: SchemaNode[] }).sections ?? [];

  /** Query string shared by every tool screen — identifies the resource. */
  const toolParams = (extra: Record<string, string> = {}) => {
    const search = new URLSearchParams({
      accountId: data.accountId,
      resourceId,
      resourceTypeId,
      pluginId,
      ...extra,
    });
    if (parentResourceId) search.set("parentResourceId", parentResourceId);
    return search.toString();
  };

  const toolHref = (tool: string, extra?: Record<string, string>) =>
    `/org/${orgId}/tools/${tool}?${toolParams(extra)}`;

  const terminalHref = (kind: "ssh" | "k8s-exec" | "sql") => {
    const extra: Record<string, string> = {};
    // SSH needs the endpoint so it can offer the quick-connect step; the SQL
    // route needs the resource type to find a per-resource driver.
    if (kind === "ssh" && data.sshHost) {
      extra["sshHost"] = data.sshHost;
      if (data.defaultSshUsername) extra["sshUsername"] = data.defaultSshUsername;
    }
    return `/org/${orgId}/terminal/${kind}?${toolParams(extra)}`;
  };

  const filesHref = () => {
    const search = new URLSearchParams({ accountId: data.accountId });
    if (data.sshHost) {
      search.set("sshHost", data.sshHost);
      if (data.defaultSshUsername) search.set("sshUsername", data.defaultSshUsername);
    }
    return `/org/${orgId}/files/${encodeURIComponent(data.accountId)}?${search.toString()}`;
  };

  const logs = data.detailSchema.logs;
  const speech = data.detailSchema.speechPanel;

  // A pod's shell runs through its cluster, so exec is only offered when we
  // arrived with the parent in hand — same condition web uses.
  const canExec = pluginId === "kubernetes" && resourceTypeId === "k8s-pod" && !!parentResourceId;
  const execHref = () => {
    const fields = data.resourceFields ?? {};
    const search = new URLSearchParams({
      accountId: data.accountId,
      resourceId: parentResourceId!,
      peerPluginId: pluginId,
      podName: data.resourceDisplayName,
      namespace: String(fields["namespace"] ?? "default"),
    });
    const container = fields["containerName"];
    if (typeof container === "string" && container) search.set("containerName", container);
    return `/org/${orgId}/terminal/k8s-exec?${search.toString()}`;
  };

  return (
    <ActionDispatchProvider value={handlers}>
      <Screen onRefresh={() => void detail.refetch()} refreshing={detail.isRefetching}>
        <Text style={{ color: colors.text, fontSize: 20, fontWeight: "700" }}>
          {title || data.resourceDisplayName}
        </Text>
        <Text style={{ color: colors.textMuted, fontSize: 13 }}>
          {data.resourceTypeLabel} · {pluginId}
        </Text>
        {data.detailSchema.status && <SchemaNodeView node={data.detailSchema.status} />}

        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          {(data.detailSchema.headerActions ?? []).map((action, i) => (
            <SchemaNodeView key={`ha-${i}`} node={action} />
          ))}
          {data.hasSshTerminal && (
            <Button label="SSH terminal" onPress={() => router.push(terminalHref("ssh"))} />
          )}
          {canExec && <Button label="Shell" onPress={() => router.push(execHref())} />}
          {data.hasSqlEditor && (
            <Button
              label="SQL"
              variant="secondary"
              onPress={() => router.push(terminalHref("sql"))}
            />
          )}
          {data.hasSftpBrowser && (
            <Button label="Files" variant="secondary" onPress={() => router.push(filesHref())} />
          )}
          {data.hasKvConsole && !data.isMongoDb && (
            <Button
              label={`${data.kvDriverName === "kafka" ? "Kafka" : "KV"} console`}
              variant="secondary"
              onPress={() =>
                router.push(toolHref("kv-console", { driver: data.kvDriverName ?? "redis" }))
              }
            />
          )}
          {data.hasKvConsole && data.isMongoDb && (
            <Button
              label="Documents"
              variant="secondary"
              onPress={() =>
                router.push(toolHref("mongo", { database: data.databaseName ?? "test" }))
              }
            />
          )}
          {data.hasKvBrowser && (
            <Button
              label="Keys"
              variant="secondary"
              onPress={() => router.push(toolHref("kv-browser"))}
            />
          )}
          {speech && speech.modes.length > 0 && (
            <Button
              label={speech.tabLabel ?? "Speech"}
              variant="secondary"
              onPress={() => router.push(toolHref("speech"))}
            />
          )}
          {logs && (
            <Button
              label="Logs"
              variant="secondary"
              onPress={() =>
                router.push(
                  toolHref("logs", {
                    ...(logs.defaultTailLines ? { tailLines: String(logs.defaultTailLines) } : {}),
                    ...(logs.supportsPrevious ? { supportsPrevious: "true" } : {}),
                  }),
                )
              }
            />
          )}
        </View>

        {data.hasDockerActions && data.containerId ? (
          <DockerActionsCard
            accountId={data.accountId}
            containerId={data.containerId}
            onDone={() => void detail.refetch()}
          />
        ) : null}

        <Card>
          {schemaSections.map((node, i) => (
            <SchemaNodeView key={i} node={node} />
          ))}
        </Card>

        {(data.peerIntegrationStubs ?? []).length > 0 && (
          <Card>
            <SectionTitle>Integrations</SectionTitle>
            <RowGroup>
              {(data.peerIntegrationStubs ?? []).map((stub) => (
                <Row
                  key={stub.peerPluginId}
                  title={stub.tabLabel}
                  subtitle={stub.peerPluginId}
                  onPress={() =>
                    router.push(toolHref("peer-pane", { peerPluginId: stub.peerPluginId }))
                  }
                />
              ))}
            </RowGroup>
          </Card>
        )}

        {data.childResources.length > 0 && (
          <Card>
            <SectionTitle>Related resources</SectionTitle>
            <RowGroup>
              {data.childResources.map((child) => (
                <Row
                  key={child.id}
                  title={child.displayName}
                  subtitle={child.resourceTypeId}
                  onPress={() =>
                    router.push(
                      `/org/${orgId}/resources/${encodeURIComponent(child.pluginId)}/${encodeURIComponent(child.resourceTypeId)}/${encodeURIComponent(child.id)}?accountId=${encodeURIComponent(child.accountId || data.accountId)}&parentResourceId=${encodeURIComponent(resourceId)}`,
                    )
                  }
                />
              ))}
            </RowGroup>
          </Card>
        )}

        {/*
          The two org-graph/timeline views web renders as detail tabs. Both are
          self-guarding: each renders nothing when the resource has no wiring
          and no recorded changes, and neither can fail the screen.
        */}
        <ResourceDependenciesCard resourceId={resourceId} />
        <ResourceChangesCard resourceId={resourceId} />
      </Screen>

      {prompt && (
        <PromptCommandSheet
          visible
          title={prompt.title ?? prompt.command}
          description={prompt.description}
          descriptionVariant={prompt.descriptionVariant ?? "info"}
          blocked={prompt.blocked === true}
          fields={prompt.fields}
          submitLabel={prompt.submitLabel ?? "Submit"}
          onCancel={() => setPrompt(null)}
          onSubmit={async (values) => {
            await api.org(orgId, "/resources/nosql-command", {
              method: "POST",
              body: JSON.stringify({
                pluginId,
                accountId: data.accountId,
                resourceTypeId,
                resourceId,
                command: prompt.command,
                args: [JSON.stringify(values)],
                ...(parentResourceId ? { parentResourceId } : {}),
              }),
            });
            setPrompt(null);
            await detail.refetch();
          }}
        />
      )}
    </ActionDispatchProvider>
  );
}
