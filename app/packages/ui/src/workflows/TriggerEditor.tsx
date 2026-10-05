import { useId, useMemo } from "react";
import { T, Var, msg, useGT, useMessages } from "gt-react";

import {
  isValidCronTimezone,
  nextCronOccurrences,
  validateCronExpression,
} from "@infrawrench/client-core";

import type { BudgetIntegration, BudgetOption, GitIntegration, WorkflowTrigger } from "./types.js";

type TriggerKind = WorkflowTrigger["kind"];

const CRON_PRESETS: { label: string; value: string }[] = [
  { label: msg("Every minute"), value: "* * * * *" },
  { label: msg("Every 5 minutes"), value: "*/5 * * * *" },
  { label: msg("Every 15 minutes"), value: "*/15 * * * *" },
  { label: msg("Every 30 minutes"), value: "*/30 * * * *" },
  { label: msg("Hourly"), value: "0 * * * *" },
  { label: msg("Every 6 hours"), value: "0 */6 * * *" },
  { label: msg("Daily at midnight"), value: "0 0 * * *" },
  { label: msg("Daily at 9am"), value: "0 9 * * *" },
  { label: msg("Weekly (Mon 9am)"), value: "0 9 * * 1" },
  { label: msg("Monthly (1st)"), value: "0 0 1 * *" },
];
const pad2 = (n: number) => String(n).padStart(2, "0");
/** Translated weekday name for a cron `dow` field (0 = Sunday, per POSIX cron). */
function cronDayLabel(gt: ReturnType<typeof useGT>, dow: number): string {
  switch (dow % 7) {
    case 0:
      return gt("Sunday");
    case 1:
      return gt("Monday");
    case 2:
      return gt("Tuesday");
    case 3:
      return gt("Wednesday");
    case 4:
      return gt("Thursday");
    case 5:
      return gt("Friday");
    default:
      return gt("Saturday");
  }
}
/** A best-effort plain-English summary of a 5-field cron expression. */
function describeCron(
  expr: string,
  gt: ReturnType<typeof useGT>,
  m: ReturnType<typeof useMessages>,
): string {
  const t = expr.trim();
  const preset = CRON_PRESETS.find((p) => p.value === t);
  if (preset) return gt("Runs {label}.", { label: m(preset.label).toLowerCase() });
  const parts = t.split(/\s+/);
  if (parts.length !== 5) return gt("Enter 5 fields: minute hour day month weekday.");
  const [min, hour, dom, mon, dow] = parts as [string, string, string, string, string];
  const isNum = (s: string) => /^\d+$/.test(s);
  const everyMin = /^\*\/(\d+)$/.exec(min);
  const everyHour = /^\*\/(\d+)$/.exec(hour);
  const allDate = dom === "*" && mon === "*";
  if (everyMin && hour === "*" && allDate && dow === "*")
    return gt("Runs every {n} minutes.", { n: everyMin[1] });
  if (min === "0" && everyHour && allDate && dow === "*")
    return gt("Runs every {n} hours.", { n: everyHour[1] });
  if (isNum(min) && isNum(hour) && allDate && dow === "*")
    return gt("Runs daily at {time}.", { time: `${pad2(+hour)}:${pad2(+min)}` });
  if (isNum(min) && isNum(hour) && allDate && isNum(dow))
    return gt("Runs weekly on {day} at {time}.", {
      day: cronDayLabel(gt, +dow),
      time: `${pad2(+hour)}:${pad2(+min)}`,
    });
  if (isNum(min) && hour === "*" && allDate && dow === "*")
    return gt("Runs hourly at :{min}.", { min: pad2(+min) });
  return gt("Runs on a custom schedule.");
}
/** Default threshold for a new budget trigger: "goes over budget". */
const DEFAULT_BUDGET_PERCENT = 100;
/** Format a budget's monthly limit for the trigger summary line. */
function formatBudgetAmount(amountCents: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      maximumFractionDigits: 0,
    }).format(amountCents / 100);
  } catch {
    return `${(amountCents / 100).toFixed(0)} ${currency}`;
  }
}
export function TriggerEditor({
  trigger,
  gitTriggers = false,
  gitIntegration,
  budgetIntegration,
  onChange,
  hasWebhookSecret = false,
  webhookSecret = null,
  onWebhookSecretChange,
}: {
  trigger: WorkflowTrigger;
  gitTriggers?: boolean;
  gitIntegration?: GitIntegration | undefined;
  budgetIntegration?: BudgetIntegration | undefined;
  onChange: (t: WorkflowTrigger) => void;
  /** A signing secret is already stored (the value itself is never returned). */
  hasWebhookSecret?: boolean;
  /** Pending new secret in this edit session, if the user is typing one. */
  webhookSecret?: string | null;
  onWebhookSecretChange?: (value: string | null) => void;
}) {
  const gt = useGT();
  const kind = trigger.kind;
  const triggerSelectId = useId();
  return (
    <div className="px-3 py-2 border-b border-white/10 flex items-center gap-2 flex-wrap text-xs">
      <label htmlFor={triggerSelectId} className="opacity-60">
        {gt("Trigger")}
      </label>
      <select
        id={triggerSelectId}
        value={kind}
        onChange={(e) => {
          const k = e.target.value as TriggerKind;
          if (k === "manual") onChange({ kind: "manual" });
          else if (k === "cron") onChange({ kind: "cron", expression: "0 * * * *" });
          else if (k === "budget")
            onChange({
              kind: "budget",
              budgetId: budgetIntegration?.budgets[0]?.id ?? "",
              percent: DEFAULT_BUDGET_PERCENT,
              metric: "actual",
            });
          else onChange({ kind: "git", events: ["push"] });
        }}
        className="bg-transparent border border-white/15 rounded px-2 py-1"
      >
        <option value="manual">{gt("Manual")}</option>
        <option value="cron">{gt("Cron")}</option>
        {/* Git triggers need an always-on host to watch the repo: web/proxy only. */}
        {(gitTriggers || kind === "git") && <option value="git">{gt("Git")}</option>}
        {/* Budgets are a cloud feature; the crossing is evaluated server-side. */}
        {(budgetIntegration || kind === "budget") && <option value="budget">{gt("Budget")}</option>}
      </select>
      {trigger.kind === "cron" && <CronTriggerFields trigger={trigger} onChange={onChange} />}
      {trigger.kind === "git" && (
        <div className="flex flex-wrap items-center gap-2">
          {!gitIntegration?.configured ? (
            <span className="opacity-60">{gt("GitHub isn’t configured on this server.")}</span>
          ) : gitIntegration.repos.length === 0 ? (
            <>
              <button
                type="button"
                onClick={gitIntegration.onConnect}
                className="px-2 py-1 rounded bg-white/10 hover:bg-white/20"
              >
                {gt("Connect GitHub")}
              </button>
              <span className="opacity-50">
                {gitIntegration.loading
                  ? gt("Loading…")
                  : gt("Install the app and pick repos to watch.")}
              </span>
            </>
          ) : (
            <>
              <select
                value={trigger.repo ?? ""}
                onChange={(e) => {
                  const repo = gitIntegration.repos.find((r) => r.fullName === e.target.value);
                  onChange(
                    repo
                      ? {
                          kind: "git",
                          provider: "github",
                          repo: repo.fullName,
                          installationId: repo.installationId,
                          branch: trigger.branch || repo.defaultBranch,
                          events: trigger.events ?? ["push"],
                        }
                      : { kind: "git", events: trigger.events ?? ["push"] },
                  );
                }}
                className="bg-transparent border border-white/15 rounded px-2 py-1 max-w-56"
                aria-label={gt("Repository")}
              >
                <option value="">{gt("Select a repo…")}</option>
                {gitIntegration.repos.map((r) => (
                  <option key={`${r.installationId}:${r.fullName}`} value={r.fullName}>
                    {r.fullName}
                  </option>
                ))}
              </select>
              <input
                value={trigger.branch ?? ""}
                onChange={(e) => onChange({ ...trigger, branch: e.target.value })}
                placeholder={gt("branch")}
                className="bg-transparent border border-white/15 rounded px-2 py-1 w-28 font-mono"
                aria-label={gt("Branch")}
              />
              <button
                type="button"
                onClick={gitIntegration.onConnect}
                title={gt("Add or remove repositories on GitHub")}
                className="opacity-60 hover:opacity-100 px-1.5 py-1 rounded hover:bg-white/10"
              >
                {gt("+ repos")}
              </button>
              <span className="opacity-50">{gt("Runs on each new commit to the branch.")}</span>
            </>
          )}
          <WebhookSecretField
            hasWebhookSecret={hasWebhookSecret}
            webhookSecret={webhookSecret}
            onChange={onWebhookSecretChange}
          />
        </div>
      )}
      {trigger.kind === "budget" && (
        <BudgetTriggerFields
          trigger={trigger}
          budgets={budgetIntegration?.budgets ?? []}
          loading={budgetIntegration?.loading ?? false}
          onChange={onChange}
        />
      )}
      {kind === "manual" && <span className="opacity-50">{gt("infra.prompt() available")}</span>}
    </div>
  );
}
/**
 * Cron-trigger controls: preset picker, raw 5-field expression, optional IANA
 * timezone, and a live preview of the next few run times. The preview is
 * computed by the same shared cron engine the schedulers (cloud poller,
 * desktop cron runner) fire from, so what it shows is what will happen.
 */
