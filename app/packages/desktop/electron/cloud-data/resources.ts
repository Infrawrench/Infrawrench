import { ipcMain } from "electron";
import { cloudFetch } from "./shared";

// The rest of the resources area rides the cloud transport (the renderer's
// `src/lib/cloud-resources.ts` and `cloud-ssh-install.ts`). This one stays a
// channel because the contract documents no answer for it
// (`tunnelSshAttach` succeeds with `Undocumented`), so a typed call would hand
// the renderer `unknown`; it moves once the endpoint declares its schema.
ipcMain.handle(
  "cloud_tunnel_ssh_attach",
  async (_e, { orgId, body }: { orgId: string; body: unknown }) =>
    cloudFetch(orgId, "/resources/tunnel-ssh-attach", {
      method: "POST",
      body: JSON.stringify(body),
    }),
);
