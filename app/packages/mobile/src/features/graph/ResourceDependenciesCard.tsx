import { useMemo } from "react";
import { Text, View } from "react-native";
import { useRouter } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import {
  buildDependencyGraph,
  dependencyEdgeLabel,
  directDependencies,
  fetchDependencyGraph,
  type DependencyGraphNode,
  type DependencyNeighbor,
} from "@infrawrench/client-core";
import { useOrgApi } from "@/lib/auth/AuthProvider";
import { Button, Card, Row, RowGroup, SectionTitle } from "@/components/ui";
import { colors, spacing } from "@/lib/theme";

/**
 * The per-resource **Dependencies** view — what this resource points at, and
 * what points at it — mirroring the tab web and desktop render with
 * `ResourceDependenciesPanel`. The traversal is not reimplemented: the raw
 * node/edge lists go straight into `buildDependencyGraph` + `directDependencies`
 * from `@infrawrench/client-core`, so a phone and a laptop agree on the wiring.
 *
 * The fetch is the endpoint's **focused** form (`?resourceId=`), which is one
 * hop deep by design — that is all two neighbour lists need, and it keeps the
 * busiest screen in the app off the org's whole topology. A transitive blast
 * radius needs the org-wide graph, so it lives one tap away on its own screen
 * rather than being paid for on every resource open.
 *
 * Best-effort, like web's: a failure renders nothing rather than taking the
 * detail screen down with it, and a resource with no links has no section at
 * all (the graph is about wiring, not inventory).
 */
export function ResourceDependenciesCard({ resourceId }: { resourceId: string }) {
  const router = useRouter();
  const { api, orgId } = useOrgApi();

  const graph = useQuery({
    queryKey: ["dependency-graph", orgId, resourceId],
    queryFn: () => fetchDependencyGraph(api, orgId, { resourceId }),
    retry: false,
  });

  const dependencies = useMemo(() => {
    if (!graph.data) return null;
    const model = buildDependencyGraph(graph.data.nodes, graph.data.edges);
    return directDependencies(model, resourceId);
  }, [graph.data, resourceId]);

  if (!dependencies) return null;
  const { dependsOn, dependedOnBy } = dependencies;
  if (dependsOn.length === 0 && dependedOnBy.length === 0) return null;

  const open = (node: DependencyGraphNode) =>
    router.push(
      `/org/${orgId}/resources/${encodeURIComponent(node.pluginId)}/${encodeURIComponent(node.resourceTypeId)}/${encodeURIComponent(node.id)}?accountId=${encodeURIComponent(node.accountId)}`,
    );

  return (
    <Card>
      <SectionTitle>Dependencies</SectionTitle>
      {dependsOn.length > 0 && (
        <NeighborList title="Depends on" neighbors={dependsOn} onOpen={open} />
      )}
      {dependedOnBy.length > 0 && (
        <NeighborList title="Depended on by" neighbors={dependedOnBy} onOpen={open} />
      )}
      {graph.data?.truncated && (
        <Text style={{ color: colors.warning, fontSize: 12 }}>
          The org&apos;s graph hit its edge cap — this resource&apos;s own neighbourhood is still
          complete.
        </Text>
      )}
      <Button
        label="Blast radius"
        variant="secondary"
        onPress={() =>
          router.push(`/org/${orgId}/dependencies?resourceId=${encodeURIComponent(resourceId)}`)
        }
      />
    </Card>
  );
}

function NeighborList({
  title,
  neighbors,
  onOpen,
}: {
  title: string;
  neighbors: DependencyNeighbor[];
  onOpen: (node: DependencyGraphNode) => void;
}) {
  return (
    <View style={{ gap: spacing.xs }}>
      <Text style={{ color: colors.textSecondary, fontSize: 12, fontWeight: "600" }}>{title}</Text>
      <RowGroup>
        {neighbors.map((neighbor) => (
          <Row
            // Edges are deduped by (consumer, field, provider) upstream, and
            // every neighbour in one list sits on the same side of the edge, so
            // node id + field key is unique here.
            key={`${neighbor.node.id}:${neighbor.fieldKey}`}
            title={neighbor.node.displayName}
            subtitle={`${neighbor.node.resourceTypeLabel} · ${dependencyEdgeLabel({
              consumerFieldKey: neighbor.fieldKey,
              providerOutputKey: neighbor.outputKey,
              ...(neighbor.kind ? { kind: neighbor.kind } : {}),
              ...(neighbor.label ? { label: neighbor.label } : {}),
            })}`}
            onPress={() => onOpen(neighbor.node)}
          />
        ))}
      </RowGroup>
    </View>
  );
}
