import { useMemo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import {
  buildDependencyGraph,
  collectDependents,
  dependencyEdgeLabel,
  fetchDependencyGraph,
  type DependencyGraphEdge,
  type DependencyGraphModel,
  type DependencyGraphNode,
} from "@infrawrench/client-core";
import { useOrgApi } from "@/lib/auth/AuthProvider";
import { Card, EmptyView, ErrorView, LoadingView, Screen, SectionTitle } from "@/components/ui";
import { colors, spacing } from "@/lib/theme";

/**
 * One resource's neighbourhood as two indented trees plus its blast radius —
 * the phone's answer to the org-wide graph canvas.
 *
 * **Why no canvas.** A pan-and-zoom node graph is the wrong object on a 6-inch
 * screen: the whole point of the web view is seeing many nodes at once, which
 * is exactly what a phone cannot do, and drawing one would mean a gesture-driven
 * viewport and a new rendering dependency for a view nobody would use standing
 * up. The question a phone is actually asked — "I got paged about this thing,
 * what does it touch and what breaks with it" — is answered better by a list.
 * The CLI reached the same conclusion with its ASCII trees, and this is the
 * same information design with taps instead of glyphs.
 *
 * **Why the org-wide fetch.** A blast radius is transitive, and the endpoint's
 * `?resourceId=` answer is one hop deep, so it cannot produce one — the same
 * trade the CLI's `graph --resource` makes. That is why this is a screen you
 * open deliberately rather than a section on the resource page: the direct
 * neighbours there come from the cheap focused query.
 */

/** Deep enough to read a real chain, shallow enough not to scroll forever. */
const MAX_DEPTH = 6;

export interface DependenciesScreenProps {
  resourceId: string;
}

export function DependenciesScreen({ resourceId }: DependenciesScreenProps) {
  const router = useRouter();
  const { api, orgId } = useOrgApi();

  const graph = useQuery({
    queryKey: ["dependency-graph", orgId, "org-wide"],
    queryFn: () => fetchDependencyGraph(api, orgId),
  });

  const model = useMemo(
    () => (graph.data ? buildDependencyGraph(graph.data.nodes, graph.data.edges) : null),
    [graph.data],
  );

  const focus = model?.nodesById.get(resourceId) ?? null;

  const providers = useMemo(
    () => (model && focus ? treeRows(model, resourceId, "providers") : []),
    [model, focus, resourceId],
  );
  const consumers = useMemo(
    () => (model && focus ? treeRows(model, resourceId, "consumers") : []),
    [model, focus, resourceId],
  );
  const blastRadius = useMemo(
    () => (model && focus ? collectDependents(model, resourceId).size - 1 : 0),
    [model, focus, resourceId],
  );

  if (graph.isLoading) return <LoadingView />;
  if (graph.isError) {
    return (
      <ErrorView
        message={
          graph.error instanceof Error ? graph.error.message : "Couldn't load the dependency graph."
        }
        onRetry={() => void graph.refetch()}
      />
    );
  }
  if (!focus) {
    return (
      <EmptyView message="This resource has no links in either direction, so it isn't in the dependency graph — the graph is about wiring, not inventory." />
    );
  }

  const open = (node: DependencyGraphNode) =>
    router.push(
      `/org/${orgId}/resources/${encodeURIComponent(node.pluginId)}/${encodeURIComponent(node.resourceTypeId)}/${encodeURIComponent(node.id)}?accountId=${encodeURIComponent(node.accountId)}`,
    );

  return (
    <Screen onRefresh={() => void graph.refetch()} refreshing={graph.isRefetching}>
      <View>
        <Text style={styles.focusName}>{focus.displayName}</Text>
        <Text style={styles.focusMeta}>
          {focus.resourceTypeLabel} · {focus.accountName || focus.pluginDisplayName}
        </Text>
      </View>

      {graph.data?.truncated && (
        <Text style={{ color: colors.warning, fontSize: 12 }}>
          Inference hit its edge cap, so this is a partial view of the organization. Links that were
          drawn are real; some may be missing.
        </Text>
      )}

      <Card>
        <SectionTitle>Depends on</SectionTitle>
        <Tree
          rows={providers}
          onOpen={open}
          emptyText="Nothing — this resource points at no others."
        />
      </Card>

      <Card>
        <SectionTitle>Depended on by</SectionTitle>
        <Text style={styles.blast}>
          {blastRadius === 0
            ? "Nothing depends on this."
            : `Blast radius: ${blastRadius} resource${blastRadius === 1 ? "" : "s"} affected if this breaks or rotates its outputs.`}
        </Text>
        <Tree rows={consumers} onOpen={open} emptyText="Nothing points at this resource." />
      </Card>

      <Text style={styles.legend}>
        Each row is one link. ↺ marks a link back to a resource already on the branch — references
        can be circular; … marks a branch stopped at the depth limit.
      </Text>
    </Screen>
  );
}

/* ------------------------------------------------------------------ *
 * Tree flattening
 *
 * Local rather than shared: the CLI's `renderTree` produces ANSI strings and
 * this needs rows to lay out as views, so the two have nothing to share beyond
 * the walk itself — which is the model's own adjacency maps, already shared.
 * ------------------------------------------------------------------ */

interface TreeRow {
  key: string;
  depth: number;
  node: DependencyGraphNode;
  caption: string;
  /** The link points back at a resource already on this branch. */
  cycle: boolean;
  /** Children exist but the walk stopped at `MAX_DEPTH`. */
  capped: boolean;
}

function treeRows(
  model: DependencyGraphModel,
  startId: string,
  direction: "providers" | "consumers",
): TreeRow[] {
  const adjacency = direction === "providers" ? model.dependsOn : model.dependedOnBy;
  const next = (edge: DependencyGraphEdge) =>
    direction === "providers" ? edge.providerResourceId : edge.consumerResourceId;

  const rows: TreeRow[] = [];
  const walk = (id: string, depth: number, branch: Set<string>, keyPrefix: string) => {
    for (const edge of adjacency.get(id) ?? []) {
      const targetId = next(edge);
      const node = model.nodesById.get(targetId);
      if (!node) continue;
      const cycle = branch.has(targetId);
      const key = `${keyPrefix}>${targetId}:${edge.consumerFieldKey}`;
      const deeper = !cycle && depth + 1 < MAX_DEPTH;
      const hasChildren = (adjacency.get(targetId) ?? []).length > 0;
      rows.push({
        key,
        depth,
        node,
        caption: dependencyEdgeLabel(edge),
        cycle,
        capped: !cycle && !deeper && hasChildren,
      });
      if (deeper) {
        branch.add(targetId);
        walk(targetId, depth + 1, branch, key);
        branch.delete(targetId);
      }
    }
  };
  walk(startId, 0, new Set([startId]), startId);
  return rows;
}

function Tree({
  rows,
  onOpen,
  emptyText,
}: {
  rows: TreeRow[];
  onOpen: (node: DependencyGraphNode) => void;
  emptyText: string;
}) {
  if (rows.length === 0) return <Text style={styles.empty}>{emptyText}</Text>;
  return (
    <View>
      {rows.map((row) => (
        <Pressable
          key={row.key}
          accessibilityRole="button"
          accessibilityLabel={`${row.node.displayName}, ${row.caption}`}
          onPress={() => onOpen(row.node)}
          style={({ pressed }) => [
            styles.treeRow,
            // Indentation is the only depth cue; a phone has no room for the
            // CLI's box-drawing gutter and it would wrap on long names.
            { paddingLeft: row.depth * 14 },
            pressed && { backgroundColor: colors.surfaceOverlay },
          ]}
        >
          <View style={{ flex: 1, gap: 1 }}>
            <Text style={styles.treeName} numberOfLines={1}>
              {row.node.displayName}
              {row.cycle ? " ↺" : ""}
              {row.capped ? " …" : ""}
            </Text>
            <Text style={styles.treeMeta} numberOfLines={1}>
              {row.caption} · {row.node.resourceTypeLabel}
            </Text>
          </View>
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  focusName: { color: colors.text, fontSize: 20, fontWeight: "700" },
  focusMeta: { color: colors.textMuted, fontSize: 13 },
  blast: { color: colors.textSecondary, fontSize: 12 },
  empty: { color: colors.textMuted, fontSize: 13 },
  legend: { color: colors.textFaint, fontSize: 12 },
  treeRow: { flexDirection: "row", alignItems: "center", paddingVertical: spacing.sm },
  treeName: { color: colors.text, fontSize: 14 },
  treeMeta: { color: colors.textMuted, fontSize: 11 },
});
