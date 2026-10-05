/**
 * MongoDB Atlas end-of-life calendar.
 *
 * Atlas sells no paid extension for clusters: after a major version's end of
 * life it upgrades the cluster to the next version unless MongoDB approved an
 * extension. No surcharge, so findings carry the forced-upgrade date only.
 * Checked on 2026-10-04 against https://www.mongodb.com/legal/support-policy/lifecycles
 * and https://www.mongodb.com/docs/atlas/atlas-versions/.
 */
import type { ExtendedSupportDeclaration, ExtendedSupportRelease } from "@infrawrench/plugin-base";

const LIFECYCLE_URL = "https://www.mongodb.com/legal/support-policy/lifecycles";
const UPGRADE_URL = "https://www.mongodb.com/docs/atlas/tutorial/major-version-change/";

function release(
  version: string,
  lastSupportedDay: string,
  target: string,
): ExtendedSupportRelease {
  return {
    id: `mongodb-${version}`,
    product: "MongoDB Atlas",
    versions: [version],
    standardSupportEnds: lastSupportedDay,
    targetVersion: target,
    upgradeUrl: UPGRADE_URL,
    note: `No paid extension: Atlas upgrades the cluster to the next major version after end of life. ${LIFECYCLE_URL}`,
  };
}

export const ATLAS_CLUSTER_EXTENDED_SUPPORT: ExtendedSupportDeclaration = {
  versionFieldKey: "mongoDBVersion",
  regionFieldKey: "region",
  releases: [
    release("5.0", "2024-10-31", "MongoDB 8.0"),
    release("6.0", "2025-07-31", "MongoDB 8.0"),
    release("7.0", "2027-08-31", "MongoDB 8.0"),
    // A rapid-release minor.
    release("8.2", "2026-07-31", "MongoDB 8.0 or the current rapid release"),
  ],
};
