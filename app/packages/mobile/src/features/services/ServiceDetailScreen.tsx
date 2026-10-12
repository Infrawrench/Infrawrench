import { Linking, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import {
  formatServiceCost,
  formatSloTarget,
  type ScorecardHistoryPoint,
  type ScorecardResult,
  type ServiceMember,
  type ServiceSummaryResponse,
} from "@infrawrench/client-core";
import { Card, ErrorView, LoadingView, Row, RowGroup, Screen, SectionTitle } from "@/components/ui";
import { SchemaNodeView } from "@/schema/SchemaRenderer";
import { useOrgApi } from "@/lib/auth/AuthProvider";
import { colors, spacing } from "@/lib/theme";
import {
  checkStatusColor,
  checkStatusLabel,
  levelColor,
  scoreLine,
  serviceTierLabel,
  sloStandingColor,
  sloStandingLabel,
  timeAgo,
} from "./format";
import { useServiceDetail, useServiceScorecards, useServiceSummary } from "./useServices";

const RECENT_CHANGES = 5;

/**
 * One service, read-only: who owns it, what it costs, how its SLOs stand, who
 * is on call, what the finding feeds say about its members, what changed, and
 * each scorecard's result with the checks that failed. Editing (members,
 * rules, links, scorecards) stays on web/desktop.
 */
export function ServiceDetailScreen({ serviceId }: { serviceId: string }) {
  const summary = useServiceSummary(serviceId);
  const detail = useServiceDetail(serviceId);
  const scorecards = useServiceScorecards(serviceId);

  if (summary.isLoading) return <LoadingView />;
  if (summary.isError || !summary.data) {
    return (
      <ErrorView
        message={
          summary.error instanceof Error ? summary.error.message : "Couldn't load the service."
        }
        onRetry={() => void summary.refetch()}
      />
    );
  }
  const data = summary.data;
  const { service } = data;
  const results = scorecards.data?.results ?? data.scorecards;
  const history = scorecards.data?.history ?? {};
  const refreshing = summary.isRefetching || detail.isRefetching || scorecards.isRefetching;

  return (
    <Screen
      onRefresh={() => {
        void summary.refetch();
        void detail.refetch();
        void scorecards.refetch();
      }}
      refreshing={refreshing}
    >
      <View style={styles.header}>
        <Text style={styles.name}>{service.name}</Text>
        <Text style={styles.subtitle}>
          {[serviceTierLabel(service.tier), service.ownerTeam].filter(Boolean).join(" · ")}
        </Text>
        {service.description ? <Text style={styles.body}>{service.description}</Text> : null}
      </View>

      <Card>
        <Stat
          label="Owners"
          value={
            service.owners.length > 0
              ? service.owners.map((o) => o.name ?? o.email ?? o.userId).join(", ")
              : "none"
          }
        />
        <Stat label="Resources" value={String(data.memberCount)} />
        <Stat
          label={`Cost, last ${data.cost.windowDays} days`}
          value={data.cost.available ? formatServiceCost(data.cost.totals) : "Cost unavailable"}
        />
        {data.cost.available && (
          <Text style={styles.footnote}>
            {data.cost.costedMembers} of {data.memberCount} resources have per-resource cost data.
          </Text>
        )}
      </Card>

      {service.links.length > 0 && (
        <>
          <SectionTitle>Links</SectionTitle>
          <Card list>
            {service.links.map((link) => (
              <Row
                key={`${link.label}-${link.url}`}
                title={link.label}
                subtitle={link.url}
                onPress={() => void Linking.openURL(link.url)}
              />
            ))}
          </Card>
        </>
      )}

      <ScorecardsSection results={results} history={history} />

      <OnCallSection onCall={data.onCall} />

      {data.slos.length > 0 && <SlosSection slos={data.slos} />}

      {data.runbooks.length > 0 && (
        <>
          <SectionTitle>Runbooks</SectionTitle>
          <Card list>
            {data.runbooks.map((r) => (
              <Row key={r.id} title={r.name} subtitle={r.enabled ? undefined : "disabled"} />
            ))}
          </Card>
        </>
      )}

      <FindingsSection findings={data.findings} />

      {data.recentChanges.length > 0 && (
        <>
          <SectionTitle>Recent changes</SectionTitle>
          <Card list>
            {data.recentChanges.slice(0, RECENT_CHANGES).map((c) => (
              <Row
                key={c.id}
                title={c.resourceName}
                subtitle={`${c.changeKind}${c.fields.length > 0 ? `: ${c.fields.slice(0, 3).join(", ")}` : ""} · ${timeAgo(c.at)}`}
              />
            ))}
          </Card>
        </>
      )}

      <SectionTitle>Members</SectionTitle>
      {detail.isLoading ? (
        <Text style={styles.footnote}>Loading members…</Text>
      ) : detail.isError || !detail.data ? (
        <Text style={styles.warning}>Couldn't load the members.</Text>
      ) : detail.data.members.length === 0 ? (
        <Text style={styles.footnote}>No resources in this service yet.</Text>
      ) : (
        <Card list>
          {detail.data.members.map((m) => (
            <MemberRow key={m.resourceId} member={m} />
          ))}
        </Card>
      )}

      <Text style={styles.footnote}>Services are edited on the web or desktop app.</Text>
    </Screen>
  );
}

function MemberRow({ member }: { member: ServiceMember }) {
  const router = useRouter();
  const { orgId } = useOrgApi();
  const subtitle = [
    member.pluginId,
    member.accountName,
    member.source === "rule" ? "by rule" : "added by hand",
    member.missing ? "deleted upstream" : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <Row
      title={member.resourceName}
      subtitle={subtitle}
      onPress={
        member.missing
          ? undefined
          : () =>
              router.push(
                `/org/${orgId}/resources/${encodeURIComponent(member.pluginId)}/${encodeURIComponent(
                  member.resourceTypeId,
                )}/${encodeURIComponent(member.resourceId)}?accountId=${encodeURIComponent(
                  member.accountId,
                )}`,
              )
      }
    />
  );
}

function ScorecardsSection({
  results,
  history,
}: {
  results: ScorecardResult[];
  history: Record<string, ScorecardHistoryPoint[]>;
}) {
  if (results.length === 0) return null;
  return (
    <>
      <SectionTitle>Scorecards</SectionTitle>
      {results.map((result) => {
        const failing = result.checks.filter((c) => c.status === "fail" || c.status === "error");
        const points = (history[result.scorecardId] ?? [])
          .filter((p): p is ScorecardHistoryPoint & { score: number } => p.score !== null)
          .map((p) => ({ timestamp: Date.parse(`${p.day}T00:00:00Z`), value: p.score }));
        return (
          <View key={result.scorecardId} style={styles.scorecard}>
            <Card>
              <View style={styles.scoreHeader}>
                <Text style={styles.scoreName} numberOfLines={1}>
                  {result.scorecardName}
                </Text>
                <Text style={[styles.scoreValue, { color: levelColor(result.level, undefined) }]}>
                  {scoreLine(result.score, result.levelName)}
                </Text>
              </View>
              {failing.length === 0 ? (
                <Text style={styles.footnote}>Every applicable check passes.</Text>
              ) : (
                failing.map((check) => (
                  <View key={check.checkId} style={styles.check}>
                    <View style={styles.checkHead}>
                      <Text style={styles.checkName}>{check.name}</Text>
                      <Text style={[styles.checkStatus, { color: checkStatusColor(check.status) }]}>
                        {checkStatusLabel(check.status)}
                      </Text>
                    </View>
                    {check.detail ? <Text style={styles.body}>{check.detail}</Text> : null}
                  </View>
                ))
              )}
              {result.checks.length > failing.length && failing.length > 0 && (
                <Text style={styles.footnote}>
                  {result.checks.filter((c) => c.status === "pass").length} passing,{" "}
                  {result.checks.filter((c) => c.status === "not_applicable").length} not
                  applicable.
                </Text>
              )}
            </Card>
            {points.length > 1 && (
              <SchemaNodeView
                node={{
                  kind: "metric-chart",
                  title: `${result.scorecardName} score`,
                  series: [{ label: "Score", unit: "%", points }],
                  timeRangeLabel: "Daily, last 90 days",
                }}
              />
            )}
          </View>
        );
      })}
    </>
  );
}

function OnCallSection({ onCall }: { onCall: ServiceSummaryResponse["onCall"] }) {
  if (!onCall) return null;
  const person = (p: { name: string | null; email: string | null; userId: string }) =>
    p.name ?? p.email ?? p.userId;
  return (
    <>
      <SectionTitle>On call</SectionTitle>
      <Card>
        <Stat
          label="Schedule"
          value={onCall.enabled ? onCall.scheduleName : `${onCall.scheduleName} (disabled)`}
        />
        <Stat label="Now" value={onCall.current ? person(onCall.current) : "nobody"} />
        {onCall.current && (
          <Stat
            label="Until"
            value={new Date(onCall.current.endsAt).toLocaleString(undefined, {
              dateStyle: "medium",
              timeStyle: "short",
            })}
          />
        )}
        <Stat label="Next" value={onCall.next ? person(onCall.next) : "nobody"} />
      </Card>
    </>
  );
}

function SlosSection({ slos }: { slos: ServiceSummaryResponse["slos"] }) {
  const router = useRouter();
  const { orgId } = useOrgApi();
  return (
    <>
      <SectionTitle>SLOs</SectionTitle>
      <Card list>
        {slos.map((slo) => (
          <Row
            key={slo.id}
            title={slo.name}
            subtitle={`Target ${formatSloTarget(slo.targetPercent)}${
              slo.budgetRemaining === null
                ? ""
                : ` · ${Number((slo.budgetRemaining * 100).toFixed(1))}% budget left`
            }`}
            right={
              <Text style={[styles.checkStatus, { color: sloStandingColor(slo.status) }]}>
                {sloStandingLabel(slo.status)}
              </Text>
            }
            onPress={() => router.push(`/org/${orgId}/slos/${slo.id}`)}
          />
        ))}
      </Card>
    </>
  );
}

function FindingsSection({ findings }: { findings: ServiceSummaryResponse["findings"] }) {
  const router = useRouter();
  const { orgId } = useOrgApi();
  const { counts } = findings.posture;
  const unavailable = new Set(findings.unavailable);
  const posture = unavailable.has("posture")
    ? "unavailable"
    : `${counts.critical} critical, ${counts.high} high, ${counts.medium} medium, ${counts.low} low`;
  return (
    <>
      <SectionTitle>Findings</SectionTitle>
      <Card>
        <RowGroup>
          <Row
            title="Posture"
            subtitle={posture}
            onPress={() => router.push(`/org/${orgId}/posture`)}
          />
          <Row
            title="Orphaned resources"
            subtitle={
              unavailable.has("orphans") ? "unavailable" : `${findings.orphans.length} flagged`
            }
          />
          <Row
            title="Backups"
            subtitle={
              unavailable.has("backups") ? "unavailable" : `${findings.backups.length} findings`
            }
          />
        </RowGroup>
        {findings.backups.slice(0, 5).map((b) => (
          <Text key={`${b.resourceId}-${b.kind}`} style={styles.body}>
            {b.resourceName}: {b.detail}
          </Text>
        ))}
        {findings.orphans.slice(0, 5).map((o) => (
          <Text key={o.resourceId} style={styles.body}>
            {o.resourceName}: {o.reason}
          </Text>
        ))}
        {findings.unavailable.length > 0 && (
          <Text style={styles.warning}>
            Some finding feeds could not be read; their counts are left out.
          </Text>
        )}
      </Card>
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={styles.statValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  header: { gap: 4 },
  name: { color: colors.text, fontSize: 18, fontWeight: "600" },
  subtitle: { color: colors.textMuted, fontSize: 13 },
  body: { color: colors.textMuted, fontSize: 13 },
  warning: { color: colors.warning, fontSize: 13 },
  footnote: { color: colors.textFaint, fontSize: 11 },
  stat: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: spacing.md,
    paddingVertical: 6,
  },
  statLabel: { color: colors.textMuted, fontSize: 13 },
  statValue: { color: colors.text, fontSize: 13, fontWeight: "500", flexShrink: 1 },
  scorecard: { gap: spacing.sm },
  scoreHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: spacing.md,
    paddingBottom: spacing.sm,
  },
  scoreName: { color: colors.text, fontSize: 15, fontWeight: "500", flexShrink: 1 },
  scoreValue: { fontSize: 14, fontWeight: "600" },
  check: { gap: 2, paddingVertical: 6 },
  checkHead: { flexDirection: "row", justifyContent: "space-between", gap: spacing.md },
  checkName: { color: colors.text, fontSize: 13, fontWeight: "500", flexShrink: 1 },
  checkStatus: { fontSize: 12, fontWeight: "600" },
});
