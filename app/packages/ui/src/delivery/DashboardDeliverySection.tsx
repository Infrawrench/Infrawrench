import { useMemo } from "react";
import { useGT } from "gt-react";

import { DeliverySchedulesSection } from "./DeliverySchedulesSection.js";
import type {
  DashboardExportClient,
  DeliveryScheduleInput,
  DeliverySchedulesClient,
} from "./types.js";

/**
 * A dashboard's scheduled deliveries: the shared schedule list with the PDF
 * option on, bound to one dashboard. Renders nothing when the host has no
 * `listNotifications`.
 */
export interface DashboardDeliverySectionProps {
  dashboardId: string;
  client: DashboardExportClient;
  /** Hide the "Delivery" heading, for a host that already titles it (the modal). */
  hideHeading?: boolean | undefined;
}

export function DashboardDeliverySection({
  dashboardId,
  client,
  hideHeading,
}: DashboardDeliverySectionProps) {
  const gt = useGT();
  const bound = useMemo(
    () => bindDashboardDeliveryClient(client, dashboardId),
    [client, dashboardId],
  );
  if (!bound) return null;
  return (
    <DeliverySchedulesSection
      client={bound}
      supportsPdf
      hideHeading={hideHeading}
      copy={{
        description: gt(
          "Send this dashboard on a schedule to Slack, Microsoft Teams or email. It is rendered as a PDF at each send, attached to emails and uploaded to Slack; Microsoft Teams gets a summary and a link.",
        ),
        editorDescription: gt(
          "The dashboard is rendered server-side as a PDF at each send. Uploading it to Slack needs the Slack app's files:write scope; if the file doesn't arrive, reconnect Slack from Settings.",
        ),
      }}
    />
  );
}

/** Narrow the dashboard client to one dashboard; see `bindReportDeliveryClient`. */
function bindDashboardDeliveryClient(
  client: DashboardExportClient,
  dashboardId: string,
): DeliverySchedulesClient | null {
  const list = client.listNotifications;
  if (!list) return null;
  const {
    listDeliveryTargets: targets,
    createNotification: create,
    updateNotification: update,
    deleteNotification: remove,
    sendNotificationNow: sendNow,
  } = client;
  return {
    list: () => list.call(client, dashboardId),
    ...(targets ? { targets: () => targets.call(client, dashboardId) } : {}),
    ...(create
      ? { create: (input: DeliveryScheduleInput) => create.call(client, dashboardId, input) }
      : {}),
    ...(update
      ? {
          update: (id: string, input: DeliveryScheduleInput) =>
            update.call(client, dashboardId, id, input),
        }
      : {}),
    ...(remove ? { remove: (id: string) => remove.call(client, dashboardId, id) } : {}),
    ...(sendNow ? { sendNow: (id: string) => sendNow.call(client, dashboardId, id) } : {}),
  };
}
