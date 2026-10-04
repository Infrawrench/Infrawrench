import { useEffect, useState } from "react";
import { Alert, Text, View } from "react-native";
import { useLocalSearchParams, useNavigation, useRouter } from "expo-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  DEFAULT_BUDGET_INPUT,
  DEFAULT_COST_GRAPH_CONFIG,
  budgetWithStatusToInput,
  type BudgetInput,
  type BudgetWidgetConfig,
  type BudgetWithStatus,
  type CostGraphConfig,
  type DashboardCardRef,
  type DashboardWidget,
} from "@infrawrench/client-core";
import { useOrgApi } from "@/lib/auth/AuthProvider";
import {
  DashboardBody,
  invalidateDashboardQueries,
  type DashboardData,
} from "@/features/dashboard/DashboardBody";
import { AddCardSheet, type AddCardChoice } from "@/features/dashboard/AddCardSheet";
import { BudgetPickerSheet } from "@/features/dashboard/BudgetPickerSheet";
import { CustomGraphPickerSheet } from "@/features/dashboard/CustomGraphPickerSheet";
import { BudgetSheet } from "@/features/dashboard/BudgetSheet";
import { CostGraphSheet } from "@/features/dashboard/CostGraphSheet";
import { PinResourceSheet } from "@/features/dashboard/PinResourceSheet";
import { useBudgets } from "@/features/dashboard/useBudgets";
import { useDashboardEditing } from "@/features/dashboard/useDashboardEditing";
import { useDashboardNotifications } from "@/features/dashboard/useDashboardNotifications";
import { NotificationRow } from "@/features/delivery/NotificationRow";
import { useSharePdf } from "@/features/pdf/sharePdf";
import { Sheet, TextField } from "@/components/form";
import {
  Button,
  Card,
  EmptyView,
  ErrorView,
  LoadingView,
  Screen,
  SectionTitle,
} from "@/components/ui";
import { colors, spacing } from "@/lib/theme";

/** Which sheet is open, if any. `configure` carries the widget being edited. */
type OpenSheet =
  { kind: "add" } | { kind: AddCardChoice } | { kind: "configure"; widget: DashboardWidget } | null;

/**
 * One dashboard's cards. The name goes in the header rather than the body:
 * the back button next to it is what makes this read as a place you drilled
 * into from the Dashboards tab, and a title inside the scroll view would
 * disappear the moment you scrolled.
 *
 * Edit mode is a toggle rather than a separate screen: the cards keep rendering
 * live underneath, so you can see what a reorder or a config change did without
 * leaving. Everything it writes goes to the endpoints web already uses.
 */
