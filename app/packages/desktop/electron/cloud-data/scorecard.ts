import { ipcMain } from "electron";
import { cloudFetch } from "./shared";

// The infrastructure scorecard — cloud only, deliberately. Two of its six
// pillars are org state (the recovery objectives coverage is judged against,
// the cross-cloud access review) and the trend lives in a cloud table, so a
// local scorecard would grade an org on a third of the evidence. The panel
// says so rather than rendering a partial grade.

ipcMain.handle("cloud_scorecard", async (_e, { orgId }: { orgId: string }) => {
  return cloudFetch(orgId, "/scorecard");
});