function CronTriggerFields({
  trigger,
  onChange,
}: {
  trigger: Extract<WorkflowTrigger, { kind: "cron" }>;
  onChange: (t: WorkflowTrigger) => void;
}) {
  const gt = useGT();
  const m = useMessages();
  const expression = trigger.expression;
  const timezone = trigger.timezone?.trim() ?? "";

  const cronError = useMemo(() => validateCronExpression(expression), [expression]);
  const timezoneError = useMemo(
    () =>
      timezone && !isValidCronTimezone(timezone)
        ? gt('Unknown timezone "{timezone}"', { timezone })
        : null,
    [timezone, gt],
  );

  const nextRuns = useMemo(() => {
    if (cronError || timezoneError) return [];
    try {
      return nextCronOccurrences(expression, 3, timezone ? { timezone } : {});
    } catch {
      return [];
    }
  }, [expression, timezone, cronError, timezoneError]);

  const formatRun = useMemo(() => {
    try {
      // Show run times in the zone the schedule is evaluated in (UTC when
      // unset): a "daily at 09:00" cron previews as 09:00, not the viewer's
      // local rendering of it.
      const dtf = new Intl.DateTimeFormat(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        timeZone: timezone || "UTC",
      });
      return (d: Date) => dtf.format(d);
    } catch {
      return (d: Date) => d.toISOString();
    }
  }, [timezone]);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <select
        value={
          CRON_PRESETS.some((p) => p.value === expression.trim()) ? expression.trim() : "custom"
        }
        onChange={(e) => {
          if (e.target.value !== "custom") onChange({ ...trigger, expression: e.target.value });
        }}
        className="bg-transparent border border-white/15 rounded px-2 py-1"
        aria-label={gt("Schedule preset")}
      >
        {CRON_PRESETS.map((p) => (
          <option key={p.value} value={p.value}>
            {m(p.label)}
          </option>
        ))}
        <option value="custom">{gt("Custom…")}</option>
      </select>
      <div className="flex flex-col items-center leading-none">
        <input
          value={expression}
          onChange={(e) => onChange({ ...trigger, expression: e.target.value })}
          placeholder="* * * * *"
          spellCheck={false}
          aria-label={gt("Cron expression")}
          className="bg-surface-overlay border border-white/15 rounded px-2 py-1 font-mono w-36 text-center tracking-[0.3em]"
        />
        <span className="mt-0.5 text-[9px] text-on-surface-faint tracking-tight">
          {gt("min")}
          &nbsp;&nbsp;
          {gt("hour")}
          &nbsp;&nbsp;
          {gt("day")}
          &nbsp;&nbsp;
          {gt("mon")}
          &nbsp;&nbsp;
          {gt("wkday")}
        </span>
      </div>
      <input
        value={trigger.timezone ?? ""}
        onChange={(e) => {
          const tz = e.target.value;
          // Keep the property absent (not "") when cleared, matching storage.
          const { timezone: _drop, ...rest } = trigger;
          onChange(tz ? { ...rest, timezone: tz } : rest);
        }}
        placeholder="UTC"
        spellCheck={false}
        aria-label={gt("Timezone (IANA name, defaults to UTC)")}
        title={gt("IANA timezone the schedule runs in, e.g. Europe/London. Leave empty for UTC.")}
        className="bg-transparent border border-white/15 rounded px-2 py-1 w-32 font-mono"
      />
      {cronError || timezoneError ? (
        <span className="text-[11px] text-danger">{cronError ?? timezoneError}</span>
      ) : (
        <span className="text-[11px] text-info/80" title={expression}>
          {describeCron(expression, gt, m)}
          {nextRuns.length > 0 && (
            <>
              {" "}
              {gt("Next:")} {nextRuns.map(formatRun).join(" · ")}
              {gt(" ({zone})", { zone: timezone || "UTC" })}
            </>
          )}
          {nextRuns.length === 0 && gt(" This schedule never matches a run time.")}
        </span>
      )}
    </div>
  );
}
/**
 * Budget-trigger controls: which budget, at what percentage of its monthly
 * amount, measured against month-to-date spend or the month-end forecast. The
 * crossing fires at most once per calendar month (editing any of these three
 * re-arms it), and the workflow receives the details as `infra.event`.
 */
