import { StyleSheet, Text } from "react-native";
import { useRouter } from "expo-router";
import type { ScorecardResult } from "@infrawrench/client-core";
import {
  Card,
  EmptyView,
  ErrorView,
  LoadingView,
  Row,
  Screen,
  SectionTitle,
} from "@/components/ui";
import { useOrgApi } from "@/lib/auth/AuthProvider";
import { colors } from "@/lib/theme";
import { levelColor, scoreLine, serviceTierLabel } from "./format";
import { useScorecardOverview } from "./useServices";

/**
 * The scorecard overview matrix (services down, scorecards across on
 * web/desktop) folded into a list a phone can hold: one section per
 * scorecard, its services lowest score first so the ones that need work lead.
 * Read-only; scorecards are edited on web/desktop.
 */
export function ScorecardsScreen() {
  const router = useRouter();
  const { orgId } = useOrgApi();
  const overview = useScorecardOverview();

  if (overview.isLoading) return <LoadingView />;
  if (overview.isError || !overview.data) {
    return (
      <ErrorView
        message={
          overview.error instanceof Error ? overview.error.message : "Couldn't load scorecards."
        }
        onRetry={() => void overview.refetch()}
      />
    );
  }
  const { scorecards, services, results } = overview.data;
  if (scorecards.length === 0) {
    return <EmptyView message="No scorecards yet. Create one on the web or desktop app." />;
  }
  const serviceById = new Map(services.map((s) => [s.id, s]));
  const byScorecard = new Map<string, ScorecardResult[]>();
  for (const r of results) {
    const list = byScorecard.get(r.scorecardId);
    if (list) list.push(r);
    else byScorecard.set(r.scorecardId, [r]);
  }

  return (
    <Screen onRefresh={() => void overview.refetch()} refreshing={overview.isRefetching}>
      {scorecards.map((scorecard) => {
        const rows = [...(byScorecard.get(scorecard.id) ?? [])].sort(
          (a, b) => (a.score ?? 101) - (b.score ?? 101),
        );
        return (
          <Card key={scorecard.id} list={rows.length > 0}>
            <SectionTitle>
              {scorecard.enabled ? scorecard.name : `${scorecard.name} (disabled)`}
            </SectionTitle>
            {rows.length === 0 ? (
              <Text style={styles.footnote}>No services this scorecard applies to.</Text>
            ) : (
              rows.map((r) => {
                const service = serviceById.get(r.serviceId);
                return (
                  <Row
                    key={r.serviceId}
                    title={service?.name ?? r.serviceId}
                    subtitle={[service ? serviceTierLabel(service.tier) : null, service?.ownerTeam]
                      .filter(Boolean)
                      .join(" · ")}
                    right={
                      <Text
                        style={[styles.score, { color: levelColor(r.level, scorecard.levels) }]}
                      >
                        {scoreLine(r.score, r.levelName)}
                      </Text>
                    }
                    onPress={() => router.push(`/org/${orgId}/services/${r.serviceId}`)}
                  />
                );
              })
            )}
          </Card>
        );
      })}
    </Screen>
  );
}

const styles = StyleSheet.create({
  score: { fontSize: 13, fontWeight: "600" },
  footnote: { color: colors.textFaint, fontSize: 11 },
});
