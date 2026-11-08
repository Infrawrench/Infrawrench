import { ipcMain } from "electron";
import { cloudFetchText } from "./shared";

// Custom graphs: cloud-mode only (the script runs in the web server's
// sandbox against org data; there is no local-SQLite equivalent). Every
// call but the typings goes over the cloud transport
// (`src/lib/cloud-custom-graphs.ts`); the typings are a text answer, which
// the transport does not read yet.

// Org-specific since the read-only infra half reflects connected accounts:
// this cannot be the static string the renderer once imported.
ipcMain.handle("cloud_custom_graph_typings", async (_e, { orgId }: { orgId: string }) => {
  return cloudFetchText(orgId, "/custom-graphs/typings");
});
