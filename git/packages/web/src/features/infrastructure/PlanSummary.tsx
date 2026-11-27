/**
 * How a Terraform run reads: its status, what its plan would do (the counts
 * and each resource's action) and what that changes on the monthly bill. The
 * branch page shows the same pieces.
 */
import { Badge, type BadgeTone } from "../../components/Badge";
import { Table, Td, Th, Tr } from "../../components/Panel";
import { CiStatusIcon, type CiGlyphStatus } from "../../components/StatusIcons";
import { formatMoney, formatMoneyDelta } from "../../lib/amounts";
import type {
  TerraformAction,
  TerraformCostDelta,
  TerraformPlanSummary,
  TerraformRun,
  TerraformRunStatus,
  TimelineItem,
} from "@infrawrench/git-contract";

const STATUS: Record<TerraformRunStatus, { label: string; glyph: CiGlyphStatus; tone: BadgeTone }> =
  {
    queued: { label: "Queued", glyph: "queued", tone: "neutral" },
    planning: { label: "Planning", glyph: "running", tone: "warning" },
    planned: { label: "Planned", glyph: "passed", tone: "success" },
    no_changes: { label: "No changes", glyph: "passed", tone: "neutral" },
    awaiting_approval: { label: "Awaiting approval", glyph: "awaiting_approval", tone: "warning" },
    applying: { label: "Applying", glyph: "running", tone: "warning" },
    applied: { label: "Applied", glyph: "passed", tone: "success" },
    errored: { label: "Errored", glyph: "failed", tone: "danger" },
    cancelled: { label: "Cancelled", glyph: "cancelled", tone: "neutral" },
    discarded: { label: "Discarded", glyph: "skipped", tone: "neutral" },
    skipped: { label: "Skipped", glyph: "skipped", tone: "neutral" },
  };

export const terraformStatusLabel = (status: TerraformRunStatus): string => STATUS[status].label;

export function TerraformStatusIcon({
  status,
  size,
}: {
  status: TerraformRunStatus;
  size?: number;
}) {
  return <CiStatusIcon status={STATUS[status].glyph} {...(size === undefined ? {} : { size })} />;
}

export function TerraformStatusBadge({ status }: { status: TerraformRunStatus }) {
  return <Badge tone={STATUS[status].tone}>{STATUS[status].label}</Badge>;
}

const OPERATION = { plan: "Plan", apply: "Apply", destroy: "Destroy" } as const;
const TRIGGER = {
  branch: "branch",
  merge: "merge",
  manual: "manual",
  drift: "drift check",
} as const;

export const operationLabel = (run: Pick<TerraformRun, "operation">): string =>
  OPERATION[run.operation];
export const triggerLabel = (run: Pick<TerraformRun, "trigger">): string => TRIGGER[run.trigger];

type TerraformRunEvent = Extract<TimelineItem, { type: "terraform_run" }>;

/**
 * A branch page's timeline entry for a run, as a sentence after the
 * workspace's name: Terraform's own counts for a plan, the reason for a
 * failure or for a run that was never started.
 */
export function terraformEventSentence(
  event: Pick<TerraformRunEvent, "operation" | "outcome" | "add" | "change" | "destroy" | "reason">,
): { readonly text: string; readonly tone: "success" | "danger" | "neutral" } {
  const counts =
    event.add !== null && event.change !== null && event.destroy !== null
      ? `${event.add} to add, ${event.change} to change, ${event.destroy} to destroy`
      : null;
  const why = event.reason !== null && event.reason !== "" ? `: ${event.reason}` : "";
  switch (event.outcome) {
    case "planned":
      return { text: counts === null ? "planned" : `planned: ${counts}`, tone: "success" };
    case "no_changes":
      return { text: "planned: no changes", tone: "neutral" };
    case "applied":
      return { text: counts === null ? "applied" : `applied: ${counts}`, tone: "success" };
    case "failed":
      return { text: `${event.operation} failed${why}`, tone: "danger" };
    case "skipped":
      return { text: `${event.operation} skipped${why}`, tone: "neutral" };
  }
}

/** `+2 ~1 -0`, as Terraform's own last line counts them, with the words for a screen reader. */
export function PlanCounts({ plan }: { plan: TerraformPlanSummary }) {
  if (!plan.hasChanges) return <span className="text-xs text-on-surface-muted">No changes</span>;
  return (
    <span className="inline-flex items-center gap-2 whitespace-nowrap font-mono text-[11px]">
      <span className="text-success">
        <span aria-hidden="true">+{plan.add}</span>
        <span className="sr-only">{plan.add} to add</span>
      </span>
      <span className="text-warning">
        <span aria-hidden="true">~{plan.change}</span>
        <span className="sr-only">{plan.change} to change</span>
      </span>
      <span className="text-danger">
        <span aria-hidden="true">-{plan.destroy}</span>
        <span className="sr-only">{plan.destroy} to destroy</span>
      </span>
    </span>
  );
}

