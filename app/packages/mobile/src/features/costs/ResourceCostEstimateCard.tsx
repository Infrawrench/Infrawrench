import { Text, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import {
  fetchResourceFootprint,
  formatCo2e,
  formatMonthlyEstimate,
  partialEstimatePrefix,
} from "@infrawrench/client-core";
import { useOrgApi } from "@/lib/auth/AuthProvider";
import { Card, Row, RowGroup, SectionTitle } from "@/components/ui";
import { colors } from "@/lib/theme";

/**
 * The resource's standing monthly cost estimate, mirroring the chip web and
 * desktop put in the detail header (`POST /resources/cost-estimate`). Phones
 * have no header room for a disclosure, so the breakdown is simply a card
 * with the line items already open: the same information, laid out for the
 * one-column screen.
 *
 * Best-effort, like the Changes and Dependencies cards beside it: most
 * plugins can't price most types, and a resource with no estimate shows no
 * section rather than an empty one.
 */
export function ResourceCostEstimateCard({
  accountId,
  resourceTypeId,
  resourceId,
}: {
  accountId: string;
  resourceTypeId: string;
  resourceId: string;
}) {
  const { api, orgId } = useOrgApi();

  const estimate = useQuery({
    queryKey: ["resource-cost-estimate", orgId, resourceId],
    queryFn: () => fetchResourceFootprint(api, orgId, { accountId, resourceTypeId, resourceId }),
    retry: false,
  });

  const data = estimate.data?.estimate ?? null;
  const carbon = estimate.data?.carbon?.estimate ?? null;
  if (!data && !carbon) return null;

  // Carbon beside the price, from the same response. Its basis is printed
  // under it rather than behind a tap: nothing in it is measured.
  const carbonBlock = carbon ? (
    <View style={{ gap: 2 }}>
      <Text style={{ color: colors.text, fontSize: 16, fontWeight: "600" }}>
        ~{formatCo2e(carbon.kgCo2e)} CO2e
        <Text style={{ color: colors.textMuted, fontSize: 14, fontWeight: "400" }}>/mo</Text>
      </Text>
      <Text style={{ color: colors.textFaint, fontSize: 12 }}>
        {carbon.count === 1 ? "" : `${carbon.count} × `}
        {carbon.vcpus} vCPU · {carbon.gridZone} · {Math.round(carbon.gridIntensity)} g/kWh.
        Estimated, not measured.
      </Text>
    </View>
  ) : null;

  if (!data) {
    return (
      <Card>
        <SectionTitle>Estimated carbon</SectionTitle>
        {carbonBlock}
      </Card>
    );
  }

  const prefix = partialEstimatePrefix(data);

  return (
    <Card>
      <SectionTitle>Estimated cost</SectionTitle>
      <Text style={{ color: colors.text, fontSize: 22, fontWeight: "700" }}>
        {prefix ? `${prefix} ` : ""}
        {formatMonthlyEstimate(data.monthlyAmount, data.currency)}
        <Text style={{ color: colors.textMuted, fontSize: 14, fontWeight: "400" }}>/mo</Text>
      </Text>
      <RowGroup>
        {data.lineItems.map((item) => (
          <Row
            key={`${item.label}|${item.detail ?? ""}|${item.monthlyAmount}`}
            title={item.label}
            {...(item.detail ? { subtitle: item.detail } : {})}
            right={
              <Text style={{ color: colors.text, fontSize: 14 }}>
                {formatMonthlyEstimate(item.monthlyAmount, data.currency)}
              </Text>
            }
          />
        ))}
      </RowGroup>
      {data.notes?.map((note) => (
        <Text key={note} style={{ color: colors.textFaint, fontSize: 12 }}>
          {note}
        </Text>
      ))}
      {carbonBlock}
      <View>
        <Text style={{ color: colors.textFaint, fontSize: 12 }}>
          List-price projection from the provider&rsquo;s published rates — not a bill. Your Costs
          tab shows what was actually charged.
        </Text>
      </View>
    </Card>
  );
}
