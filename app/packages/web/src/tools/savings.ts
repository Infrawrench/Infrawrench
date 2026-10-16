/**
 * Realized savings tools: the MCP/chat view of what optimization actually
 * saved, plus logging a saving that happened somewhere Infrawrench could not
 * see. Same permission split as the HTTP routes: the report is `costs:read`,
 * logging is `costs:write`.
 */
import { z } from "zod";
import { savingsEventInputSchema } from "@infrawrench/ui/cost/config";
import {
  createManualSavingsEvent,
  SavingsEventError,
} from "@infrawrench/server-core/savings/events";
import {
  getRealizedSavingsReport,
  RealizedSavingsRangeError,
} from "@infrawrench/server-core/savings/realized";

import {
  SAVINGS_FINDING_KINDS,
  SAVINGS_FINDING_STATUS_FILTERS,
  matchesSavingsFindingFilter,
  matchesSavingsFindingStatus,
  sortSavingsFindings,
} from "@infrawrench/client-core";
import { hasPermission } from "@infrawrench/server-core/permissions/catalog";

import { logAudit } from "../services/audit";
import { listSavingsFindings } from "../services/savings-findings";
import { denyUnlessPermitted, effectiveToolPermissions } from "./permissions";
import { err, ok, type ToolDefinition } from "./types";

/** Events returned to a model: the newest, so a long history cannot flood its context. */
const MAX_TOOL_EVENTS = 100;
/** Findings returned to a model, largest saving first. */
const MAX_TOOL_FINDINGS = 200;

export function savingsTools(): ToolDefinition[] {
  return [
    {
      name: "list_savings_findings",
      title: "List savings findings",
      description:
        "Every savings finding (orphaned or idle resources, oversized resources to right-size, " +
        "versions past standard support paying an extended support surcharge, unused SaaS " +
        "seats) with its workflow status (`ready` for review, `in_progress`, `completed`, " +
        "`archived`), who changed it and the note, the date it was first detected, and the " +
        "monthly saving. Also returns summary tiles: open potential per month, realized savings " +
        "over the last 30 days and the savings rate. Findings a scan stops reporting are " +
        "completed automatically (`resolution: resolved`). Purely a read; at most 200 findings, " +
        "largest saving first.",
      inputSchema: {
        status: z
          .enum(SAVINGS_FINDING_STATUS_FILTERS)
          .optional()
          .describe("`open` (default: ready or in progress), one status, or `all`."),
        kind: z.enum(SAVINGS_FINDING_KINDS).optional().describe("Only one finder's findings."),
        minMonthlySavings: z
          .number()
          .min(0)
          .optional()
          .describe("Only findings saving at least this much per month (own currency)."),
      },
      risk: "read",
      permission: "resources:read",
      handler: async (input, auth) => {
        const {
          status = "open",
          kind,
          minMonthlySavings,
        } = input as {
          status?: (typeof SAVINGS_FINDING_STATUS_FILTERS)[number];
          kind?: (typeof SAVINGS_FINDING_KINDS)[number];
          minMonthlySavings?: number;
        };
        const permissions = await effectiveToolPermissions(auth);
        const response = await listSavingsFindings(auth.organizationId, {
          canReadCosts: hasPermission(permissions, "costs:read"),
        });
        const filter = {
          ...(kind ? { kinds: [kind] } : {}),
          ...(minMonthlySavings ? { minMonthlySavings } : {}),
        };
        const findings = sortSavingsFindings(
          response.findings.filter(
            (f) => matchesSavingsFindingStatus(f, status) && matchesSavingsFindingFilter(f, filter),
          ),
        );
        return ok({
          ...response,
          findings: findings.slice(0, MAX_TOOL_FINDINGS),
          findingsTruncated: findings.length > MAX_TOOL_FINDINGS,
        });
      },
    },
    {
      name: "get_realized_savings",
      title: "Get realized savings",
      description:
        "What the optimization actions taken actually saved, measured against each resource's " +
        "own spend before the action: right-sizing resizes (made in Infrawrench or detected on " +
        "sync), orphan deletions, sleep schedules, commitment discounts, and manually logged " +
        "savings. Returns per-currency totals of realized vs projected, breakdowns by month, " +
        "action type, cost centre and account, and each action with its basis (`billing` when " +
        "measured from cost rows, `estimate` from list prices, `manual`, or `unmeasured`), " +
        "status, and a `shortfall` when realized falls under the projection or spend grew back. " +
        "Defaults to the last 12 months. Purely a read.",
      inputSchema: {
        from: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional()
          .describe("Inclusive first day (YYYY-MM-DD). Defaults to 12 calendar months back."),
        to: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional()
          .describe("Inclusive last day (YYYY-MM-DD). Defaults to yesterday."),
      },
      risk: "read",
      permission: "costs:read",
      handler: async (input, auth) => {
        const { from, to } = input as { from?: string; to?: string };
        try {
          const report = await getRealizedSavingsReport(auth.organizationId, { from, to });
          return ok({
            ...report,
            events: report.events.slice(0, MAX_TOOL_EVENTS),
            eventsTruncated: report.events.length > MAX_TOOL_EVENTS,
          });
        } catch (e) {
          if (e instanceof RealizedSavingsRangeError) return err(e.message);
          throw e;
        }
      },
    },
    {
      name: "log_saving",
      title: "Log a realized saving",
      description:
        "Record a saving made outside what Infrawrench observes (a renegotiated contract, a " +
        "vendor cancelled, a workload moved), with the monthly amount it saves and the day it " +
        "began. Optionally link a resource id: the realized figure is then measured from that " +
        "resource's billing instead of the logged amount. It accrues daily up to the org's " +
        "horizon (or `horizonMonths`), and leaves a note on cost charts at its start date. " +
        "Audit-logged.",
      inputSchema: savingsEventInputSchema.shape,
      risk: "write",
      permission: "costs:write",
      handler: async (input, auth) => {
        const denied = await denyUnlessPermitted(auth, "costs:write");
        if (denied) return denied;
        const parsed = savingsEventInputSchema.safeParse(input);
        if (!parsed.success) return err(`Invalid saving: ${parsed.error.message}`);
        try {
          const created = await createManualSavingsEvent(
            auth.organizationId,
            parsed.data,
            auth.userId ?? null,
          );
          void logAudit({
            organizationId: auth.organizationId,
            userId: auth.userId,
            action: "savings_event.create",
            entityType: "savings_event",
            entityId: created.id,
            metadata: { kind: created.kind, occurredOn: created.occurredOn, source: auth.source },
          });
          return ok(created);
        } catch (e) {
          if (e instanceof SavingsEventError) return err(e.message);
          throw e;
        }
      },
    },
  ];
}
