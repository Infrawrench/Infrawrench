import { ipcMain } from "electron";
import { cloudFetchBytes } from "./shared";

// The invoice as a file; cloud-mode only, like everything else about
// invoices (the rest of the area rides the cloud transport, see the
// renderer's `src/lib/invoices-client.ts`). Bytes over IPC, saved by the
// renderer: the cloud endpoints need a Bearer header an `<a download>` cannot
// carry. It stays a channel of its own until the transport carries bytes.
ipcMain.handle(
  "cloud_invoice_file",
  async (
    _e,
    { orgId, invoiceId, format }: { orgId: string; invoiceId: string; format: "csv" | "pdf" },
  ) => {
    const suffix = format === "pdf" ? "pdf" : "export";
    return cloudFetchBytes(orgId, `/invoices/${encodeURIComponent(invoiceId)}/${suffix}`);
  },
);
