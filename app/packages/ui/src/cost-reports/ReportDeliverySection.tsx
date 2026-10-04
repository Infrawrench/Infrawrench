import { useMemo } from "react";
import { useGT } from "gt-react";

import { DeliverySchedulesSection } from "../delivery/DeliverySchedulesSection.js";
import type { DeliveryScheduleInput, DeliverySchedulesClient } from "../delivery/types.js";
import type { CostReportsClient } from "./types.js";

/**
 * The Delivery section on a report's detail page: this report's scheduled
 * sends to Slack, Teams and email. A thin wrapper over the shared
 * {@link DeliverySchedulesSection} that binds the report client to one report
 * and supplies the report-specific copy.
 *
 * Writes are `org:settings:write` server-side; a host that omits the mutating
 * client methods renders this read-only, and one without
 * `listReportNotifications` renders nothing.
 */
export interface ReportDeliverySectionProps {
  reportId: string;
  client: CostReportsClient;
}

export function ReportDeliverySection({ reportId, client }: ReportDeliverySectionProps) {
  const gt = useGT();
  const bound = useMemo(() => bindReportDeliveryClient(client, reportId), [client, reportId]);
  if (!bound) return null;
  return (
    <DeliverySchedulesSection
      client={bound}
      copy={{
        description: gt(
          "Send this report on a schedule to Slack, Microsoft Teams or email — the numbers and a link, no chart image. An empty period still sends, saying so.",
        ),
        editorDescription: gt(
          "The report runs server-side at each send: total for its window, change vs the period before, and its top groups — converted to your display currency where one is configured.",
        ),
      }}
    />
  );
}

/**
 * Narrow the report client to one report's schedules. Each optional method is
 * carried over only when the host supplied it, so the shared section's
 * read-only rule (all four manage methods, or none) keeps working.
 */
function bindReportDeliveryClient(
  client: CostReportsClient,
  reportId: string,
): DeliverySchedulesClient | null {
  const list = client.listReportNotifications;
  if (!list) return null;
  const {
    listReportDeliveryTargets: targets,
    createReportNotification: create,
    updateReportNotification: update,
    deleteReportNotification: remove,
    sendReportNotificationNow: sendNow,
  } = client;
  return {
    list: () => list.call(client, reportId),
    ...(targets ? { targets: () => targets.call(client, reportId) } : {}),
    ...(create
      ? { create: (input: DeliveryScheduleInput) => create.call(client, reportId, input) }
      : {}),
    ...(update
      ? {
          update: (id: string, input: DeliveryScheduleInput) =>
            update.call(client, reportId, id, input),
        }
      : {}),
    ...(remove ? { remove: (id: string) => remove.call(client, reportId, id) } : {}),
    ...(sendNow ? { sendNow: (id: string) => sendNow.call(client, reportId, id) } : {}),
  };
}
