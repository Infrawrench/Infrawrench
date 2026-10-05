import {
  remediationDateStamp,
  remediationField,
  remediationId,
  shellQuote,
  type RemediationCommand,
  type RemediationFinding,
  type RemediationPlaceholder,
  type RemediationResource,
} from "@infrawrench/plugin-base";

/**
 * Ready-to-run `linode-cli` commands for savings findings. linode-cli reads
 * its token from its own config (`linode-cli configure`).
 *
 * Command and action names come from the `x-linode-cli-command` /
 * `x-linode-cli-action` keys of the API spec:
 * https://github.com/linode/linode-api-docs/blob/development/openapi.json
 */

/** The disk to image before deleting a powered-off Linode; not in the synced row. */
const DISK_PLACEHOLDER: RemediationPlaceholder = {
  name: "LINODE_DISK_ID",
  description: "ID of the Linode's main disk, from the disks-list command above",
};

export function linodeRemediationCommands(finding: RemediationFinding): RemediationCommand[] {
  if (finding.kind === "idle-commitment") return [];
  const { resource } = finding;

  if (finding.kind === "oversized") {
    if (resource.resourceTypeId !== "linode") return [];
    const id = remediationId(resource);
    if (!id || !finding.targetSize) return [];
    // https://techdocs.akamai.com/linode-api/reference/post-resize-linode-instance
    // A cold migration (the default) powers the Linode off, moves it and
    // powers it back on; disks are resized automatically.
    return [
      {
        tool: "linode-cli",
        command: `linode-cli linodes resize ${shellQuote(id)} --type ${shellQuote(finding.targetSize)}`,
        description: `Resize the Linode to ${finding.targetSize}; Linode powers it off, migrates it and boots it again, which causes downtime.`,
        destructive: false,
      },
    ];
  }

  if (finding.kind === "sleep-schedule") {
    if (resource.resourceTypeId === "linode") {
      const id = remediationId(resource);
      if (!id) return [];
      // https://techdocs.akamai.com/linode-api/reference/post-shutdown-linode-instance
      // https://techdocs.akamai.com/linode-api/reference/post-boot-linode-instance
      return [
        {
          tool: "linode-cli",
          command: `linode-cli linodes shutdown ${shellQuote(id)}`,
          description:
            "Shut the Linode down (Linode keeps billing a powered-off Linode; only deleting it stops charges).",
          destructive: false,
        },
        {
          tool: "linode-cli",
          command: `linode-cli linodes boot ${shellQuote(id)}`,
          description: "Boot the Linode again.",
          destructive: false,
        },
      ];
    }
    if (resource.resourceTypeId === "database") {
      const db = databaseTarget(resource);
      if (!db) return [];
      // https://techdocs.akamai.com/linode-api/reference/suspend-databases-mysql-instance
      // https://techdocs.akamai.com/linode-api/reference/suspend-databases-postgre-sql-instance
      return [
        {
          tool: "linode-cli",
          command: `linode-cli databases ${db.engine}-suspend ${shellQuote(db.id)}`,
          description: "Suspend the database cluster, which pauses its billing.",
          destructive: false,
        },
        {
          tool: "linode-cli",
          command: `linode-cli databases ${db.engine}-resume ${shellQuote(db.id)}`,
          description: "Resume the database cluster.",
          destructive: false,
        },
      ];
    }
    return [];
  }

  // orphan
  switch (resource.resourceTypeId) {
    case "volume": {
      const id = remediationId(resource);
      if (!id) return [];
      // https://techdocs.akamai.com/linode-api/reference/post-clone-volume
      // https://techdocs.akamai.com/linode-api/reference/delete-volume
      // Block Storage has no snapshots; a clone is the only restore point.
      return [
        {
          tool: "linode-cli",
          command: `linode-cli volumes clone ${shellQuote(id)} --label ${shellQuote(preDeleteLabel(resource, 32))}`,
          description:
            "Clone the volume as a restore point (the clone is billed like any volume, so delete it once you are sure).",
          destructive: false,
        },
        {
          tool: "linode-cli",
          command: `linode-cli volumes delete ${shellQuote(id)}`,
          description: "Delete the detached volume and all of its data.",
          destructive: true,
        },
      ];
    }
    case "linode": {
      const id = remediationId(resource);
      if (!id) return [];
      // https://techdocs.akamai.com/linode-api/reference/get-linode-disks
      // https://techdocs.akamai.com/linode-api/reference/post-image
      // https://techdocs.akamai.com/linode-api/reference/delete-linode-instance
      return [
        {
          tool: "linode-cli",
          command: `linode-cli linodes disks-list ${shellQuote(id)}`,
          description: "List the Linode's disks to find the one to keep as an image.",
          destructive: false,
        },
        {
          tool: "linode-cli",
          command: `linode-cli images create --disk_id "$LINODE_DISK_ID" --label ${shellQuote(preDeleteLabel(resource, 50))}`,
          description: "Capture the disk as a private image so the Linode can be recreated later.",
          destructive: false,
          placeholders: [DISK_PLACEHOLDER],
        },
        {
          tool: "linode-cli",
          command: `linode-cli linodes delete ${shellQuote(id)}`,
          description: "Delete the powered-off Linode and its disks, which stops its billing.",
          destructive: true,
        },
      ];
    }
    case "reserved-ip": {
      // externalId is the address itself.
      const ip = remediationId(resource, "address");
      if (!ip) return [];
      // https://techdocs.akamai.com/linode-api/reference/delete-reserved-ip
      return [
        {
          tool: "linode-cli",
          command: `linode-cli networking reserved-ip-delete ${shellQuote(ip)}`,
          description: "Unreserve the unassigned IP; the address cannot be got back.",
          destructive: true,
        },
      ];
    }
    case "nodebalancer": {
      const id = remediationId(resource);
      if (!id) return [];
      // https://techdocs.akamai.com/linode-api/reference/delete-node-balancer
      return [
        {
          tool: "linode-cli",
          command: `linode-cli nodebalancers delete ${shellQuote(id)}`,
          description: "Delete the NodeBalancer that has no backend nodes; its IPs are released.",
          destructive: true,
        },
      ];
    }
    default:
      return [];
  }
}

/** Database externalIds are `{engine}/{id}` (engine is mysql or postgresql). */
function databaseTarget(resource: RemediationResource): { engine: string; id: string } | null {
  const ext = (resource.externalId ?? "").trim();
  const [maybeEngine, maybeId] = ext.includes("/") ? ext.split("/", 2) : ["", ext];
  const engine = maybeEngine || remediationField(resource, "engine");
  if (engine !== "mysql" && engine !== "postgresql") return null;
  if (!maybeId) return null;
  return { engine, id: maybeId };
}

/**
 * `<label>-pre-delete-<YYYYMMDD>`, with the label trimmed so the whole thing
 * fits Linode's label limit (volumes 32, images 50 characters).
 */
function preDeleteLabel(resource: RemediationResource, max: number): string {
  const suffix = `-pre-delete-${remediationDateStamp()}`;
  const base = remediationField(resource, "label") || resource.displayName || "backup";
  return `${base.slice(0, Math.max(1, max - suffix.length))}${suffix}`;
}
