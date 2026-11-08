import { CliError, orgFetch, resolveOrg, type CliContext } from "../context";
import type {
  JitAccessRequest,
  JitPolicy,
  JitPrincipalResolution,
} from "@infrawrench/client-core" with {
  "resolution-mode": "import",
};
import { c, printJson, println, printTable, safe, type Column } from "../output";

/** `jit` flags, as raw strings the command validates. */
export interface JitFlags {
  policy?: string | undefined;
  role?: string | undefined;
  scope?: string | undefined;
  /** `--for 2h`: the window asked for. */
  duration?: string | undefined;
  /** `--by 30m`: how much to extend. */
  by?: string | undefined;
  ticket?: string | undefined;
  note?: string | undefined;
  status?: string | undefined;
  mine: boolean;
  holding: boolean;
}

/** Header the server records as where a decision came from. */
const VIA = { "x-infrawrench-client": "cli" };

/** "45m" / "2h": kept local so the CLI pulls nothing UI-shaped. */
function duration(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return "—";
  if (minutes < 60) return `${Math.round(minutes)}m`;
  const hours = minutes / 60;
  return Number.isInteger(hours) ? `${hours}h` : `${hours.toFixed(1)}h`;
}

/** `90`, `90m`, `2h`, `1.5h` → minutes. */
export function parseDurationMinutes(text: string, flag: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*(m|min|h|hr)?$/i.exec(text.trim());
  if (!m) throw new CliError(`${flag} must look like 30m or 2h, got "${text}"`, 2);
  const value = Number(m[1]);
  const minutes = /^h/i.test(m[2] ?? "") ? value * 60 : value;
  if (!Number.isInteger(minutes) || minutes < 1) {
    throw new CliError(`${flag} must be a whole number of minutes, got "${text}"`, 2);
  }
  return minutes;
}

function countdown(at: string | null): string {
  if (!at) return c.dim("—");
  const ms = Date.parse(at) - Date.now();
  if (Number.isNaN(ms)) return c.dim("—");
  const abs = Math.abs(ms);
  const label =
    abs >= 86_400_000
      ? `${Math.round(abs / 86_400_000)}d`
      : abs >= 3_600_000
        ? `${Math.round(abs / 3_600_000)}h`
        : `${Math.max(1, Math.round(abs / 60_000))}m`;
  return ms >= 0 ? `in ${label}` : c.dim(`${label} ago`);
}

function statusCell(r: JitAccessRequest): string {
  switch (r.status) {
    case "pending":
      return c.cyan("waiting");
    case "active":
      return r.preexisting ? c.dim("already held") : c.yellow("ACTIVE");
    case "granting":
      return c.yellow("granting");
    case "revoking":
      return c.yellow("revoking");
    case "revoke_failed":
      return c.red(`REVOKE FAILED ×${r.revokeAttempts}`);
    case "grant_failed":
      return c.red("grant failed");
    case "revoked":
      return c.dim(r.endReason === "revoked" ? "ended early" : "ended");
    case "denied":
      return c.red("denied");
    case "cancelled":
      return c.dim("cancelled");
    case "timed_out":
      return c.dim("timed out");
  }
}

/** A request named by id, or by an unambiguous id prefix (ids are long). */
async function findRequest(orgId: string, ref: string | undefined): Promise<JitAccessRequest> {
  if (!ref) throw new CliError("Give the request id (from `infrawrench jit`).", 2);
  const all = await orgFetch<JitAccessRequest[]>(orgId, "/jit-access/requests");
  const matches = all.filter((r) => r.id === ref || r.id.startsWith(ref));
  if (matches.length === 0) throw new CliError(`No request matches "${ref}".`);
  if (matches.length > 1)
    throw new CliError(`"${ref}" matches ${matches.length} requests; give more of the id.`);
  return matches[0]!;
}

