/**
 * Virtual tag tools: list, preview, create, update and delete the org's
 * rule-based computed tags from MCP clients and the chat agent.
 *
 * Querying by a virtual tag needs no tool of its own: `query_costs` (and every
 * other cost tool taking filters) accepts the `virtual_tag` dimension, and the
 * cost query language spells it `virtual_tag['team'] = 'payments'`. These
 * tools manage the definitions, with the same permissions as the HTTP API.
 */
import { z } from "zod";
import { virtualTagInputSchema } from "@infrawrench/ui/cost/config";
import { describeVirtualTagRule } from "@infrawrench/client-core";
import {
  VirtualTagError,
  VirtualTagInUseError,
  VirtualTagKeyConflictError,
  createVirtualTag,
  deleteVirtualTag,
  listVirtualTags,
  updateVirtualTag,
} from "@infrawrench/server-core/cost/virtual-tags";
import { previewVirtualTag } from "@infrawrench/server-core/cost/virtual-tag-pass";
import { logAudit } from "../services/audit";
import { denyUnlessPermitted } from "./permissions";
import { ok, err, type ToolDefinition } from "./types";

function toolError(e: unknown) {
  if (e instanceof VirtualTagKeyConflictError) return err(e.message);
  if (e instanceof VirtualTagInUseError) return err(e.message);
  if (e instanceof VirtualTagError) return err(e.message);
  throw e;
}

const RULES_HELP =
  "A virtual tag is an ordered rule list; a cost row takes the value of the first rule it " +
  "matches, else `defaultValue` (or stays unset). Each rule has a `query` in the cost query " +
  "language (empty matches everything; it may not reference another virtual tag), optional " +
  "inclusive `startsOn`/`endsOn` days, and a `kind`: `value` (fixed `value`), `tag` (copy " +
  "the value from the first present provider tag key in `sources`, each with an optional " +
  "`valuePrefix` and its own `query`; `valueTransform` lower/upper case-folds it: this is " +
  "how `env`, `Environment` and `ENV` collapse into one key), `split` (`allocations` of " +
  "{value, percent} summing to 100) or `metric_split` (`allocations` of {value, metricId}, " +
  "weighted day by day by business metrics; see list_business_metrics for ids). Splits are " +
  "weighted, so totals never change. Everything is computed at query time; nothing is " +
  "written into stored cost data.";

