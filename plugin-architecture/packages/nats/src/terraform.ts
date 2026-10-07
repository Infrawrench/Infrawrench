import type {
  TerraformExportCapability,
  TerraformExportResult,
  TerraformValue,
} from "@infrawrench/plugin-base";
import { fieldString, tf } from "@infrawrench/plugin-base";

/**
 * Terraform mapping for `nats-io/jetstream` (0.4, the NATS maintainers'
 * provider; docs/resources and the import ids from its source, read
 * 2026-10): `jetstream_stream` (import `JETSTREAM_STREAM_<name>`) and
 * `jetstream_consumer` (import `JETSTREAM_STREAM_<stream>_CONSUMER_<durable>`),
 * built from the configuration `/jsz?config=1` reported at sync. Durations
 * arrive in nanoseconds and the provider takes seconds. Ephemeral consumers,
 * KV buckets and object stores (streams named KV_ / OBJ_) are left out;
 * the provider has dedicated bucket resources for those.
 */
const sec = (ns: unknown): TerraformValue | undefined =>
  typeof ns === "number" && ns > 0 ? tf.num(ns / 1e9) : undefined;
const pos = (v: unknown): TerraformValue | undefined =>
  typeof v === "number" && v > 0 ? tf.num(v) : undefined;

function parse(raw: string | undefined): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function put(out: Record<string, TerraformValue>, key: string, v: TerraformValue | undefined) {
  if (v !== undefined) out[key] = v;
}

export const natsTerraformExport: TerraformExportCapability = {
  provider: { name: "jetstream", source: "nats-io/jetstream", version: "~> 0.4" },
  providerConfig: {
    servers: tf.ref("var.nats_servers"),
    credential_data: tf.ref("var.nats_credentials"),
  },
  variables: [
    { name: "nats_servers", description: "NATS client URLs, e.g. nats://nats.example.com:4222" },
    {
      name: "nats_credentials",
      description: "Contents of a NATS .creds file for an account allowed to manage JetStream",
      sensitive: true,
    },
  ],
  supportedResourceTypeIds: ["nats-stream", "nats-consumer"],
  mapResource(resource): TerraformExportResult | null {
    const c = parse(resource.resolvedOutputs["config"]);
    if (!c) return null;
    if (resource.resourceTypeId === "nats-stream") {
      const name = fieldString(resource, "name");
      if (!name || /^(KV|OBJ)_/.test(name)) return null;
      const a: Record<string, TerraformValue> = { name: tf.str(name) };
      if (Array.isArray(c["subjects"]))
        a["subjects"] = tf.list((c["subjects"] as string[]).map((x) => tf.str(x)));
      for (const [k, key] of [
        ["description", "description"],
        ["retention", "retention"],
        ["storage", "storage"],
        ["discard", "discard"],
        ["compression", "compression"],
      ] as const)
        if (typeof c[k] === "string" && c[k] && !(k === "compression" && c[k] === "none"))
          a[key] = tf.str(c[k] as string);
      put(a, "replicas", pos(c["num_replicas"]));
      put(a, "max_msgs", pos(c["max_msgs"]));
      put(a, "max_bytes", pos(c["max_bytes"]));
      put(a, "max_age", sec(c["max_age"]));
      put(a, "max_msgs_per_subject", pos(c["max_msgs_per_subject"]));
      put(a, "max_msg_size", pos(c["max_msg_size"]));
      put(a, "max_consumers", pos(c["max_consumers"]));
      put(a, "duplicate_window", sec(c["duplicate_window"]));
      for (const [k, key] of [
        ["deny_delete", "deny_delete"],
        ["deny_purge", "deny_purge"],
        ["allow_rollup_hdrs", "allow_rollup_hdrs"],
        ["allow_direct", "allow_direct"],
      ] as const)
        if (c[k] === true) a[key] = tf.bool(true);
      return {
        resource: {
          type: "jetstream_stream",
          name,
          attributes: a,
          importId: `JETSTREAM_STREAM_${name}`,
        },
      };
    }
    if (resource.resourceTypeId === "nats-consumer") {
      const stream = fieldString(resource, "stream");
      const durable =
        (typeof c["durable_name"] === "string" && c["durable_name"]) ||
        (c["inactive_threshold"] === undefined ? fieldString(resource, "name") : "");
      if (!stream || !durable || /^(KV|OBJ)_/.test(stream)) return null;
      const a: Record<string, TerraformValue> = {
        // The provider parses stream_id as the stream resource's id, JETSTREAM_STREAM_<name>.
        stream_id: tf.str(`JETSTREAM_STREAM_${stream}`),
        durable_name: tf.str(durable),
      };
      for (const [k, key] of [
        ["description", "description"],
        ["ack_policy", "ack_policy"],
        ["replay_policy", "replay_policy"],
        ["deliver_subject", "delivery_subject"],
        ["deliver_group", "delivery_group"],
      ] as const)
        if (typeof c[k] === "string" && c[k]) a[key] = tf.str(c[k] as string);
      const policy = c["deliver_policy"];
      if (policy === "all") a["deliver_all"] = tf.bool(true);
      else if (policy === "last") a["deliver_last"] = tf.bool(true);
      else if (policy === "by_start_sequence" && typeof c["opt_start_seq"] === "number")
        a["stream_sequence"] = tf.num(c["opt_start_seq"] as number);
      if (Array.isArray(c["filter_subjects"]))
        a["filter_subjects"] = tf.list((c["filter_subjects"] as string[]).map((x) => tf.str(x)));
      else if (typeof c["filter_subject"] === "string" && c["filter_subject"])
        a["filter_subject"] = tf.str(c["filter_subject"] as string);
      put(a, "ack_wait", sec(c["ack_wait"]));
      put(a, "max_delivery", pos(c["max_deliver"]));
      put(a, "max_ack_pending", pos(c["max_ack_pending"]));
      put(a, "max_waiting", pos(c["max_waiting"]));
      put(a, "replicas", pos(c["num_replicas"]));
      put(a, "heartbeat", sec(c["idle_heartbeat"]));
      if (c["flow_control"] === true) a["flow_control"] = tf.bool(true);
      return {
        resource: {
          type: "jetstream_consumer",
          name: `${stream}_${durable}`,
          attributes: a,
          importId: `JETSTREAM_STREAM_${stream}_CONSUMER_${durable}`,
        },
      };
    }
    return null;
  },
};