function pick<T extends { id: string; name: string }>(items: T[], ref: string, what: string): T {
  const lower = ref.toLowerCase();
  const exact = items.filter((i) => i.id === ref || i.name.toLowerCase() === lower);
  if (exact.length === 1) return exact[0]!;
  const fuzzy = items.filter((i) => i.name.toLowerCase().includes(lower));
  if (fuzzy.length === 1) return fuzzy[0]!;
  if (exact.length + fuzzy.length === 0) throw new CliError(`No ${what} matches "${ref}".`);
  throw new CliError(
    `"${ref}" matches several ${what}s: ${fuzzy.map((i) => i.name).join(", ")}. Be more specific.`,
  );
}

function printRequests(requests: JitAccessRequest[]): void {
  const columns: Column<JitAccessRequest>[] = [
    { header: "id", value: (r) => c.dim(r.id.slice(0, 8)) },
    { header: "who", value: (r) => safe(r.userName) || c.dim("unknown") },
    { header: "role", value: (r) => safe(r.roleName) },
    {
      header: "where",
      value: (r) => safe(`${r.scopeName}${r.accountName ? ` (${r.accountName})` : ""}`),
    },
    { header: "for", value: (r) => duration(r.durationMinutes + r.extendedMinutes) },
    { header: "status", value: (r) => statusCell(r) },
    {
      header: "clock",
      value: (r) =>
        countdown(
          r.status === "pending"
            ? r.requestExpiresAt
            : r.status === "active" || r.status === "granting"
              ? r.grantExpiresAt
              : null,
        ),
    },
    { header: "reason", value: (r) => c.dim(safe(r.reason)) },
  ];
  printTable(requests, columns);
}

/**
 * `infrawrench jit`: just-in-time access to cloud roles.
 *
 * Its own command rather than more `access` subcommands: `infrawrench access`
 * is break-glass (Infrawrench's own permissions) and has shipped. Folding a
 * second feature in would leave `access list` and `access` answering two
 * different questions, the `declared-incidents` precedent.
 *
 *   jit [list] [--mine] [--holding] [--status <s>]   the queue and live grants
 *   jit policies                                     what you may request
 *   jit request --policy <p> --role <r> [--scope <s>] --for 2h --reason "…" [--ticket]
 *   jit approve|deny <id> [--note "…"]
 *   jit cancel <id>      jit extend <id> --by 30m      jit revoke <id>
 */
