import type { CreateResourceConfig, ResourceInstance } from "@infrawrench/plugin-base";
import type { GcpCreateContext } from "./create-context.js";

export const pubsubCreateConfigHandlers: Record<
  string,
  (ctx: GcpCreateContext, parentResourceId?: string) => Promise<CreateResourceConfig>
> = {
  "pubsub-topic": async (ctx, parentResourceId) => {
    return {
      fields: [
        {
          key: "name",
          label: "Topic Name",
          kind: "text",
          required: true,
          description: "Topic ID (letters, numbers, hyphens, underscores)",
        },
      ],
    };
  },
  "pubsub-subscription": async (ctx, parentResourceId) => {
    const p = ctx.project;
    const hasParent = !!parentResourceId;
    const fields: CreateResourceConfig["fields"] = [
      {
        key: "name",
        label: "Subscription Name",
        kind: "text",
        required: true,
      },
    ];
    if (!hasParent) {
      const topics = await ctx.paginate<Record<string, unknown>>(
        `https://pubsub.googleapis.com/v1/projects/${p}/topics`,
        "topics",
      );
      const topicOptions = topics.map((t) => {
        const fullName = String(t["name"] ?? "");
        const shortName = fullName.split("/").pop() ?? fullName;
        return { id: fullName, label: shortName };
      });
      fields.push({
        key: "topic",
        label: "Topic",
        kind: "select",
        required: true,
        options: topicOptions,
        ...(topicOptions[0] ? { defaultValue: topicOptions[0].id } : {}),
      });
    }
    fields.push({
      key: "ackDeadlineSeconds",
      label: "Ack Deadline (seconds)",
      kind: "number",
      required: false,
      defaultValue: "10",
      minValue: 10,
      maxValue: 600,
    });
    return { fields };
  },
};

export const pubsubCreateResourceHandlers: Record<
  string,
  (
    ctx: GcpCreateContext,
    accountId: string,
    fields: Record<string, string>,
    parentResourceId?: string,
  ) => Promise<ResourceInstance>
> = {
  "pubsub-topic": async (ctx, accountId, fields, parentResourceId) => {
    const p = ctx.project;
    const tok = await ctx.token();
    const name = fields["name"] ?? "";
    const fullName = `projects/${p}/topics/${name}`;

    const res = await fetch(`https://pubsub.googleapis.com/v1/${fullName}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    if (!res.ok) throw new Error(`Pub/Sub API ${res.status}: ${await res.text()}`);
    const now = ctx.now();
    return {
      id: ctx.id(accountId, "pubsub-topic", name),
      pluginId: "gcp",
      resourceTypeId: "pubsub-topic",
      accountId,
      displayName: name,
      fields: { name, kmsKeyName: "", messageRetentionDuration: "" },
      resolvedOutputs: {},
      secretStates: [],
      externalId: name,
      createdAt: now,
      updatedAt: now,
    };
  },
  "pubsub-subscription": async (ctx, accountId, fields, parentResourceId) => {
    const p = ctx.project;
    const tok = await ctx.token();
    const name = fields["name"] ?? "";
    // When created from a topic's detail page, the topic field is hidden in
    // the form — recover the full topic path from parentResourceId.
    // Resource IDs are `{accountId}:pubsub-topic:projects/{p}/topics/{name}`.
    const parentTopicPath = parentResourceId ? parentResourceId.split(":").slice(2).join(":") : "";
    const topic = fields["topic"] || parentTopicPath;
    const ackDeadlineSeconds = Number(fields["ackDeadlineSeconds"] || 10);
    const fullName = `projects/${p}/subscriptions/${name}`;

    const res = await fetch(`https://pubsub.googleapis.com/v1/${fullName}`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
      body: JSON.stringify({ topic, ackDeadlineSeconds }),
    });
    if (!res.ok) throw new Error(`Pub/Sub API ${res.status}: ${await res.text()}`);
    const now = ctx.now();
    return {
      id: ctx.id(accountId, "pubsub-subscription", name),
      pluginId: "gcp",
      resourceTypeId: "pubsub-subscription",
      accountId,
      displayName: name,
      fields: {
        name,
        topic: topic.split("/").pop() ?? topic,
        ackDeadlineSeconds,
        messageRetentionDuration: "",
        filter: "",
      },
      resolvedOutputs: {},
      secretStates: [],
      externalId: name,
      createdAt: now,
      updatedAt: now,
    };
  },
};
