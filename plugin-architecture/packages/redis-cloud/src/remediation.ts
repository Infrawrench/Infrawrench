import {
  remediationField,
  remediationId,
  shellQuote,
  type RemediationCommand,
  type RemediationFinding,
  type RemediationPlaceholder,
} from "@infrawrench/plugin-base";
import { T } from "./resource-types.js";

/**
 * Remediation for Redis Cloud savings findings. Redis Cloud has no official
 * CLI, so the commands are `curl` against the REST API with the account key
 * and a user key as headers. Pro and Essentials databases live under
 * different paths (`/subscriptions/...` and `/fixed/subscriptions/...`).
 * Every write returns a task id to poll with `GET /v1/tasks/{taskId}`.
 *
 * References:
 * https://redis.io/docs/latest/operate/rc/api/examples/back-up-and-import-data/
 * https://redis.io/docs/latest/operate/rc/api/examples/create-database/
 * https://api.redislabs.com/v1/swagger-ui/index.html
 */
export function redisCloudRemediationCommands(finding: RemediationFinding): RemediationCommand[] {
  if (finding.kind !== "orphan") return [];
  const { resource } = finding;
  if (resource.resourceTypeId !== T.database) return [];
  const db = remediationId(resource);
  const sub = remediationField(resource, "subscriptionId");
  if (!/^\d+$/.test(db) || !/^\d+$/.test(sub)) return [];
  const essentials = remediationField(resource, "plan") === "Essentials";
  const url = `https://api.redislabs.com/v1${essentials ? "/fixed" : ""}/subscriptions/${sub}/databases/${db}`;
  const auth = `-H "x-api-key: $REDIS_CLOUD_ACCOUNT_KEY" -H "x-api-secret-key: $REDIS_CLOUD_USER_KEY"`;
  const hasBackupPath = resource.fields["backupEnabled"] === true;
  // With remote backup configured the backup call needs no body; otherwise
  // the destination has to be given as an ad-hoc path.
  const backupBody = hasBackupPath
    ? ""
    : ` -H 'Content-Type: application/json' -d "{\\"adhocBackupPath\\": \\"$REDIS_BACKUP_PATH\\"}"`;
  const placeholders = hasBackupPath
    ? [ACCOUNT_KEY, USER_KEY]
    : [ACCOUNT_KEY, USER_KEY, BACKUP_PATH];
  return [
    {
      tool: "curl",
      command: `curl -sS -X POST ${shellQuote(`${url}/backup`)} ${auth}${backupBody}`,
      description: hasBackupPath
        ? "Back the database up to its configured backup location before deleting it."
        : "Back the database up to a storage bucket you choose before deleting it.",
      destructive: false,
      placeholders,
    },
    {
      tool: "curl",
      command: `curl -sS -X DELETE ${shellQuote(url)} ${auth}`,
      description: "Delete the nearly empty database once the backup task has completed.",
      destructive: true,
      placeholders: [ACCOUNT_KEY, USER_KEY],
    },
  ];
}

const ACCOUNT_KEY: RemediationPlaceholder = {
  name: "REDIS_CLOUD_ACCOUNT_KEY",
  description: "The Redis Cloud API account key for this account",
};

const USER_KEY: RemediationPlaceholder = {
  name: "REDIS_CLOUD_USER_KEY",
  description: "A Redis Cloud user API key with permission to manage this database",
};

const BACKUP_PATH: RemediationPlaceholder = {
  name: "REDIS_BACKUP_PATH",
  description:
    "Where to write the backup, e.g. s3://bucket/path or gs://bucket/path, with Redis Cloud granted write access",
};
