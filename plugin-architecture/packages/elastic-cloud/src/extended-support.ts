/**
 * Elastic Stack end-of-support calendar for hosted deployments.
 *
 * Elastic sells no paid extension and does not schedule a forced major
 * upgrade: past end of support a deployment keeps running but gets no fixes
 * and cannot be redeployed on that version. No surcharge, so findings carry
 * the date only. Checked on 2026-10-04 against https://www.elastic.co/support/eol.
 */
import type { ExtendedSupportDeclaration } from "@infrawrench/plugin-base";

const EOL_URL = "https://www.elastic.co/support/eol";
const UPGRADE_URL = "https://www.elastic.co/docs/deploy-manage/upgrade/deployment-or-cluster";
const NOTE = `No paid extension and no forced upgrade, but no fixes after end of support. ${EOL_URL}`;

export const ELASTIC_DEPLOYMENT_EXTENDED_SUPPORT: ExtendedSupportDeclaration = {
  versionFieldKey: "version",
  regionFieldKey: "region",
  releases: [
    {
      id: "stack-7.17",
      product: "Elastic Stack",
      versions: ["7.17"],
      standardSupportEnds: "2026-01-15",
      targetVersion: "9.x",
      upgradeUrl: UPGRADE_URL,
      note: NOTE,
    },
    {
      id: "stack-8.19",
      product: "Elastic Stack",
      versions: ["8.19"],
      standardSupportEnds: "2027-07-15",
      targetVersion: "9.x",
      upgradeUrl: UPGRADE_URL,
      note: NOTE,
    },
  ],
};
