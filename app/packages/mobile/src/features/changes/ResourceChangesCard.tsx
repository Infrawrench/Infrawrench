import { useState } from "react";
import { Text, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { fetchResourceChanges, summarizeChange } from "@infrawrench/client-core";
import { useOrgApi } from "@/lib/auth/AuthProvider";
import { Card, Row, RowGroup, SectionTitle } from "@/components/ui";
import { colors } from "@/lib/theme";
import { ChangeDiffList, ChangeKindBadge } from "./ChangeParts";

/**
 * One resource's slice of the change timeline, mirroring the **Changes** tab
 * web and desktop put on the resource detail page
 * (`GET /api/org/:orgId/changes/resource?resourceId=`).
 *
 * Best-effort, like the Dependencies card beside it: an org whose plan or
 * permissions don't reach the feed simply doesn't see the section rather than
 * failing the whole detail screen.
 */

const LIMIT = 20;

export function ResourceChangesCard({ resourceId }: { resourceId: string }) {
  const { api, orgId } = useOrgApi();
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const changes = useQuery({
    queryKey: ["resource-changes", orgId, resourceId],
    queryFn: () => fetchResourceChanges(api, orgId, resourceId, LIMIT),
    retry: false,
  });

  const entries = changes.data ?? [];
  if (changes.isLoading || changes.isError || entries.length === 0) return null;

  return (
    <Card>
      <SectionTitle>Changes</SectionTitle>
      <RowGroup>
        {entries.map((entry) => (
          <View key={entry.id}>
            <Row
              title={summarizeChange(entry)}
              subtitle={new Date(entry.createdAt).toLocaleString()}
              right={<ChangeKindBadge kind={entry.changeKind} />}
              {...(entry.changeKind === "updated" && entry.diff.length > 0
                ? {
                    onPress: () => setExpandedId(expandedId === entry.id ? null : entry.id),
                  }
                : {})}
            />
            {expandedId === entry.id && (
              <View style={{ paddingBottom: 12 }}>
                <ChangeDiffList entry={entry} />
              </View>
            )}
          </View>
        ))}
      </RowGroup>
      <Text style={{ color: colors.textFaint, fontSize: 12 }}>
        The last {LIMIT} events for this resource. Tap a change to see its before → after values.
      </Text>
    </Card>
  );
}