export function virtualTagTools(): ToolDefinition[] {
  return [
    {
      name: "list_virtual_tags",
      title: "List virtual tags",
      description:
        "The organization's virtual tags: computed tags defined by ordered rules. Use a row's " +
        "`key` as the `tagKey` of a `virtual_tag` filter or grouping in query_costs (or " +
        "`virtual_tag['key'] = 'value'` in the cost query language). Each tag carries its rules " +
        "(with a one-line `summary` each), its processing `status`, and once processed, " +
        "`status.stats`: spend per rule, unmatched spend and the top values over stored " +
        "history. Quote unmatched spend when the user asks how complete a tag is.\n\n" +
        RULES_HELP,
      inputSchema: {},
      risk: "read",
      permission: "costs:read",
      handler: async (_input, auth) => {
        const denied = await denyUnlessPermitted(auth, "costs:read");
        if (denied) return denied;
        const tags = await listVirtualTags(auth.organizationId);
        return ok(
          tags.map((t) => ({
            ...t,
            rules: t.rules.map((r) => ({ ...r, summary: describeVirtualTagRule(r) })),
          })),
        );
      },
    },

    {
      name: "preview_virtual_tag",
      title: "Preview virtual tag",
      description:
        "Evaluate a virtual tag definition over the trailing 30 days without saving it: spend " +
        "each rule would claim, spend left unmatched, and the top values. Use it before " +
        "create_virtual_tag or update_virtual_tag to check a rule does what the user meant.\n\n" +
        RULES_HELP,
      inputSchema: virtualTagInputSchema.shape,
      risk: "read",
      permission: "costs:read",
      handler: async (input, auth) => {
        const denied = await denyUnlessPermitted(auth, "costs:read");
        if (denied) return denied;
        const parsed = virtualTagInputSchema.safeParse(input);
        if (!parsed.success) return err(`Invalid virtual tag: ${parsed.error.message}`);
        try {
          return ok(await previewVirtualTag(auth.organizationId, parsed.data));
        } catch (e) {
          return toolError(e);
        }
      },
    },

    {
      name: "create_virtual_tag",
      title: "Create virtual tag",
      description:
        "Create a virtual tag. The `key` is immutable afterwards (saved filters, budgets and " +
        "reports store it) and must be unique. Processing over stored history is queued at " +
        "once; queries use the rules immediately. Audit-logged.\n\n" +
        RULES_HELP,
      inputSchema: virtualTagInputSchema.shape,
      risk: "write",
      permission: "costs:write",
      handler: async (input, auth) => {
        const denied = await denyUnlessPermitted(auth, "costs:write");
        if (denied) return denied;
        const parsed = virtualTagInputSchema.safeParse(input);
        if (!parsed.success) return err(`Invalid virtual tag: ${parsed.error.message}`);
        try {
          const tag = await createVirtualTag(auth.organizationId, parsed.data, auth.userId);
          void logAudit({
            organizationId: auth.organizationId,
            userId: auth.userId,
            action: "virtual_tag.create",
            entityType: "virtual_tag",
            entityId: tag.id,
            metadata: { key: tag.key, name: tag.name, rules: tag.rules, source: auth.source },
          });
          return ok(tag);
        } catch (e) {
          return toolError(e);
        }
      },
    },

    {
      name: "update_virtual_tag",
      title: "Update virtual tag",
      description:
        "Replace a virtual tag's name, description, default value and the whole ordered rule " +
        "list (send every rule, in the order they should evaluate; reorder by reordering the " +
        "array). The key must stay the same. Re-queues processing. Audit-logged.",
      inputSchema: { virtualTagId: z.string(), ...virtualTagInputSchema.shape },
      risk: "write",
      permission: "costs:write",
      handler: async (input, auth) => {
        const denied = await denyUnlessPermitted(auth, "costs:write");
        if (denied) return denied;
        const { virtualTagId, ...rest } = input as { virtualTagId: string } & Record<
          string,
          unknown
        >;
        const parsed = virtualTagInputSchema.safeParse(rest);
        if (!parsed.success) return err(`Invalid virtual tag: ${parsed.error.message}`);
        try {
          const tag = await updateVirtualTag(auth.organizationId, virtualTagId, parsed.data);
          if (!tag) return err(`Virtual tag not found: ${virtualTagId}`);
          void logAudit({
            organizationId: auth.organizationId,
            userId: auth.userId,
            action: "virtual_tag.update",
            entityType: "virtual_tag",
            entityId: tag.id,
            metadata: { key: tag.key, name: tag.name, rules: tag.rules, source: auth.source },
          });
          return ok(tag);
        } catch (e) {
          return toolError(e);
        }
      },
    },

    {
      name: "delete_virtual_tag",
      title: "Delete virtual tag",
      description:
        "Delete a virtual tag. Refused, naming them, while any saved filter, budget, report, " +
        "dashboard card, change alert, allocation rule, cost export or business metric still " +
        "references its key. Audit-logged. The chat surface confirms with the user first.",
      inputSchema: { virtualTagId: z.string() },
      risk: "destructive",
      permission: "costs:write",
      handler: async (input, auth) => {
        const denied = await denyUnlessPermitted(auth, "costs:write");
        if (denied) return denied;
        const id = input["virtualTagId"] as string;
        try {
          const deleted = await deleteVirtualTag(auth.organizationId, id);
          if (!deleted) return err(`Virtual tag not found: ${id}`);
          void logAudit({
            organizationId: auth.organizationId,
            userId: auth.userId,
            action: "virtual_tag.delete",
            entityType: "virtual_tag",
            entityId: id,
            metadata: { source: auth.source },
          });
          return ok({ ok: true });
        } catch (e) {
          return toolError(e);
        }
      },
    },
  ];
}
