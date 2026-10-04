import { useState } from "react";
import { useGT } from "gt-react";

import { Modal } from "../components/Modal.js";
import { toast } from "../components/Toast/index.js";
import { DashboardDeliverySection } from "./DashboardDeliverySection.js";
import type { DashboardExportClient } from "./types.js";

/**
 * The dashboard header's export actions: "Download PDF" (rendered
 * server-side) and "Schedule delivery", which opens the dashboard's delivery
 * schedules in a dialog. Each action shows only when the host supplies the
 * client method behind it, so a host without the endpoints renders nothing.
 */
export interface DashboardExportActionsProps {
  dashboardId: string;
  dashboardName: string;
  client: DashboardExportClient;
}

const actionClass =
  "text-xs text-on-surface-faint hover:text-on-surface-muted transition-colors px-2 py-1 rounded hover:bg-surface-overlay disabled:opacity-50";

export function DashboardExportActions({
  dashboardId,
  dashboardName,
  client,
}: DashboardExportActionsProps) {
  const gt = useGT();
  const [downloading, setDownloading] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);

  async function downloadPdf() {
    if (!client.downloadPdf) return;
    setDownloading(true);
    try {
      await client.downloadPdf(dashboardId, dashboardName);
    } catch (e: unknown) {
      toast.error(gt("Couldn't export the dashboard as a PDF"), {
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setDownloading(false);
    }
  }

  if (!client.downloadPdf && !client.listNotifications) return null;

  return (
    <>
      {client.downloadPdf && (
        <button
          type="button"
          disabled={downloading}
          aria-busy={downloading}
          onClick={() => void downloadPdf()}
          className={actionClass}
        >
          {downloading ? gt("Preparing PDF…") : gt("Download PDF")}
        </button>
      )}
      {client.listNotifications && (
        <button type="button" onClick={() => setScheduleOpen(true)} className={actionClass}>
          {gt("Schedule delivery")}
        </button>
      )}
      {scheduleOpen && (
        <Modal onClose={() => setScheduleOpen(false)} ariaLabel={gt("Scheduled delivery")}>
          <div className="bg-surface-raised border border-border-strong rounded-xl shadow-2xl w-[560px] max-w-[90vw] p-6 max-h-[85vh] overflow-y-auto">
            <div className="flex items-start justify-between gap-3 mb-2">
              <div className="min-w-0">
                <h2 className="text-base font-semibold text-on-surface">
                  {gt("Scheduled delivery")}
                </h2>
                <p className="truncate text-xs text-on-surface-faint">{dashboardName}</p>
              </div>
              <button
                type="button"
                onClick={() => setScheduleOpen(false)}
                className="shrink-0 rounded-lg border border-border px-3 py-1.5 text-sm text-on-surface hover:border-border-strong"
              >
                {gt("Close")}
              </button>
            </div>
            <DashboardDeliverySection dashboardId={dashboardId} client={client} hideHeading />
          </div>
        </Modal>
      )}
    </>
  );
}