export async function cmdJit(ctx: CliContext, rest: string[], flags: JitFlags): Promise<void> {
  const org = await resolveOrg(ctx);
  const sub = rest[0] ?? "list";
  const json = ctx.flags.output === "json";

  if (sub === "list") {
    const params = new URLSearchParams();
    if (flags.status) params.set("status", flags.status);
    if (flags.mine) params.set("mine", "1");
    if (flags.holding) params.set("holding", "1");
    const qs = params.toString();
    const requests = await orgFetch<JitAccessRequest[]>(
      org.id,
      `/jit-access/requests${qs ? `?${qs}` : ""}`,
    );
    if (json) {
      printJson({ org: org.id, requests });
      return;
    }
    if (requests.length === 0) {
      println(
        c.dim("No just-in-time access requests. Ask for one with `infrawrench jit request`."),
      );
      return;
    }
    const active = requests.filter((r) => r.status === "active").length;
    const waiting = requests.filter((r) => r.status === "pending").length;
    const failing = requests.filter((r) => r.status === "revoke_failed").length;
    println(
      `${c.bold(org.displayName)} ${c.dim(`· ${active} active, ${waiting} waiting`)}` +
        (failing ? ` ${c.red(`· ${failing} failed to revoke`)}` : ""),
    );
    println();
    printRequests(requests);
    return;
  }

  if (sub === "policies") {
    const policies = await orgFetch<JitPolicy[]>(org.id, "/jit-access/policies");
    if (json) {
      printJson({ org: org.id, policies });
      return;
    }
    if (policies.length === 0) {
      println(c.dim("No policies yet. An admin adds them in Settings → Just-in-time Access."));
      return;
    }
    for (const p of policies) {
      println(
        `${c.bold(safe(p.name))} ${c.dim(`· ${safe(p.accountName ?? p.accountId)} · up to ${duration(p.maxDurationMinutes)}`)}` +
          (p.canRequest ? "" : ` ${c.dim("(you cannot request under this one)")}`) +
          (p.enabled ? "" : ` ${c.dim("(off)")}`),
      );
      for (const t of p.targets)
        println(`  ${safe(t.roleName)} ${c.dim(`on ${safe(t.scopeName)}`)}`);
    }
    return;
  }

  if (sub === "request") {
    if (!flags.policy || !flags.role || !flags.duration || !ctx.flags.reason) {
      throw new CliError(
        'Usage: infrawrench jit request --policy <name> --role <name> [--scope <name>] --for 2h --reason "…" [--ticket <ref>]',
        2,
      );
    }
    const policies = (await orgFetch<JitPolicy[]>(org.id, "/jit-access/policies")).filter(
      (p) => p.canRequest,
    );
    const policy = pick(policies, flags.policy, "policy");
    const targets = policy.targets.filter(
      (t) =>
        (t.roleId === flags.role || t.roleName.toLowerCase().includes(flags.role!.toLowerCase())) &&
        (!flags.scope ||
          t.scopeId === flags.scope ||
          t.scopeName.toLowerCase().includes(flags.scope.toLowerCase())),
    );
    if (targets.length !== 1) {
      throw new CliError(
        targets.length === 0
          ? `No role in "${policy.name}" matches. It offers: ${policy.targets.map((t) => `${t.roleName} on ${t.scopeName}`).join("; ")}`
          : `Several roles match; add --scope. Matches: ${targets.map((t) => `${t.roleName} on ${t.scopeName}`).join("; ")}`,
      );
    }
    const target = targets[0]!;
    const resolution = await orgFetch<JitPrincipalResolution>(
      org.id,
      `/jit-access/policies/${encodeURIComponent(policy.id)}/principal`,
    );
    if (!resolution.principal) {
      throw new CliError(
        `No ${resolution.labels.principalLabel} matches your email address. Request this from the app, where you can pick yourself from the provider's list.`,
      );
    }
    const created = await orgFetch<JitAccessRequest>(org.id, "/jit-access/requests", {
      method: "POST",
      headers: VIA,
      body: JSON.stringify({
        policyId: policy.id,
        scopeId: target.scopeId,
        roleId: target.roleId,
        durationMinutes: parseDurationMinutes(flags.duration, "--for"),
        reason: ctx.flags.reason,
        ...(flags.ticket ? { ticket: flags.ticket } : {}),
      }),
    });
    if (json) {
      printJson({ org: org.id, request: created });
      return;
    }
    println(
      `${c.green("Requested")} ${safe(created.roleName)} on ${safe(created.scopeName)} for ${duration(created.durationMinutes)} ` +
        c.dim(
          `(${created.id.slice(0, 8)}, granted to ${safe(created.principalName)}). Approvers have been notified.`,
        ),
    );
    return;
  }

  if (["approve", "deny", "cancel", "revoke", "extend"].includes(sub)) {
    const request = await findRequest(org.id, rest[1]);
    const path = `/jit-access/requests/${encodeURIComponent(request.id)}/${sub}`;
    let body: Record<string, unknown> = {};
    if (sub === "extend") {
      if (!flags.by) throw new CliError("Usage: infrawrench jit extend <id> --by 30m", 2);
      body = { minutes: parseDurationMinutes(flags.by, "--by") };
    } else if ((sub === "approve" || sub === "deny") && flags.note) {
      body = { note: flags.note };
    }
    const updated = await orgFetch<JitAccessRequest>(org.id, path, {
      method: "POST",
      headers: VIA,
      body: JSON.stringify(body),
    });
    if (json) {
      printJson({ org: org.id, request: updated });
      return;
    }
    println(
      `${safe(updated.roleName)} on ${safe(updated.scopeName)} for ${safe(updated.userName ?? "a member")}: ${statusCell(updated)}` +
        (updated.grantExpiresAt && updated.status === "active"
          ? c.dim(` until ${new Date(updated.grantExpiresAt).toLocaleString()}`)
          : "") +
        (updated.lastError ? `\n${c.red(safe(updated.lastError))}` : ""),
    );
    return;
  }

  throw new CliError(
    `Unknown subcommand "${sub}". Try: jit, jit policies, jit request, jit approve|deny|cancel|extend|revoke <id>`,
  );
}
