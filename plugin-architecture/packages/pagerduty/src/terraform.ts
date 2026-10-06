import type {
  TerraformExportCapability,
  TerraformExportResult,
  TerraformValue,
} from "@infrawrench/plugin-base";
import { fieldNumber, fieldString, tf } from "@infrawrench/plugin-base";

/**
 * Terraform mapping for PagerDuty: provider `PagerDuty/pagerduty`.
 * Argument names verified against the provider docs
 * (github.com/PagerDuty/terraform-provider-pagerduty, website/docs, 2026-10):
 *   - provider: `token`; `service_region = "eu"` for EU accounts.
 *   - pagerduty_service: `name`, `escalation_policy` (id) required;
 *     `description`, `auto_resolve_timeout`/`acknowledgement_timeout` (seconds).
 *   - pagerduty_team: `name`, `description`.
 *   - pagerduty_business_service: `name`, `description`, `point_of_contact`, `team`.
 *   - pagerduty_escalation_policy: `name`, `num_loops`, a `rule` block with
 *     `escalation_delay_in_minutes` and `target { type, id }`. Only
 *     single-level, single-target policies are exported (see below).
 *   - pagerduty_maintenance_window: `start_time`, `end_time`, `services`, `description`.
 * Schedules are skipped: their layers are not synced, and a schedule written
 * without them would replace the rotation on apply. Users, incidents and
 * event orchestrations are skipped too (people are managed by SSO, incidents
 * are not configuration, orchestration rules are not synced).
 */
export const pagerdutyTerraformExport: TerraformExportCapability = {
  provider: { name: "pagerduty", source: "PagerDuty/pagerduty", version: "~> 3.0" },
  providerConfig: { token: tf.ref("var.pagerduty_token") },
  variables: [
    {
      name: "pagerduty_token",
      description: "PagerDuty REST API key (Integrations, API Access Keys)",
      sensitive: true,
    },
  ],
  supportedResourceTypeIds: [
    "pagerduty-service",
    "pagerduty-team",
    "pagerduty-business-service",
    "pagerduty-escalation-policy",
    "pagerduty-maintenance-window",
  ],
  mapResource(resource): TerraformExportResult | null {
    const name = fieldString(resource, "name") || resource.displayName;
    const description = fieldString(resource, "description");
    const importId = resource.externalId;
    switch (resource.resourceTypeId) {
      case "pagerduty-service": {
        const policy = fieldString(resource, "escalationPolicyId");
        if (!name || !policy) return null;
        const attributes: Record<string, TerraformValue> = {
          name: tf.str(name),
          escalation_policy: tf.str(policy),
        };
        if (description) attributes["description"] = tf.str(description);
        const resolve = fieldNumber(resource, "autoResolveMinutes");
        if (resolve !== undefined) attributes["auto_resolve_timeout"] = tf.num(resolve * 60);
        const ack = fieldNumber(resource, "acknowledgementTimeoutMinutes");
        if (ack !== undefined) attributes["acknowledgement_timeout"] = tf.num(ack * 60);
        return { resource: { type: "pagerduty_service", name, attributes, importId } };
      }
      case "pagerduty-team": {
        if (!name) return null;
        const attributes: Record<string, TerraformValue> = { name: tf.str(name) };
        if (description) attributes["description"] = tf.str(description);
        return { resource: { type: "pagerduty_team", name, attributes, importId } };
      }
      case "pagerduty-business-service": {
        if (!name) return null;
        const attributes: Record<string, TerraformValue> = { name: tf.str(name) };
        if (description) attributes["description"] = tf.str(description);
        const poc = fieldString(resource, "pointOfContact");
        if (poc) attributes["point_of_contact"] = tf.str(poc);
        const team = fieldString(resource, "teamId");
        if (team) attributes["team"] = tf.str(team);
        return { resource: { type: "pagerduty_business_service", name, attributes, importId } };
      }
      case "pagerduty-escalation-policy": {
        if (!name) return null;
        let rules: Array<{ delay?: number; targets?: Array<{ id?: string; type?: string }> }> = [];
        try {
          rules = JSON.parse(fieldString(resource, "rulesJson") || "[]");
        } catch {
          rules = [];
        }
        if (rules.length === 0) return null;
        const attributes: Record<string, TerraformValue> = { name: tf.str(name) };
        if (description) attributes["description"] = tf.str(description);
        const loops = fieldNumber(resource, "numLoops");
        if (loops !== undefined) attributes["num_loops"] = tf.num(loops);
        // The bundle renderer has no repeated-block form, so only a policy
        // with one level and one target is exported; anything richer would
        // be written wrong, which is worse than not at all.
        const only = rules[0];
        const target = only?.targets?.[0];
        if (rules.length !== 1 || only?.targets?.length !== 1 || !target?.id) return null;
        attributes["rule"] = tf.block({
          escalation_delay_in_minutes: tf.num(only.delay ?? 30),
          target: tf.block({
            type: tf.str(target.type ?? "user_reference"),
            id: tf.str(target.id),
          }),
        });
        return { resource: { type: "pagerduty_escalation_policy", name, attributes, importId } };
      }
      case "pagerduty-maintenance-window": {
        const start = fieldString(resource, "startTime");
        const end = fieldString(resource, "endTime");
        const services = fieldString(resource, "serviceIds")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        if (!start || !end || services.length === 0) return null;
        if (fieldString(resource, "state") === "past") return null;
        const attributes: Record<string, TerraformValue> = {
          start_time: tf.str(start),
          end_time: tf.str(end),
          services: tf.list(services.map((s) => tf.str(s))),
        };
        if (description) attributes["description"] = tf.str(description);
        return {
          resource: {
            type: "pagerduty_maintenance_window",
            name: description || resource.displayName,
            attributes,
            importId,
          },
        };
      }
      default:
        return null;
    }
  },
};
