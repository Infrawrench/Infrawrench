/** Detail views for DigitalOcean managed databases and the users minted on them. */
import type { DetailViewSchema, ResourceInstance } from "@infrawrench/plugin-base";
import { kafkaAclFields } from "../resources/managed-database.js";

/**
 * Adds the events log and, for engines whose built-in user has no password
 * (mongo/redis/opensearch/kafka), a "Make connection user" header action.
 * The "DB Users" section is rendered automatically by the host as a
 * child-resource group thanks to `db-user.parentTypeId === "managed-database"`.
 */
export function applyManagedDatabaseDetail(
  detail: DetailViewSchema,
  resource: ResourceInstance,
): void {
  const status = String(resource.fields["status"] ?? "");
  const online = status === "online";
  const engine = String(resource.fields["engine"] ?? "");
  // Mongo/Redis/OpenSearch/Kafka never hand back the default user's password,
  // so peer-pane connections depend on a user minted (+ captured) here.
  // pg/mysql get their password inline, so they don't need the button.
  const needsMintButton =
    online && ["mongodb", "redis", "valkey", "opensearch", "kafka"].includes(engine);

  // Events log — DO doesn't expose process-level logs, but the cluster's
  // event stream covers backups, maintenance, scale events, etc. That's
  // useful as a "what's been happening to my cluster" feed. MongoDB
  // clusters reject the events endpoint (422 "operation is not supported
  // for this cluster type"), so skip the Logs tab for them.
  if (engine !== "mongodb") {
    detail.logs = { defaultTailLines: 200 };
  }

  if (needsMintButton) {
    detail.headerActions = [
      ...(detail.headerActions ?? []),
      {
        kind: "action",
        label: "+ Make connection user",
        variant: "ghost",
        action: {
          type: "prompt-nosql-command",
          command: "make-db-user",
          title: "Create connection user",
          description:
            "DigitalOcean reveals a database user's credential exactly once, at creation. " +
            "Infrawrench creates the user, captures that credential, and stores it locally so " +
            "this cluster's peer-pane connection works.",
          submitLabel: "Create user",
          fields: [
            {
              key: "name",
              label: "Username",
              kind: "text",
              required: true,
              defaultValue: `infrawrench-${Math.random().toString(36).slice(2, 8)}`,
              description: "Letters, digits, and `_-` only. Must be unique within the cluster.",
            },
            // Kafka requires an ACL on the user; surface topic + permission so
            // it's editable, defaulting to full access on every topic.
            ...(engine === "kafka" ? kafkaAclFields() : []),
          ],
        },
      },
    ];
  }
}

/** A db-user's detail view is mostly its connection-credential summary. */
export function applyDatabaseUserDetail(
  detail: DetailViewSchema,
  resource: ResourceInstance,
): void {
  detail.subtitle = `Database user · ${String(resource.fields["role"] ?? "user")}`;
  detail.sections.push({
    kind: "section",
    title: "Credential",
    children: [
      {
        kind: "text",
        variant: "muted",
        content:
          "The password DO returned at create time is stored locally and used to fill in the " +
          "cluster's connection string. DO doesn't expose passwords for users it didn't create " +
          "via this flow, so pre-existing users (including `doadmin`) show no stored password.",
      },
    ],
  });
}