export default function DashboardScreen() {
  const { dashboardId } = useLocalSearchParams<{ dashboardId: string }>();
  const { api, orgId } = useOrgApi();
  const queryClient = useQueryClient();
  const navigation = useNavigation();
  const router = useRouter();

  const [editing, setEditing] = useState(false);
  const [sheet, setSheet] = useState<OpenSheet>(null);
  const [nameDraft, setNameDraft] = useState<string | null>(null);

  const detail = useQuery({
    queryKey: ["dashboard", orgId, dashboardId],
    queryFn: () => api.org<DashboardData>(orgId, `/dashboards/${encodeURIComponent(dashboardId)}`),
  });

  const edit = useDashboardEditing(dashboardId);
  // Budget widgets need their row to be configurable; the cards fetch the same
  // query, so this is the cache they already filled.
  const budgets = useBudgets(editing);
  // Read-only, like a report's schedules: created and edited on web/desktop.
  const notifications = useDashboardNotifications(dashboardId);
  const pdf = useSharePdf();

  const name = detail.data?.dashboard.name;
  useEffect(() => {
    // Set once the fetch lands: the title is data, so the layout can only
    // supply the placeholder.
    navigation.setOptions({ title: name ?? "Dashboard" });
  }, [navigation, name]);

  const rename = useMutation({
    mutationFn: (next: string) =>
      api.org(orgId, `/dashboards/${encodeURIComponent(dashboardId)}/rename`, {
        method: "POST",
        body: JSON.stringify({ name: next }),
      }),
    onSuccess: () => {
      setNameDraft(null);
      void queryClient.invalidateQueries({ queryKey: ["dashboard", orgId, dashboardId] });
      void queryClient.invalidateQueries({ queryKey: ["dashboards", orgId] });
    },
    onError: (e) =>
      Alert.alert("Couldn't rename", e instanceof Error ? e.message : "Unknown error"),
  });

  const remove = useMutation({
    mutationFn: () =>
      api.org(orgId, `/dashboards/${encodeURIComponent(dashboardId)}`, { method: "DELETE" }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["dashboards", orgId] });
      router.navigate(`/org/${orgId}`);
    },
    onError: (e) =>
      Alert.alert("Couldn't delete", e instanceof Error ? e.message : "Unknown error"),
  });

  if (detail.isLoading) return <LoadingView />;
  if (detail.isError) {
    return (
      <ErrorView
        message={detail.error instanceof Error ? detail.error.message : "Failed to load"}
        onRetry={() => void detail.refetch()}
      />
    );
  }
  if (!detail.data) return <EmptyView message="Dashboard not found." />;

  const data = detail.data;

  function confirmRemove(card: DashboardCardRef) {
    Alert.alert("Remove this card?", "The dashboard keeps everything else.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Remove",
        style: "destructive",
        onPress: () => {
          const done =
            card.kind === "resource"
              ? edit.unpinResource(card.id)
              : card.kind === "workflow"
                ? edit.unpinWorkflow(card.id)
                : edit.removeWidget(card.id);
          // The mutation reported any failure already.
          done.catch(() => {});
        },
      },
    ]);
  }

  function confirmDelete() {
    Alert.alert("Delete this dashboard?", "Its cards go with it. This can't be undone.", [
      { text: "Cancel", style: "cancel" },
      { text: "Delete", style: "destructive", onPress: () => remove.mutate() },
    ]);
  }

  /** A budget widget configures the budget row it points at, not the card. */
  const budgetFor = (widget: DashboardWidget) =>
    budgets.data?.get((widget.config as BudgetWidgetConfig).budgetId);

  const placedBudgetIds = new Set(
    data.widgets
      .filter((w) => w.kind === "budget")
      .map((w) => (w.config as BudgetWidgetConfig).budgetId),
  );

  return (
    // The sheets sit outside the Screen: a `Modal` is portalled out of the
    // view tree but is still a flex child, so one inside the scroll view's
    // content adds a phantom gap under the last card.
    <>
      <Screen
        onRefresh={() => {
          void detail.refetch();
          invalidateDashboardQueries(queryClient);
        }}
        refreshing={detail.isRefetching}
      >
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.sm }}>
          {editing ? (
            <>
              <Button label="Add a card" onPress={() => setSheet({ kind: "add" })} />
              <Button
                label="Rename"
                variant="secondary"
                onPress={() => setNameDraft(data.dashboard.name)}
              />
              {data.dashboard.isDefault ? null : (
                <Button
                  label="Delete"
                  variant="danger"
                  disabled={remove.isPending}
                  onPress={confirmDelete}
                />
              )}
              <Button label="Done" variant="secondary" onPress={() => setEditing(false)} />
            </>
          ) : (
            <>
              <Button label="Edit" variant="secondary" onPress={() => setEditing(true)} />
              <Button
                label={pdf.busy ? "Preparing PDF…" : "Share PDF"}
                variant="secondary"
                disabled={pdf.busy}
                onPress={() =>
                  void pdf.share(
                    `/dashboards/${encodeURIComponent(dashboardId)}/pdf`,
                    data.dashboard.name,
                  )
                }
              />
            </>
          )}
        </View>

        {nameDraft !== null ? (
          <Card>
            <TextField
              label="Dashboard name"
              value={nameDraft}
              onChangeText={setNameDraft}
              autoCapitalize="sentences"
              autoFocus
              onSubmitEditing={() => {
                if (nameDraft.trim()) rename.mutate(nameDraft.trim());
              }}
            />
            <View style={{ flexDirection: "row", gap: spacing.sm }}>
              <Button label="Cancel" variant="secondary" onPress={() => setNameDraft(null)} />
              <Button
                label={rename.isPending ? "Saving…" : "Save"}
                disabled={rename.isPending || !nameDraft.trim()}
                onPress={() => rename.mutate(nameDraft.trim())}
              />
            </View>
          </Card>
        ) : null}

        <DashboardBody
          data={data}
          editing={
            editing
              ? {
                  busy: edit.busy,
                  onReorder: (order) => void edit.reorder(order).catch(() => {}),
                  onRemove: confirmRemove,
                  onEditWidget: (widget) => setSheet({ kind: "configure", widget }),
                }
              : null
          }
        />

        <SectionTitle>Delivery</SectionTitle>
        {notifications.isLoading ? (
          <Text style={{ color: colors.textMuted, fontSize: 13 }}>Loading schedules…</Text>
        ) : notifications.isError ? (
          <Text style={{ color: colors.textMuted, fontSize: 13 }}>
            Couldn&rsquo;t load delivery schedules.
          </Text>
        ) : (notifications.data ?? []).length === 0 ? (
          <Text style={{ color: colors.textMuted, fontSize: 13 }}>
            No scheduled delivery. Schedules that email or post this dashboard as a PDF are managed
            on web or desktop.
          </Text>
        ) : (
          <Card list>
            {(notifications.data ?? []).map((n) => (
              <NotificationRow key={n.id} notification={n} />
            ))}
          </Card>
        )}
      </Screen>

      {sheet?.kind === "add" ? (
        <AddCardSheet
          visible
          onClose={() => setSheet(null)}
          onChoose={(choice) => setSheet({ kind: choice })}
        />
      ) : null}

      {sheet?.kind === "pin" ? (
        <PinResourceSheet visible onClose={() => setSheet(null)} onPin={edit.pinResource} />
      ) : null}

      {sheet?.kind === "cost_graph" ? (
        <CostGraphSheet
          visible
          initialTitle=""
          initialConfig={DEFAULT_COST_GRAPH_CONFIG}
          onClose={() => setSheet(null)}
          onSave={edit.addCostGraph}
        />
      ) : null}

      {sheet?.kind === "new_budget" ? (
        <BudgetSheet
          visible
          title="New budget"
          initialInput={DEFAULT_BUDGET_INPUT}
          budgets={[...(budgets.data?.values() ?? [])]}
          onClose={() => setSheet(null)}
          onSave={edit.createBudget}
        />
      ) : null}

      {sheet?.kind === "existing_budget" ? (
        <BudgetPickerSheet
          visible
          placedBudgetIds={placedBudgetIds}
          onClose={() => setSheet(null)}
          onPick={edit.addBudgetCard}
        />
      ) : null}

      {sheet?.kind === "custom_graph" ? (
        <CustomGraphPickerSheet
          visible
          onClose={() => setSheet(null)}
          onPick={(graph) => edit.addCustomGraphCard(graph.id, graph.name)}
        />
      ) : null}

      {sheet?.kind === "configure" && sheet.widget.kind === "cost_graph" ? (
        <CostGraphSheet
          visible
          initialTitle={sheet.widget.title}
          initialConfig={sheet.widget.config as CostGraphConfig}
          onClose={() => setSheet(null)}
          onSave={(title, config) => edit.updateWidget(sheet.widget.id, { title, config })}
        />
      ) : null}

      {sheet?.kind === "configure" && sheet.widget.kind === "budget" ? (
        <ConfigureBudget
          widget={sheet.widget}
          budget={budgetFor(sheet.widget)}
          allBudgets={[...(budgets.data?.values() ?? [])]}
          onClose={() => setSheet(null)}
          onSave={edit.updateBudget}
        />
      ) : null}
    </>
  );
}

