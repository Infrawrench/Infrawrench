import { useMemo, useState } from "react";
import { Alert, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { DetailViewSchema, SchemaNode } from "@infrawrench/plugin-base";
import { useOrgApi } from "@/lib/auth/AuthProvider";
import { Button, Card, ErrorView, LoadingView, Row, Screen, SectionTitle } from "@/components/ui";
import { SchemaNodeView } from "@/schema/SchemaRenderer";
import { ActionDispatchProvider, type ActionHandlers } from "@/schema/ActionDispatchContext";
import { colors } from "@/lib/theme";

/**
 * The mobile counterpart of the web's ResourceDetailClient: fetches the
 * server-rendered DetailViewSchema and wires schema actions to the org API.
 * Interactive capabilities (SSH terminal, SQL, KV, logs) open their own
 * screens; editor-style capabilities (manifest, bucket policy) and the
 * reroll wizard stay on web/desktop for v1.
 */

interface DetailResponse {
  detailSchema: DetailViewSchema & { sections?: SchemaNode[] };
  childResources: Array<{
    id: string;
    pluginId: string;
    resourceTypeId: string;
    displayName: string;
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
  sshHost?: string | null;
  defaultSshUsername?: string | null;
}

export default function ResourceDetailScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{
    pluginId: string;
    resourceTypeId: string;
    resourceId: string;
  }>();
  const { api, orgId } = useOrgApi();
  const queryClient = useQueryClient();
  const [logsText, setLogsText] = useState<string | null>(null);
  const [logsLoading, setLogsLoading] = useState(false);

  const pluginId = params.pluginId;
  const resourceTypeId = params.resourceTypeId;
  const resourceId = params.resourceId;
  const queryKey = ["resource-detail", orgId, pluginId, resourceTypeId, resourceId];

  const detail = useQuery({
    queryKey,
    queryFn: () =>
      api.org<DetailResponse>(
        orgId,
        `/resources/${encodeURIComponent(pluginId)}/${encodeURIComponent(resourceTypeId)}/detail?resourceId=${encodeURIComponent(resourceId)}&includePeerPanes=false`,
      ),
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
      promptNoSqlCommand: () => {
        Alert.alert("Not available on mobile", "Run NoSQL commands from the web or desktop app.");
      },
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data, orgId, pluginId, resourceTypeId, resourceId, router, queryClient, api],
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

  async function loadLogs() {
    setLogsLoading(true);
    try {
      const res = await api.org<{ text?: string; lines?: string[] }>(
        orgId,
        `/resources/${encodeURIComponent(pluginId)}/${encodeURIComponent(resourceTypeId)}/logs`,
        {
          method: "POST",
          body: JSON.stringify({ accountId: data!.accountId, resourceId }),
        },
      );
      setLogsText(res?.text ?? res?.lines?.join("\n") ?? "No logs returned.");
    } catch (e) {
      setLogsText(e instanceof Error ? e.message : "Failed to fetch logs");
    } finally {
      setLogsLoading(false);
    }
  }

  const terminalHref = (kind: "ssh" | "k8s-exec" | "sql") =>
    `/org/${orgId}/terminal/${kind}--${encodeURIComponent(data.accountId)}--${encodeURIComponent(resourceId)}--${encodeURIComponent(pluginId)}`;

  return (
    <ActionDispatchProvider value={handlers}>
      <Screen onRefresh={() => void detail.refetch()} refreshing={detail.isRefetching}>
        <Text style={{ color: colors.text, fontSize: 20, fontWeight: "700" }}>
          {data.resourceDisplayName}
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
          {data.hasSqlEditor && (
            <Button
              label="SQL"
              variant="secondary"
              onPress={() => router.push(terminalHref("sql"))}
            />
          )}
          {data.hasSftpBrowser && (
            <Button
              label="Files"
              variant="secondary"
              onPress={() =>
                router.push(`/org/${orgId}/files/${encodeURIComponent(data.accountId)}`)
              }
            />
          )}
          <Button
            label={logsLoading ? "Loading logs…" : "Logs"}
            variant="secondary"
            disabled={logsLoading}
            onPress={() => void loadLogs()}
          />
        </View>

        {logsText !== null && (
          <Card>
            <SectionTitle>Logs</SectionTitle>
            <Text style={{ color: colors.textSecondary, fontFamily: "monospace", fontSize: 11 }}>
              {logsText.slice(-8000)}
            </Text>
          </Card>
        )}

        <Card>
          {schemaSections.map((node, i) => (
            <SchemaNodeView key={i} node={node} />
          ))}
        </Card>

        {data.childResources.length > 0 && (
          <Card>
            <SectionTitle>Related resources</SectionTitle>
            {data.childResources.map((child) => (
              <Row
                key={child.id}
                title={child.displayName}
                subtitle={child.resourceTypeId}
                onPress={() =>
                  router.push(
                    `/org/${orgId}/resources/${encodeURIComponent(child.pluginId)}/${encodeURIComponent(child.resourceTypeId)}/${encodeURIComponent(child.id)}`,
                  )
                }
              />
            ))}
          </Card>
        )}
      </Screen>
    </ActionDispatchProvider>
  );
}
