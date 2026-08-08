import { Text, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import type { CostExport } from "@infrawrench/client-core";
import { useOrgApi } from "@/lib/auth/AuthProvider";
import { Card, EmptyView, ErrorView, LoadingView, Row, Screen } from "@/components/ui";
import { colors, spacing } from "@/lib/theme";

/**
 * Scheduled cost exports — **read-only on mobile, deliberately**.
 *
 * The half of this feature that belongs on a phone is "is the nightly dump to
 * the warehouse still working": a failed export is invisible until somebody
 * asks why last week is missing, and that is exactly the sort of thing you want
 * to catch away from a desk. So the list, the schedule, the destination and the
 * last run's error are all here.
 *
 * The other half is not. Creating or editing an export means typing an S3
 * secret key or a signed URL into a phone, and it is an org data-egress
 * decision gated on `org:settings:write`. That belongs on the web or desktop
 * Settings page, alongside the same omission the mobile app already makes for
 * billing and the editors (see KNOWLEDGE.md).
 */
export default function CostExportsScreen() {
  const { api, orgId } = useOrgApi();

  const exports = useQuery({
    queryKey: ["cost-exports", orgId],
    queryFn: async () => (await api.org<CostExport[]>(orgId, "/cost-exports")) ?? [],
  });

  if (exports.isLoading) return <LoadingView />;
  if (exports.isError) {
    return (
      <ErrorView
        message={exports.error instanceof Error ? exports.error.message : "Failed to load"}
        onRetry={() => void exports.refetch()}
      />
    );
  }

  const rows = exports.data ?? [];
  if (rows.length === 0) {
    return (
      <EmptyView message="No cost exports. Create one from Settings → Cost Exports on the web or desktop app." />
    );
  }

  return (
    <Screen onRefresh={() => void exports.refetch()} refreshing={exports.isRefetching}>
      {rows.map((exp) => (
        <Card key={exp.id} list>
          <Row
            title={exp.name}
            subtitle={`${exp.format.toUpperCase()} · ${exp.cadence} ${String(exp.hour).padStart(2, "0")}:00 ${exp.timezone}`}
            right={<StatusBadge export={exp} />}
          />
          <Row
            title={
              exp.destination.kind === "s3"
                ? `s3://${exp.destination.bucket}/${exp.destination.prefix}`
                : `${exp.destination.method} ${exp.destination.urlHint}`
            }
            subtitle={
              exp.lastStatus === "succeeded"
                ? `${exp.lastObjectCount ?? 0} object(s) · ${(exp.lastRowCount ?? 0).toLocaleString()} rows · ${exp.lastRunAt ? new Date(exp.lastRunAt).toLocaleString() : ""}`
                : exp.enabled && exp.nextRunAt
                  ? `Next run ${new Date(exp.nextRunAt).toLocaleString()}`
                  : "Paused"
            }
          />
          {exp.lastStatus === "failed" && exp.lastError ? (
            <View style={{ padding: spacing.md }}>
              <Text style={{ color: colors.danger, fontSize: 13 }}>{exp.lastError}</Text>
            </View>
          ) : null}
        </Card>
      ))}
    </Screen>
  );
}

function StatusBadge({ export: exp }: { export: CostExport }) {
  const [label, color] = !exp.enabled
    ? (["paused", colors.textMuted] as const)
    : exp.lastStatus === "failed"
      ? (["failed", colors.danger] as const)
      : exp.lastStatus === "succeeded"
        ? (["ok", colors.success] as const)
        : (["never run", colors.textMuted] as const);
  return <Text style={{ color, fontSize: 13 }}>{label}</Text>;
}
