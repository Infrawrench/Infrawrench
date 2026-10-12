import { StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import {
  ORG_SCORECARD_PILLAR_LABELS,
  orgScorecardBiggestDrag,
  orgScorecardTrendDelta,
  type OrgScorecardGrade,
  type OrgScorecardResponse,
  type ScorecardResult,
} from "@infrawrench/client-core";
import { Card, ErrorView, LoadingView, Row, Screen, SectionTitle } from "@/components/ui";
import { useOrgApi } from "@/lib/auth/AuthProvider";
import { colors } from "@/lib/theme";
import { levelColor, scoreLine, serviceTierLabel } from "./format";
import { useOrgScorecard, useScorecardOverview } from "./useServices";

function gradeColor(grade: OrgScorecardGrade): string {
  if (grade === "A" || grade === "B") return colors.success;
  if (grade === "C") return colors.warning;
  return colors.danger;
}

/**
 * The org grade above the scorecard list: overall grade and score, the change
 * since the oldest stored reading, the biggest drag, and one row per pillar.
 * Read-only, like the rest of the screen; an unassessed pillar says why
 * instead of showing a zero.
 */
function OrgGradeCard({
  grade,
  loading,
  failed,
}: {
  grade: OrgScorecardResponse | null | undefined;
  loading: boolean;
  failed: boolean;
}) {
  if (loading) {
    return (
      <Card>
        <SectionTitle>Org grade</SectionTitle>
        <Text style={styles.footnote}>Reading the org grade…</Text>
      </Card>
    );
  }
  if (failed || !grade) {
    return (
      <Card>
        <SectionTitle>Org grade</SectionTitle>
        <Text style={styles.footnote}>{"Couldn't load the org grade. Pull to retry."}</Text>
      </Card>
    );
  }
  const delta = orgScorecardTrendDelta(grade.trend, grade.score);
  const drag = orgScorecardBiggestDrag(grade.pillars);
  return (
    <>
      <Card>
        <SectionTitle>Org grade</SectionTitle>
        {grade.score === null || grade.grade === null ? (
          <Text style={styles.footnote}>
            Nothing could be assessed yet. Connect an account and let it sync.
          </Text>
        ) : (
          <View style={styles.gradeRow}>
            <Text style={[styles.grade, { color: gradeColor(grade.grade) }]}>{grade.grade}</Text>
            <Text style={styles.gradeScore}>{grade.score}</Text>
            {delta !== null && delta !== 0 && grade.trend[0] ? (
              <Text style={[styles.delta, { color: delta > 0 ? colors.success : colors.danger }]}>
                {`${delta > 0 ? "+" : ""}${delta} since ${grade.trend[0].day}`}
              </Text>
            ) : null}
          </View>
        )}
        {drag ? (
          <Text style={styles.footnote}>
            {`Biggest drag: ${ORG_SCORECARD_PILLAR_LABELS[drag.id]}${drag.nextStep ? `. ${drag.nextStep}` : ""}`}
          </Text>
        ) : null}
        {grade.failedPillars.length > 0 ? (
          <Text style={[styles.footnote, { color: colors.warning }]}>
            {`${grade.failedPillars.length} pillar${grade.failedPillars.length === 1 ? "" : "s"} could not be read and ${grade.failedPillars.length === 1 ? "is" : "are"} excluded, not counted against the grade.`}
          </Text>
        ) : null}
      </Card>
      <Card list>
        {grade.pillars.map((pillar) => (
          <Row
            key={pillar.id}
            title={ORG_SCORECARD_PILLAR_LABELS[pillar.id]}
            subtitle={
              pillar.score === null ? (pillar.unassessedReason ?? pillar.headline) : pillar.headline
            }
            right={
              <Text style={[styles.score, pillar.score === null && { color: colors.textFaint }]}>
                {pillar.score === null ? "n/a" : String(pillar.score)}
              </Text>
            }
          />
        ))}
      </Card>
    </>
  );
}

/**
 * The scorecard overview matrix (services down, scorecards across on
 * web/desktop) folded into a list a phone can hold: one section per
 * scorecard, its services lowest score first so the ones that need work lead.
 * The org grade sits on top, as it does on web/desktop. Read-only;
 * scorecards are edited on web/desktop.
 */
export function ScorecardsScreen() {
  const router = useRouter();
  const { orgId } = useOrgApi();
  const overview = useScorecardOverview();
  const orgGrade = useOrgScorecard();
  const refresh = () => {
    void overview.refetch();
    void orgGrade.refetch();
  };

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
  const gradeCard = (
    <OrgGradeCard grade={orgGrade.data} loading={orgGrade.isLoading} failed={orgGrade.isError} />
  );
  if (scorecards.length === 0) {
    return (
      <Screen onRefresh={refresh} refreshing={overview.isRefetching || orgGrade.isRefetching}>
        {gradeCard}
        <Card>
          <Text style={styles.footnote}>
            No scorecards yet. Create one on the web or desktop app.
          </Text>
        </Card>
      </Screen>
    );
  }
  const serviceById = new Map(services.map((s) => [s.id, s]));
  const byScorecard = new Map<string, ScorecardResult[]>();
  for (const r of results) {
    const list = byScorecard.get(r.scorecardId);
    if (list) list.push(r);
    else byScorecard.set(r.scorecardId, [r]);
  }

  return (
    <Screen onRefresh={refresh} refreshing={overview.isRefetching || orgGrade.isRefetching}>
      {gradeCard}
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
  score: { fontSize: 13, fontWeight: "600", color: colors.text },
  gradeRow: { flexDirection: "row", alignItems: "baseline", gap: 10, marginBottom: 4 },
  grade: { fontSize: 36, fontWeight: "700" },
  gradeScore: { fontSize: 20, fontWeight: "600", color: colors.text },
  delta: { fontSize: 12 },
  footnote: { color: colors.textFaint, fontSize: 11 },
});
