import { Text, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import {
  fetchResourceCostEstimate,
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
 * with the line items already open — the same information, laid out for the
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
    queryFn: () => fetchResourceCostEstimate(api, orgId, { accountId, resourceTypeId, resourceId }),
    retry: false,
  });

  const data = estimate.data;
  if (!data) return null;

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
        {data.lineItems.map((item, i) => (
          <Row
            key={`${item.label}-${i}`}
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
      <View>
        <Text style={{ color: colors.textFaint, fontSize: 12 }}>
          List-price projection from the provider&rsquo;s published rates — not a bill. Your Costs
          tab shows what was actually charged.
        </Text>
      </View>
    </Card>
  );
}
