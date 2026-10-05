/**
 * Anomaly feedback tools: give a detected anomaly a verdict, review the
 * suppressions verdicts created, and read how often alerts turn out to be real.
 * Same permissions as the HTTP routes (`costs:read` to read, `costs:write` to
 * judge), and the same service functions, so an agent's verdict is
 * indistinguishable from a person's in the record, apart from the audit
 * entry's `source`.
 */
import { z } from "zod";
import {
  COST_ANOMALY_FEEDBACK_LIMITS,
  COST_ANOMALY_FEEDBACK_REASONS,
  COST_ANOMALY_RECURRENCES,
  COST_ANOMALY_VERDICTS,
  type CostAnomalyFeedbackInput,
} from "@infrawrench/client-core";
import {
  CostAnomalyFeedbackError,
  getCostAnomalyPrecision,
  getCostAnomalySensitivity,
  listCostAnomalySuppressions,
  submitCostAnomalyFeedback,
} from "../services/cost-anomaly-feedback";
import { CostAnomalyAcknowledgeError } from "../services/cost-anomalies";
import { logAudit } from "../services/audit";
import { denyUnlessPermitted } from "./permissions";
import { ok, err, type ToolDefinition } from "./types";

export function costAnomalyFeedbackTools(): ToolDefinition[] {
  return [
    {
      name: "give_cost_anomaly_feedback",
      title: "Mark a cost anomaly expected or unexpected",
      description:
        "Tell anomaly detection whether a finding (an id from list_cost_anomalies) was " +
        "`expected` (planned or known: a launch, a migration, a seasonal peak, a price change) or " +
        "`unexpected` (a real problem). This tunes detection, so **only give a verdict you have " +
        "evidence for**: repeated `expected` verdicts on a provider or service raise its spike " +
        "threshold, and an `expected` verdict with `recurrence` creates a suppression so the same " +
        "pattern stops alerting until it expires. `unexpected` keeps sensitivity where it is.\n\n" +
        "`recurrence` (only with `expected`): `one_off` (default lifetime 7 days), `weekly` (the " +
        "same weekday, 90 days), `monthly` (the same day of the month, 180 days), `seasonal` (the " +
        "same date each year, 730 days). Omit it to record the verdict without suppressing " +
        "anything. Set `explain` with a `note` to also publish the note on every chart covering " +
        "the day, exactly as acknowledge_cost_anomaly does. Calling again replaces the verdict. " +
        "Audit-logged.",
      inputSchema: {
        anomalyId: z.string().describe("From list_cost_anomalies."),
        verdict: z.enum(COST_ANOMALY_VERDICTS),
        reason: z.enum(COST_ANOMALY_FEEDBACK_REASONS).optional(),
        note: z.string().max(COST_ANOMALY_FEEDBACK_LIMITS.noteMaxLength).optional(),
        explain: z.boolean().optional(),
        recurrence: z.enum(COST_ANOMALY_RECURRENCES).optional(),
        expiresOn: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional()
          .describe("Last day the suppression covers, YYYY-MM-DD. Defaults by recurrence."),
      },
      risk: "write",
      permission: "costs:write",
      handler: async (input, auth) => {
        const denied = await denyUnlessPermitted(auth, "costs:write");
        if (denied) return denied;
        const i = input as {
          anomalyId: string;
          verdict: CostAnomalyFeedbackInput["verdict"];
          reason?: CostAnomalyFeedbackInput["reason"];
          note?: string;
          explain?: boolean;
          recurrence?: (typeof COST_ANOMALY_RECURRENCES)[number];
          expiresOn?: string;
        };
        if (i.recurrence && i.verdict !== "expected") {
          return err("Only an expected anomaly can create a suppression; drop `recurrence`.");
        }
        const feedback: CostAnomalyFeedbackInput = {
          verdict: i.verdict,
          ...(i.reason ? { reason: i.reason } : {}),
          ...(i.note ? { note: i.note } : {}),
          ...(i.explain ? { explain: true } : {}),
          ...(i.recurrence
            ? {
                suppress: {
                  recurrence: i.recurrence,
                  ...(i.expiresOn ? { expiresOn: i.expiresOn } : {}),
                },
              }
            : {}),
        };
        try {
          const result = await submitCostAnomalyFeedback(
            auth.organizationId,
            i.anomalyId,
            feedback,
            auth.userId,
          );
          if (!result) return err(`Cost anomaly not found: ${i.anomalyId}`);
          void logAudit({
            organizationId: auth.organizationId,
            userId: auth.userId,
            action: "cost_anomaly.feedback",
            entityType: "cost_anomaly",
            entityId: result.anomaly.id,
            metadata: {
              day: result.anomaly.day,
              dimension: result.anomaly.dimension,
              dimensionKey: result.anomaly.dimensionKey,
              verdict: i.verdict,
              reason: i.reason ?? null,
              suppressionId: result.suppression?.id ?? null,
              source: auth.source,
            },
          });
          return ok(result);
        } catch (e) {
          if (e instanceof CostAnomalyFeedbackError || e instanceof CostAnomalyAcknowledgeError) {
            return err(e.message);
          }
          throw e;
        }
      },
    },

    {
      name: "list_cost_anomaly_suppressions",
      title: "List cost anomaly suppressions",
      description:
        "Every suppression of the organization: what scope it covers (provider, service, " +
        "account, tag or cost centre), how it repeats, when it expires, why, who made it, and " +
        "how many findings it has suppressed. Also returns the per-key sensitivity feedback has " +
        "learned, so you can explain why a key alerts less than it used to.",
      inputSchema: {},
      risk: "read",
      permission: "costs:read",
      handler: async (_input, auth) => {
        const denied = await denyUnlessPermitted(auth, "costs:read");
        if (denied) return denied;
        const [suppressions, sensitivity] = await Promise.all([
          listCostAnomalySuppressions(auth.organizationId),
          getCostAnomalySensitivity(auth.organizationId),
        ]);
        return ok({ suppressions, sensitivity });
      },
    },

    {
      name: "get_cost_anomaly_precision",
      title: "Get anomaly detection precision",
      description:
        "Per month: anomalies detected, suppressed, marked expected and marked unexpected, and " +
        "precision (the share of reviewed anomalies that were real problems), plus verdict " +
        "counts by reason. Low precision with many `expected` verdicts is the cue to suggest a " +
        "suppression or a higher sensitivity threshold.",
      inputSchema: {
        months: z
          .number()
          .int()
          .min(1)
          .max(COST_ANOMALY_FEEDBACK_LIMITS.precisionMaxMonths)
          .optional()
          .describe("Months to cover, 1-24. Defaults to 6."),
      },
      risk: "read",
      permission: "costs:read",
      handler: async (input, auth) => {
        const denied = await denyUnlessPermitted(auth, "costs:read");
        if (denied) return denied;
        const months =
          (input["months"] as number | undefined) ??
          COST_ANOMALY_FEEDBACK_LIMITS.precisionDefaultMonths;
        return ok(await getCostAnomalyPrecision(auth.organizationId, months));
      },
    },
  ];
}