/** `2 to add, 1 to change, 0 to destroy`. */
export function planSentence(plan: TerraformPlanSummary): string {
  if (!plan.hasChanges) return "No changes";
  const parts = [`${plan.add} to add`, `${plan.change} to change`, `${plan.destroy} to destroy`];
  if (plan.replace > 0) parts.push(`${plan.replace} replaced`);
  if (plan.import > 0) parts.push(`${plan.import} to import`);
  return parts.join(", ");
}

const ACTION: Record<TerraformAction, { label: string; mark: string; tone: string }> = {
  create: { label: "Create", mark: "+", tone: "text-success" },
  update: { label: "Update", mark: "~", tone: "text-warning" },
  delete: { label: "Destroy", mark: "-", tone: "text-danger" },
  replace: { label: "Replace", mark: "-/+", tone: "text-danger" },
  read: { label: "Read", mark: "<=", tone: "text-on-surface-muted" },
  "no-op": { label: "No change", mark: "", tone: "text-on-surface-muted" },
  forget: { label: "Forget", mark: ".", tone: "text-on-surface-muted" },
};

export function ActionLabel({ action }: { action: TerraformAction }) {
  const { label, mark, tone } = ACTION[action];
  return (
    <span className={`inline-flex items-center gap-1.5 whitespace-nowrap ${tone}`}>
      <span aria-hidden="true" className="w-5 text-center font-mono">
        {mark}
      </span>
      {label}
    </span>
  );
}

export function ResourceChanges({ plan }: { plan: TerraformPlanSummary }) {
  if (plan.resourceChanges.length === 0) return null;
  return (
    <div className="overflow-x-auto">
      <Table caption="Resource changes">
        <thead>
          <tr>
            <Th>Action</Th>
            <Th>Resource</Th>
            <Th>Changes</Th>
          </tr>
        </thead>
        <tbody>
          {plan.resourceChanges.map((change) => (
            <Tr key={`${change.address}:${change.action}`}>
              <Td className="w-px">
                <ActionLabel action={change.action} />
              </Td>
              <Td className="font-mono text-on-surface">{change.address}</Td>
              <Td className="text-on-surface-muted">
                {change.changedAttributes.length === 0 ? null : (
                  <span className="font-mono">{change.changedAttributes.join(", ")}</span>
                )}
              </Td>
            </Tr>
          ))}
        </tbody>
      </Table>
      {plan.resourceChangesTruncated ? (
        <p className="border-t border-border px-3 py-1.5 text-xs text-on-surface-muted">
          More resources change than are listed
        </p>
      ) : null}
    </div>
  );
}

/** A plan's change to the monthly bill, signed and coloured by direction. */
export function CostDelta({ cost }: { cost: TerraformCostDelta }) {
  const tone = cost.monthlyDelta > 0 ? "text-danger" : cost.monthlyDelta < 0 ? "text-success" : "";
  return (
    <span className={`whitespace-nowrap font-mono text-[11px] ${tone}`}>
      {formatMoneyDelta(cost.monthlyDelta, cost.currency)}
      <span className="font-sans text-on-surface-muted"> / month</span>
    </span>
  );
}

export function CostLines({ cost }: { cost: TerraformCostDelta }) {
  const amount = (value: number | null) =>
    value === null ? "" : formatMoney(value, cost.currency);
  return (
    <div className="overflow-x-auto">
      <Table caption="Monthly cost by resource">
        <thead>
          <tr>
            <Th>Resource</Th>
            <Th className="text-right">Before</Th>
            <Th className="text-right">After</Th>
            <Th className="text-right">Change</Th>
          </tr>
        </thead>
        <tbody>
          {cost.lines.map((line) => (
            <Tr key={line.address}>
              <Td className="font-mono text-on-surface">{line.address}</Td>
              <Td className="text-right font-mono">{amount(line.monthlyBefore)}</Td>
              <Td className="text-right font-mono">{amount(line.monthlyAfter)}</Td>
              <Td
                className={`text-right font-mono ${
                  line.monthlyDelta > 0
                    ? "text-danger"
                    : line.monthlyDelta < 0
                      ? "text-success"
                      : ""
                }`}
              >
                {formatMoneyDelta(line.monthlyDelta, cost.currency)}
              </Td>
            </Tr>
          ))}
          <tr className="border-t border-border bg-surface-inset font-medium">
            <Td>Total</Td>
            <Td className="text-right font-mono">{amount(cost.monthlyBefore)}</Td>
            <Td className="text-right font-mono">{amount(cost.monthlyAfter)}</Td>
            <Td className="text-right font-mono">
              {formatMoneyDelta(cost.monthlyDelta, cost.currency)}
            </Td>
          </tr>
        </tbody>
      </Table>
      {cost.unpriced > 0 ? (
        <p className="border-t border-border px-3 py-1.5 text-xs text-on-surface-muted">
          {cost.unpriced} changed {cost.unpriced === 1 ? "resource has" : "resources have"} no price
          and {cost.unpriced === 1 ? "is" : "are"} left out
        </p>
      ) : null}
    </div>
  );
}
