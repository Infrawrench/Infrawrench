import { ipcMain } from "electron";
import { cloudFetch } from "./shared";

// Managed accounts and invoices — cloud-mode only, for the same reason as
// everything in `costs.ts`: the spend an invoice bills for is collected
// server-side, so a local-only workspace has nothing to bill.
//
// Read handlers ride the cloud's `invoices:read`; the write and issue handlers
// ride `invoices:write` and `invoices:issue`. Nothing is decided here — the
// server enforces all three, and a caller without the grant gets its 403 back
// as the action's error.

// The scope picker's two lists. Cost centres already exist behind the settings
// channel's allowlist, but that channel is for the Settings tab; a workspace
// panel gets its own named channel like everything else in `cloud-data`.
ipcMain.handle("cloud_list_cost_centres", async (_e, { orgId }: { orgId: string }) => {
  return (await cloudFetch(orgId, "/cost-centres")) ?? [];
});

ipcMain.handle("cloud_list_managed_accounts", async (_e, { orgId }: { orgId: string }) => {
  return (await cloudFetch(orgId, "/managed-accounts")) ?? [];
});

ipcMain.handle(
  "cloud_create_managed_account",
  async (_e, { orgId, input }: { orgId: string; input: unknown }) => {
    return cloudFetch(orgId, "/managed-accounts", { method: "POST", body: JSON.stringify(input) });
  },
);

ipcMain.handle(
  "cloud_update_managed_account",
  async (_e, { orgId, id, input }: { orgId: string; id: string; input: unknown }) => {
    return cloudFetch(orgId, `/managed-accounts/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: JSON.stringify(input),
    });
  },
);

ipcMain.handle(
  "cloud_delete_managed_account",
  async (_e, { orgId, id }: { orgId: string; id: string }) => {
    return cloudFetch(orgId, `/managed-accounts/${encodeURIComponent(id)}`, { method: "DELETE" });
  },
);

ipcMain.handle("cloud_list_invoices", async (_e, { orgId }: { orgId: string }) => {
  return (await cloudFetch(orgId, "/invoices")) ?? [];
});

ipcMain.handle(
  "cloud_get_invoice",
  async (_e, { orgId, invoiceId }: { orgId: string; invoiceId: string }) => {
    return cloudFetch(orgId, `/invoices/${encodeURIComponent(invoiceId)}`);
  },
);

ipcMain.handle(
  "cloud_create_invoice",
  async (_e, { orgId, input }: { orgId: string; input: unknown }) => {
    return cloudFetch(orgId, "/invoices", { method: "POST", body: JSON.stringify(input) });
  },
);

ipcMain.handle(
  "cloud_update_invoice",
  async (_e, { orgId, invoiceId, input }: { orgId: string; invoiceId: string; input: unknown }) => {
    return cloudFetch(orgId, `/invoices/${encodeURIComponent(invoiceId)}`, {
      method: "PUT",
      body: JSON.stringify(input),
    });
  },
);

ipcMain.handle(
  "cloud_delete_invoice",
  async (_e, { orgId, invoiceId }: { orgId: string; invoiceId: string }) => {
    return cloudFetch(orgId, `/invoices/${encodeURIComponent(invoiceId)}`, { method: "DELETE" });
  },
);

ipcMain.handle(
  "cloud_approve_invoice",
  async (_e, { orgId, invoiceId }: { orgId: string; invoiceId: string }) => {
    return cloudFetch(orgId, `/invoices/${encodeURIComponent(invoiceId)}/approve`, {
      method: "POST",
      body: "{}",
    });
  },
);

ipcMain.handle(
  "cloud_send_invoice",
  async (
    _e,
    { orgId, invoiceId, resend }: { orgId: string; invoiceId: string; resend?: boolean },
  ) => {
    return cloudFetch(orgId, `/invoices/${encodeURIComponent(invoiceId)}/send`, {
      method: "POST",
      // `resend` is the deliberate second copy; the server refuses one without
      // it once a delivery has landed.
      body: JSON.stringify({ resend: resend === true }),
    });
  },
);

ipcMain.handle(
  "cloud_void_invoice",
  async (
    _e,
    {
      orgId,
      invoiceId,
      reason,
      supersede,
    }: { orgId: string; invoiceId: string; reason: string; supersede: boolean },
  ) => {
    return cloudFetch(orgId, `/invoices/${encodeURIComponent(invoiceId)}/void`, {
      method: "POST",
      body: JSON.stringify({ reason, supersede }),
    });
  },
);