/**
 * Editing a budget card edits the budget itself, so the change follows it to
 * every dashboard it sits on, and to the alerts, which outlive any card.
 */
function ConfigureBudget({
  widget,
  budget,
  allBudgets,
  onClose,
  onSave,
}: {
  widget: DashboardWidget;
  budget: BudgetWithStatus | undefined;
  /** Every budget in the org, for the parent picker. */
  allBudgets: BudgetWithStatus[];
  onClose: () => void;
  onSave: (budgetId: string, input: BudgetInput) => Promise<void>;
}) {
  if (!budget) {
    // The budgets query is either still in flight or the row is gone; either
    // way there is nothing to prefill an editor with.
    return (
      <Sheet
        visible
        title="Budget"
        description="Loading this budget… pull to refresh if it doesn't appear."
        onClose={onClose}
        footer={<Button label="Close" variant="secondary" onPress={onClose} />}
      >
        <LoadingView />
      </Sheet>
    );
  }
  const budgetId = (widget.config as BudgetWidgetConfig).budgetId;
  return (
    <BudgetSheet
      visible
      title="Budget"
      // Every field round-trips through client-core's mapping, including the
      // ones this sheet shows read-only or not at all (saved filter, scenario,
      // adjusted spend, an explicit period list): saving here must never be an
      // alert-changing edit nobody made.
      initialInput={budgetWithStatusToInput(budget)}
      budgets={allBudgets}
      budgetId={budgetId}
      onClose={onClose}
      onSave={(input) => onSave(budgetId, input)}
    />
  );
}
