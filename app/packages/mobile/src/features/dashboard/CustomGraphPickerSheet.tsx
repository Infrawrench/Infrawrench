import { useQuery } from "@tanstack/react-query";
import type { CustomGraphSummary } from "@infrawrench/client-core";
import { Sheet } from "@/components/form";
import { Button, Card, EmptyView, LoadingView, Row } from "@/components/ui";
import { useOrgApi } from "@/lib/auth/AuthProvider";

/**
 * Add an existing custom graph to this dashboard. Creating or editing one
 * needs a code editor, so authoring stays on web/desktop/MCP — the phone
 * picks from what the org already has.
 */
export function CustomGraphPickerSheet({
  visible,
  onClose,
  onPick,
}: {
  visible: boolean;
  onClose: () => void;
  onPick: (graph: CustomGraphSummary) => Promise<void>;
}) {
  const { api, orgId } = useOrgApi();
  const graphs = useQuery({
    queryKey: ["custom-graphs", orgId],
    enabled: visible,
    queryFn: async () => (await api.org<CustomGraphSummary[]>(orgId, "/custom-graphs")) ?? [],
  });

  return (
    <Sheet
      visible={visible}
      title="Add a custom graph"
      onClose={onClose}
      footer={<Button label="Cancel" variant="secondary" onPress={onClose} />}
    >
      {graphs.isLoading ? (
        <LoadingView />
      ) : (graphs.data ?? []).length === 0 ? (
        <EmptyView message="No custom graphs yet. Create one on the web or desktop app, or ask the AI to via MCP." />
      ) : (
        <Card list>
          {(graphs.data ?? []).map((g) => (
            <Row
              key={g.id}
              title={g.name}
              subtitle={g.description ?? "Custom graph"}
              onPress={() => {
                onPick(g).catch(() => {});
                onClose();
              }}
            />
          ))}
        </Card>
      )}
    </Sheet>
  );
}
