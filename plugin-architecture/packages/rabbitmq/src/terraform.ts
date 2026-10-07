import type {
  ResourceInstance,
  TerraformExportCapability,
  TerraformExportResult,
  TerraformValue,
} from "@infrawrench/plugin-base";
import { fieldBool, fieldNumber, fieldString, tf } from "@infrawrench/plugin-base";
import { tagList } from "./mappers.js";

/**
 * Terraform mapping for `cyrilgdn/rabbitmq` (1.10, the de facto provider;
 * RabbitMQ publishes none of its own; docs under website/docs/r read
 * 2026-10). Import ids: vhost `name`, user `name`, everything vhost-scoped
 * `name@vhost` (permissions `user@vhost`), bindings
 * `vhost/source/destination/destination_type/properties_key`. Secrets
 * (user passwords, upstream and shovel URIs, which carry credentials) become
 * variables.
 */
const ident = (s: string) => s.replace(/[^A-Za-z0-9_]/g, "_").replace(/^([^A-Za-z_])/, "_$1");

function parseObject(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Policy definitions are `map(string)`-ish in the provider: scalars stay scalars, nested values go as JSON text. */
function definitionMap(def: Record<string, unknown>): TerraformValue {
  const entries: Record<string, TerraformValue> = {};
  for (const [k, v] of Object.entries(def)) {
    if (typeof v === "number") entries[k] = tf.num(v);
    else if (typeof v === "boolean") entries[k] = tf.bool(v);
    else if (typeof v === "string") entries[k] = tf.str(v);
    else entries[k] = tf.str(JSON.stringify(v));
  }
  return tf.map(entries);
}

function policy(r: ResourceInstance, type: string): TerraformExportResult | null {
  const s = (k: string) => fieldString(r, k);
  if (!s("name")) return null;
  return {
    resource: {
      type,
      name: `${s("vhost")}_${s("name")}`,
      attributes: {
        name: tf.str(s("name")),
        vhost: tf.str(s("vhost")),
        policy: tf.block({
          pattern: tf.str(s("pattern")),
          priority: tf.num(fieldNumber(r, "priority") ?? 0),
          apply_to: tf.str(s("applyTo") || "all"),
          definition: definitionMap(parseObject(s("definition"))),
        }),
      },
      importId: `${s("name")}@${s("vhost")}`,
    },
  };
}

export const rabbitTerraformExport: TerraformExportCapability = {
  provider: { name: "rabbitmq", source: "cyrilgdn/rabbitmq", version: "~> 1.10" },
  providerConfig: {
    endpoint: tf.ref("var.rabbitmq_endpoint"),
    username: tf.ref("var.rabbitmq_username"),
    password: tf.ref("var.rabbitmq_password"),
  },
  variables: [
    {
      name: "rabbitmq_endpoint",
      description: "Management API URL, e.g. https://mq.example.com:15671",
    },
    { name: "rabbitmq_username", description: "Management user with the administrator tag" },
    { name: "rabbitmq_password", description: "Password for that user", sensitive: true },
  ],
  supportedResourceTypeIds: [
    "rabbitmq-vhost",
    "rabbitmq-exchange",
    "rabbitmq-queue",
    "rabbitmq-binding",
    "rabbitmq-policy",
    "rabbitmq-operator-policy",
    "rabbitmq-user",
    "rabbitmq-permission",
    "rabbitmq-topic-permission",
    "rabbitmq-federation-upstream",
    "rabbitmq-shovel",
  ],
  mapResource(resource): TerraformExportResult | null {
    const s = (k: string) => fieldString(resource, k);
    const vhost = s("vhost");
    switch (resource.resourceTypeId) {
      case "rabbitmq-vhost": {
        const attributes: Record<string, TerraformValue> = { name: tf.str(s("name")) };
        if (s("description")) attributes["description"] = tf.str(s("description"));
        if (s("defaultQueueType")) attributes["default_queue_type"] = tf.str(s("defaultQueueType"));
        const mc = fieldNumber(resource, "maxConnections");
        if (mc !== undefined && mc >= 0) attributes["max_connections"] = tf.str(String(mc));
        const mq = fieldNumber(resource, "maxQueues");
        if (mq !== undefined && mq >= 0) attributes["max_queues"] = tf.str(String(mq));
        return {
          resource: {
            type: "rabbitmq_vhost",
            name: s("name") || "default",
            attributes,
            importId: s("name"),
          },
        };
      }
      case "rabbitmq-exchange": {
        const name = s("name");
        if (!name || name.startsWith("amq.")) return null;
        const settings: Record<string, TerraformValue> = {
          type: tf.str(s("type") || "direct"),
          durable: tf.bool(fieldBool(resource, "durable") ?? true),
          auto_delete: tf.bool(fieldBool(resource, "autoDelete") ?? false),
        };
        const args = parseObject(s("arguments"));
        if (Object.keys(args).length) settings["arguments"] = definitionMap(args);
        return {
          resource: {
            type: "rabbitmq_exchange",
            name: `${vhost}_${name}`,
            attributes: { name: tf.str(name), vhost: tf.str(vhost), settings: tf.block(settings) },
            importId: `${name}@${vhost}`,
          },
        };
      }
      case "rabbitmq-queue": {
        const name = s("name");
        if (!name || name.startsWith("amq.")) return null;
        const settings: Record<string, TerraformValue> = {
          durable: tf.bool(fieldBool(resource, "durable") ?? true),
          auto_delete: tf.bool(fieldBool(resource, "autoDelete") ?? false),
        };
        const args = parseObject(s("arguments"));
        if (Object.keys(args).length) settings["arguments_json"] = tf.str(JSON.stringify(args));
        return {
          resource: {
            type: "rabbitmq_queue",
            name: `${vhost}_${name}`,
            attributes: { name: tf.str(name), vhost: tf.str(vhost), settings: tf.block(settings) },
            importId: `${name}@${vhost}`,
          },
        };
      }
      case "rabbitmq-binding": {
        const attributes: Record<string, TerraformValue> = {
          source: tf.str(s("source")),
          vhost: tf.str(vhost),
          destination: tf.str(s("destination")),
          destination_type: tf.str(s("destinationType") || "queue"),
          routing_key: tf.str(s("routingKey")),
        };
        const args = parseObject(s("arguments"));
        if (Object.keys(args).length) attributes["arguments_json"] = tf.str(JSON.stringify(args));
        const props = s("propertiesKey");
        return {
          resource: {
            type: "rabbitmq_binding",
            name: `${s("source")}_${s("destination")}`,
            attributes,
            importId: [vhost, s("source"), s("destination"), s("destinationType") || "queue", props]
              .map((p) => encodeURIComponent(p))
              .join("/"),
          },
        };
      }
      case "rabbitmq-policy":
        return policy(resource, "rabbitmq_policy");
      case "rabbitmq-operator-policy":
        return policy(resource, "rabbitmq_operator_policy");
      case "rabbitmq-user": {
        const name = s("name");
        if (!name) return null;
        const variable = `rabbitmq_user_${ident(name)}_password`;
        const tags = tagList(s("tags"));
        return {
          resource: {
            type: "rabbitmq_user",
            name,
            attributes: {
              name: tf.str(name),
              password: tf.ref(`var.${variable}`),
              ...(tags.length ? { tags: tf.list(tags.map((t) => tf.str(t))) } : {}),
            },
            importId: name,
            comments: [
              "The current password cannot be read back; set the variable to keep or rotate it.",
            ],
          },
          variables: [
            { name: variable, description: `Password for RabbitMQ user ${name}`, sensitive: true },
          ],
        };
      }
      case "rabbitmq-permission":
        return {
          resource: {
            type: "rabbitmq_permissions",
            name: `${s("user")}_${vhost}`,
            attributes: {
              user: tf.str(s("user")),
              vhost: tf.str(vhost),
              permissions: tf.block({
                configure: tf.str(s("configure")),
                write: tf.str(s("write")),
                read: tf.str(s("read")),
              }),
            },
            importId: `${s("user")}@${vhost}`,
          },
        };
      case "rabbitmq-topic-permission":
        return {
          resource: {
            type: "rabbitmq_topic_permissions",
            name: `${s("user")}_${vhost}_${s("exchange")}`,
            attributes: {
              user: tf.str(s("user")),
              vhost: tf.str(vhost),
              permissions: tf.block({
                exchange: tf.str(s("exchange")),
                write: tf.str(s("write")),
                read: tf.str(s("read")),
              }),
            },
            importId: `${s("user")}@${vhost}`,
            comments: [
              "The provider manages all of a user's topic permissions in a vhost as one resource.",
            ],
          },
        };
      case "rabbitmq-federation-upstream": {
        const name = s("name");
        const variable = `rabbitmq_upstream_${ident(`${vhost}_${name}`)}_uri`;
        const def: Record<string, TerraformValue> = { uri: tf.ref(`var.${variable}`) };
        const n = (k: string, key: string) => {
          const v = fieldNumber(resource, k);
          if (v !== undefined) def[key] = tf.num(v);
        };
        n("prefetchCount", "prefetch_count");
        n("reconnectDelay", "reconnect_delay");
        n("maxHops", "max_hops");
        n("expires", "expires");
        n("messageTtl", "message_ttl");
        if (s("ackMode")) def["ack_mode"] = tf.str(s("ackMode"));
        if (s("exchange")) def["exchange"] = tf.str(s("exchange"));
        if (s("queue")) def["queue"] = tf.str(s("queue"));
        const trust = fieldBool(resource, "trustUserId");
        if (trust !== undefined) def["trust_user_id"] = tf.bool(trust);
        return {
          resource: {
            type: "rabbitmq_federation_upstream",
            name: `${vhost}_${name}`,
            attributes: { name: tf.str(name), vhost: tf.str(vhost), definition: tf.block(def) },
            importId: `${name}@${vhost}`,
          },
          variables: [
            {
              name: variable,
              description: `AMQP URI (with credentials) of federation upstream ${name}`,
              sensitive: true,
            },
          ],
        };
      }
      case "rabbitmq-shovel": {
        const name = s("name");
        const src = `rabbitmq_shovel_${ident(`${vhost}_${name}`)}_source_uri`;
        const dst = `rabbitmq_shovel_${ident(`${vhost}_${name}`)}_destination_uri`;
        const info: Record<string, TerraformValue> = {
          source_uri: tf.ref(`var.${src}`),
          destination_uri: tf.ref(`var.${dst}`),
        };
        const opt = (k: string, key: string) => {
          if (s(k)) info[key] = tf.str(s(k));
        };
        opt("srcProtocol", "source_protocol");
        opt("srcQueue", "source_queue");
        opt("srcExchange", "source_exchange");
        opt("srcExchangeKey", "source_exchange_key");
        opt("destProtocol", "destination_protocol");
        opt("destQueue", "destination_queue");
        opt("destExchange", "destination_exchange");
        opt("ackMode", "ack_mode");
        return {
          resource: {
            type: "rabbitmq_shovel",
            name: `${vhost}_${name}`,
            attributes: { name: tf.str(name), vhost: tf.str(vhost), info: tf.block(info) },
            importId: `${name}@${vhost}`,
          },
          variables: [
            { name: src, description: `Source URI of shovel ${name}`, sensitive: true },
            { name: dst, description: `Destination URI of shovel ${name}`, sensitive: true },
          ],
        };
      }
      default:
        return null;
    }
  },
};