function BudgetTriggerFields({
  trigger,
  budgets,
  loading,
  onChange,
}: {
  trigger: Extract<WorkflowTrigger, { kind: "budget" }>;
  budgets: BudgetOption[];
  loading: boolean;
  onChange: (t: WorkflowTrigger) => void;
}) {
  const gt = useGT();
  const percent = trigger.percent ?? DEFAULT_BUDGET_PERCENT;
  const metric = trigger.metric ?? "actual";
  const selected = budgets.find((b) => b.id === trigger.budgetId);

  if (budgets.length === 0) {
    return (
      <span className="opacity-60">
        {loading ? gt("Loading budgets…") : gt("No budgets yet. Create one on a dashboard first.")}
      </span>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <select
        value={trigger.budgetId}
        onChange={(e) => onChange({ ...trigger, budgetId: e.target.value })}
        className="bg-transparent border border-white/15 rounded px-2 py-1 max-w-56"
        aria-label={gt("Budget")}
      >
        <option value="">{gt("Select a budget…")}</option>
        {budgets.map((b) => (
          <option key={b.id} value={b.id}>
            {b.name}
          </option>
        ))}
      </select>
      <span className="opacity-60">{gt("goes over")}</span>
      <input
        type="number"
        min={1}
        value={percent}
        onChange={(e) => {
          const next = Number(e.target.value);
          onChange({ ...trigger, percent: next > 0 ? next : DEFAULT_BUDGET_PERCENT });
        }}
        className="bg-surface-overlay border border-white/15 rounded px-2 py-1 w-16 text-right font-mono"
        aria-label={gt("Budget threshold percent")}
      />
      <span className="opacity-60">{gt("% of")}</span>
      <select
        value={metric}
        onChange={(e) =>
          onChange({ ...trigger, metric: e.target.value === "forecast" ? "forecast" : "actual" })
        }
        className="bg-transparent border border-white/15 rounded px-2 py-1"
        aria-label={gt("Budget measure")}
      >
        <option value="actual">{gt("spend so far")}</option>
        <option value="forecast">{gt("forecast spend")}</option>
      </select>
      {selected && (
        <T>
          <span className="text-[11px] text-info/80">
            Runs once a month, when{" "}
            <Var>{metric === "actual" ? gt("spend") : gt("the month-end forecast")}</Var> reaches{" "}
            <Var>
              {formatBudgetAmount(
                Math.round((selected.amountCents * percent) / 100),
                selected.currency,
              )}
            </Var>{" "}
            of <Var>{formatBudgetAmount(selected.amountCents, selected.currency)}</Var>.
          </span>
        </T>
      )}
    </div>
  );
}
/**
 * Signing secret for a git webhook. Write-only: once saved the server only
 * reports that one exists, so the field shows a "Configured" state with the
 * option to replace or remove it rather than echoing the value back.
 */
function WebhookSecretField({
  hasWebhookSecret,
  webhookSecret,
  onChange,
}: {
  hasWebhookSecret: boolean;
  webhookSecret: string | null;
  onChange?: ((value: string | null) => void) | undefined;
}) {
  const gt = useGT();
  const fieldId = useId();
  if (!onChange) return null;

  // Configured, and the user hasn't started replacing it this session.
  if (hasWebhookSecret && webhookSecret === null) {
    return (
      <span className="flex items-center gap-1.5">
        <span className="text-success/80" title={gt("Deliveries must carry a valid signature")}>
          {gt("Signed ✓")}
        </span>
        <button
          type="button"
          onClick={() => onChange("")}
          className="opacity-60 hover:opacity-100 px-1.5 py-1 rounded hover:bg-white/10"
        >
          {gt("Replace")}
        </button>
      </span>
    );
  }

  return (
    <span className="flex items-center gap-1.5">
      <label htmlFor={fieldId} className="opacity-60">
        {gt("Signing secret")}
      </label>
      <input
        id={fieldId}
        type="password"
        value={webhookSecret ?? ""}
        onChange={(e) => onChange(e.target.value)}
        placeholder={gt("optional, but recommended")}
        autoComplete="off"
        spellCheck={false}
        className="bg-surface-overlay border border-white/15 rounded px-2 py-1 w-44 font-mono"
      />
      {hasWebhookSecret && (
        <button
          type="button"
          onClick={() => onChange(null)}
          className="opacity-60 hover:opacity-100 px-1.5 py-1 rounded hover:bg-white/10"
        >
          {gt("Cancel")}
        </button>
      )}
    </span>
  );
}
