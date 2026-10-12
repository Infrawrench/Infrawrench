import { StyleSheet, Text, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import {
  fetchSeatList,
  formatMoney,
  seatFindingKey,
  seatHolderLabel,
  type SeatFinding,
  type SeatTotal,
  type SeatView,
} from "@infrawrench/client-core";
import { Card, SectionTitle } from "@/components/ui";
import { useOrgApi } from "@/lib/auth/AuthProvider";
import { colors, spacing } from "@/lib/theme";
import { RemediationCommands } from "./RemediationCommands";

function totals(list: SeatTotal[]): string {
  return list.map((t) => formatMoney(t.monthly, t.currency)).join(" + ");
}

/** `GET /seats`; refetched by the Costs tab's pull-to-refresh. */
function useSeats() {
  const { api, orgId } = useOrgApi();
  return useQuery({
    queryKey: ["seats", orgId],
    queryFn: () => fetchSeatList(api, orgId),
  });
}

function findingText(f: SeatFinding, seat: SeatView, days: number): string {
  switch (f.kind) {
    case "inactive":
      return seat.neverActive ? `Never used, ${days}+ days` : `No use in ${days}+ days`;
    case "duplicate":
      return `Also has ${f.duplicate?.keptProduct ?? "another tool"} (${f.duplicate?.keptAccountName ?? ""})`;
    case "downgrade":
      return `Could move to ${f.targetSeatType ?? "a cheaper tier"}`;
  }
}

/**
 * "Seats"; the native counterpart to the web/desktop section: paid SaaS seats
 * that are inactive, duplicated across tools, or on a dearer tier, with the
 * monthly saving and the commands to act. Read-only like the rest of mobile's
 * savings sections (removing a seat is a provider-account change): remove
 * from the web or desktop app, or copy the commands.
 */
export function SeatsSection() {
  const query = useSeats();
  const data = query.data ?? null;
  const byId = new Map((data?.seats ?? []).map((s) => [s.id, s]));

  return (
    <>
      <SectionTitle>Seats</SectionTitle>
      {query.isError ? (
        <Card>
          <Text style={styles.error}>
            Couldn&apos;t load seats:{" "}
            {query.error instanceof Error ? query.error.message : "request failed"}
          </Text>
        </Card>
      ) : query.isLoading ? (
        <Card>
          <Text style={styles.muted}>Loading seats…</Text>
        </Card>
      ) : data && data.accounts.length === 0 ? (
        <Card>
          <Text style={styles.muted}>
            No connected account reports seats yet (GitHub Copilot, Cursor, GitLab, Okta, Claude
            Enterprise, Docker Hub, Tailscale).
          </Text>
        </Card>
      ) : data && data.findings.length === 0 ? (
        <Card>
          <Text style={styles.muted}>
            {data.counts.seats} seats checked; none is inactive, duplicated or on a dearer tier than
            it needs.
          </Text>
        </Card>
      ) : data ? (
        <>
          {data.savingsMonthly.length > 0 && (
            <Text style={styles.summary}>
              To save {totals(data.savingsMonthly)}/mo · {data.counts.seats} seats
            </Text>
          )}
          <Card list>
            {data.findings.map((f) => {
              const seat = byId.get(f.seatId);
              if (!seat) return null;
              return (
                <View key={seatFindingKey(f)} style={styles.rowWrap}>
                  <View style={styles.row}>
                    <View style={styles.rowMain}>
                      <Text style={styles.title} numberOfLines={1}>
                        {seatHolderLabel(seat)}
                      </Text>
                      <Text style={styles.subtitle} numberOfLines={2}>
                        {seat.product} · {seat.seatType} · {seat.accountName}
                      </Text>
                      <Text style={styles.subtitle} numberOfLines={2}>
                        {findingText(f, seat, data.inactiveDays)}
                      </Text>
                    </View>
                    {/* No figure renders as nothing, never as a zero. */}
                    {f.monthlySaving !== null && f.currency !== null && (
                      <View style={styles.costCell}>
                        <Text style={styles.cost}>{formatMoney(f.monthlySaving, f.currency)}</Text>
                        <Text style={styles.costUnit}>
                          /mo {seat.priceSource === "list-price" ? "list" : ""}
                        </Text>
                      </View>
                    )}
                  </View>
                  <RemediationCommands remediation={f.remediation} />
                </View>
              );
            })}
          </Card>
          {data.counts.unknownActivity > 0 && (
            <Text style={styles.footnote}>
              {data.counts.unknownActivity} seats are on providers that report no usable activity,
              so they are never flagged.
            </Text>
          )}
          <Text style={styles.footnote}>
            Remove seats from the web or desktop app, or copy the commands.
          </Text>
        </>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  rowWrap: { paddingVertical: 10, gap: spacing.sm },
  row: { flexDirection: "row", alignItems: "center", gap: spacing.md },
  rowMain: { flex: 1, gap: 2 },
  title: { color: colors.text, fontSize: 15, fontWeight: "500" },
  subtitle: { color: colors.textMuted, fontSize: 12 },
  costCell: { alignItems: "flex-end" },
  cost: { color: colors.text, fontSize: 14, fontWeight: "500" },
  costUnit: { color: colors.textFaint, fontSize: 11 },
  summary: { color: colors.text, fontSize: 13 },
  muted: { color: colors.textMuted, fontSize: 13 },
  error: { color: colors.danger, fontSize: 13 },
  footnote: { color: colors.textFaint, fontSize: 11 },
});
