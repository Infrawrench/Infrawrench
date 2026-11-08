// `infrawrench jit`: just-in-time access to cloud roles.
//
// Its own command rather than more `access` subcommands: `infrawrench access`
// is break-glass (Infrawrench's own permissions) and has shipped. Folding a
// second feature in would leave `access list` and `access` answering two
// different questions, the `declared-incidents` precedent.
//
//   jit [list] [--mine] [--holding] [--status <s>]   the queue and live grants
//   jit policies                                     what you may request
//   jit request --policy <p> --role <r> [--scope <s>] --for 2h --reason "…" [--ticket]
//   jit approve|deny <id> [--note "…"]
//   jit cancel <id>      jit extend <id> --by 30m      jit revoke <id>
//
// The response schemas are checked against `@infrawrench/client-core` by
// `wire`, so a server-side change breaks the CLI's build rather than its
// output, and the CLI still takes no runtime dependency.
import { Effect, Option, Schema } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import type {
  JitAccessRequest,
  JitPolicy,
  JitPrincipalResolution,
} from "@infrawrench/client-core" with { "resolution-mode": "import" };
import { CloudApi, currentOrg, decodeBody } from "../effect/cloud-api";
import { CliFailure, CliUsageError } from "../effect/errors";
import * as Print from "../effect/print";
import { CliSession } from "../effect/session";
import { reason, status } from "../effect/triage-flags";
import { knownOr, Unrecognized, wire } from "../effect/wire";
import { c, safe, type Column } from "../output";

const REQUESTS_PATH = "/jit-access/requests";
const POLICIES_PATH = "/jit-access/policies";

/** Header the server records as where a decision came from. */
const VIA = { "x-infrawrench-client": "cli" };

const Request = wire<JitAccessRequest>()(
  Schema.Struct({
    id: Schema.String,
    userName: Schema.NullOr(Schema.String),
    roleName: Schema.String,
    scopeName: Schema.String,
    accountName: Schema.NullOr(Schema.String),
    principalName: Schema.String,
    durationMinutes: Schema.Finite,
    extendedMinutes: Schema.Finite,
    status: knownOr([
      "pending",
      "timed_out",
      "denied",
      "cancelled",
      "granting",
      "active",
      "grant_failed",
      "revoking",
      "revoked",
      "revoke_failed",
    ]),
    preexisting: Schema.Boolean,
    revokeAttempts: Schema.Finite,
    endReason: Schema.NullOr(Schema.String),
    requestExpiresAt: Schema.String,
    grantExpiresAt: Schema.NullOr(Schema.String),
    reason: Schema.String,
    lastError: Schema.NullOr(Schema.String),
  }),
);
type Request = typeof Request.Type;
const Requests = wire<JitAccessRequest[]>()(Schema.Array(Request));

const Policies = wire<JitPolicy[]>()(
  Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      enabled: Schema.Boolean,
      accountId: Schema.String,
      accountName: Schema.NullOr(Schema.String),
      maxDurationMinutes: Schema.Finite,
      canRequest: Schema.optional(Schema.Boolean),
      targets: Schema.Array(
        Schema.Struct({
          scopeId: Schema.String,
          scopeName: Schema.String,
          roleId: Schema.String,
          roleName: Schema.String,
        }),
      ),
    }),
  ),
);

const Principal = wire<JitPrincipalResolution>()(
  Schema.Struct({
    principal: Schema.NullOr(Schema.Unknown),
    labels: Schema.Struct({ principalLabel: Schema.String }),
  }),
);

/** "45m" / "2h": kept local so the CLI pulls nothing UI-shaped. */
function duration(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return "—";
  if (minutes < 60) return `${Math.round(minutes)}m`;
  const hours = minutes / 60;
  return Number.isInteger(hours) ? `${hours}h` : `${hours.toFixed(1)}h`;
}

/** `90`, `90m`, `2h`, `1.5h` → minutes; throws the sentence that refuses anything else. */
export function parseDurationMinutes(text: string, flag: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*(m|min|h|hr)?$/i.exec(text.trim());
  if (!m) throw new Error(`${flag} must look like 30m or 2h, got "${text}"`);
  const value = Number(m[1]);
  const minutes = /^h/i.test(m[2] ?? "") ? value * 60 : value;
  if (!Number.isInteger(minutes) || minutes < 1) {
    throw new Error(`${flag} must be a whole number of minutes, got "${text}"`);
  }
  return minutes;
}

/** {@link parseDurationMinutes}, its refusal a usage error. */
const minutesOf = (text: string, flag: string) =>
  Effect.try({
    try: () => parseDurationMinutes(text, flag),
    catch: (e) => new CliUsageError({ message: e instanceof Error ? e.message : String(e) }),
  });

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

function statusCell(r: Request): string {
  if (r.status instanceof Unrecognized) return c.dim(safe(r.status.raw));
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
const findRequest = Effect.fnUntraced(function* (orgId: string, ref: Option.Option<string>) {
  const api = yield* CloudApi;
  if (Option.isNone(ref) || !ref.value) {
    return yield* new CliUsageError({ message: "Give the request id (from `infrawrench jit`)." });
  }
  const wanted = ref.value;
  const all = yield* api.decode(Requests, orgId, REQUESTS_PATH);
  const matches = all.filter((r) => r.id === wanted || r.id.startsWith(wanted));
  const [only] = matches;
  if (only === undefined)
    return yield* new CliFailure({ message: `No request matches "${wanted}".` });
  if (matches.length > 1) {
    return yield* new CliFailure({
      message: `"${wanted}" matches ${matches.length} requests; give more of the id.`,
    });
  }
  return only;
});

function pick<T extends { id: string; name: string }>(
  items: ReadonlyArray<T>,
  ref: string,
  what: string,
): Effect.Effect<T, CliFailure> {
  const lower = ref.toLowerCase();
  const exact = items.filter((i) => i.id === ref || i.name.toLowerCase() === lower);
  if (exact.length === 1 && exact[0]) return Effect.succeed(exact[0]);
  const fuzzy = items.filter((i) => i.name.toLowerCase().includes(lower));
  if (fuzzy.length === 1 && fuzzy[0]) return Effect.succeed(fuzzy[0]);
  return Effect.fail(
    new CliFailure({
      message:
        exact.length + fuzzy.length === 0
          ? `No ${what} matches "${ref}".`
          : `"${ref}" matches several ${what}s: ${fuzzy.map((i) => i.name).join(", ")}. Be more specific.`,
    }),
  );
}

const printRequests = (requests: ReadonlyArray<Request>) => {
  const columns: Column<Request>[] = [
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
  return Print.table(requests, columns);
};

const listFlags = {
  mine: Flag.Boolean("mine").pipe(
    Flag.withDescription("Only your own requests"),
    Flag.withDefault(false),
    Flag.withoutNegation,
  ),
  holding: Flag.Boolean("holding").pipe(
    Flag.withDescription("Only grants in force now"),
    Flag.withDefault(false),
    Flag.withoutNegation,
  ),
  status: status({
    metavar: "pending|active|revoke_failed|…",
    description: "Only requests in this state",
  }),
};

const listRequests = Effect.fn("jit.list")(function* (input: {
  readonly mine: boolean;
  readonly holding: boolean;
  readonly status: Option.Option<string>;
}) {
  const session = yield* CliSession;
  const api = yield* CloudApi;
  const org = yield* currentOrg;
  const params = new URLSearchParams();
  if (Option.isSome(input.status) && input.status.value) params.set("status", input.status.value);
  if (input.mine) params.set("mine", "1");
  if (input.holding) params.set("holding", "1");
  const qs = params.toString();
  const path = `${REQUESTS_PATH}${qs ? `?${qs}` : ""}`;
  const body = yield* api.json(org.id, path);
  if (session.output === "json") return yield* Print.json({ org: org.id, requests: body });
  const requests = yield* decodeBody(Requests, path)(body);
  if (requests.length === 0) {
    return yield* Print.line(
      c.dim("No just-in-time access requests. Ask for one with `infrawrench jit request`."),
    );
  }
  const active = requests.filter((r) => r.status === "active").length;
  const waiting = requests.filter((r) => r.status === "pending").length;
  const failing = requests.filter((r) => r.status === "revoke_failed").length;
  yield* Print.line(
    `${c.bold(org.displayName)} ${c.dim(`· ${active} active, ${waiting} waiting`)}` +
      (failing ? ` ${c.red(`· ${failing} failed to revoke`)}` : ""),
  );
  yield* Print.line();
  yield* printRequests(requests);
});

const list = Command.make("list", listFlags, listRequests).pipe(
  Command.withDescription("The queue and live grants"),
);

const policies = Command.make(
  "policies",
  {},
  Effect.fn("jit.policies")(function* () {
    const session = yield* CliSession;
    const api = yield* CloudApi;
    const org = yield* currentOrg;
    const body = yield* api.json(org.id, POLICIES_PATH);
    if (session.output === "json") return yield* Print.json({ org: org.id, policies: body });
    const rows = yield* decodeBody(Policies, POLICIES_PATH)(body);
    if (rows.length === 0) {
      return yield* Print.line(
        c.dim("No policies yet. An admin adds them in Settings → Just-in-time Access."),
      );
    }
    for (const p of rows) {
      yield* Print.line(
        `${c.bold(safe(p.name))} ${c.dim(`· ${safe(p.accountName ?? p.accountId)} · up to ${duration(p.maxDurationMinutes)}`)}` +
          (p.canRequest ? "" : ` ${c.dim("(you cannot request under this one)")}`) +
          (p.enabled ? "" : ` ${c.dim("(off)")}`),
      );
      for (const t of p.targets) {
        yield* Print.line(`  ${safe(t.roleName)} ${c.dim(`on ${safe(t.scopeName)}`)}`);
      }
    }
  }),
).pipe(Command.withDescription("The policies you can request under, and what each offers"));

const REQUEST_USAGE =
  'Usage: infrawrench jit request --policy <name> --role <name> [--scope <name>] --for 2h --reason "…" [--ticket <ref>]';

const text = (name: string, metavar: string, description: string) =>
  Flag.String(name).pipe(
    Flag.withMetavar(metavar),
    Flag.withDescription(description),
    Flag.optional,
  );

const request = Command.make(
  "request",
  {
    policy: text("policy", "name", "The policy to request under"),
    role: text("role", "name", "The role, by name or id"),
    scope: text("scope", "name", "Where the role applies, when the policy offers it in several"),
    for: text("for", "duration", "How long: 30m, 2h, 1.5h"),
    reason: reason({ description: "Why you need it (approvers see it)" }),
    ticket: text("ticket", "ref", "A ticket or incident reference"),
  },
  Effect.fn("jit.request")(function* (input) {
    const session = yield* CliSession;
    const api = yield* CloudApi;
    const org = yield* currentOrg;
    const get = Option.getOrUndefined;
    const wantedPolicy = get(input.policy);
    const role = get(input.role);
    const forText = get(input.for);
    const why = get(input.reason);
    if (!wantedPolicy || !role || !forText || !why) {
      return yield* new CliUsageError({ message: REQUEST_USAGE });
    }
    const scope = get(input.scope);
    const ticket = get(input.ticket);
    const offered = (yield* api.decode(Policies, org.id, POLICIES_PATH)).filter(
      (p) => p.canRequest,
    );
    const policy = yield* pick(offered, wantedPolicy, "policy");
    const targets = policy.targets.filter(
      (t) =>
        (t.roleId === role || t.roleName.toLowerCase().includes(role.toLowerCase())) &&
        (!scope || t.scopeId === scope || t.scopeName.toLowerCase().includes(scope.toLowerCase())),
    );
    const [target] = targets;
    if (target === undefined || targets.length !== 1) {
      return yield* new CliFailure({
        message:
          targets.length === 0
            ? `No role in "${policy.name}" matches. It offers: ${policy.targets.map((t) => `${t.roleName} on ${t.scopeName}`).join("; ")}`
            : `Several roles match; add --scope. Matches: ${targets.map((t) => `${t.roleName} on ${t.scopeName}`).join("; ")}`,
      });
    }
    const resolution = yield* api.decode(
      Principal,
      org.id,
      `${POLICIES_PATH}/${encodeURIComponent(policy.id)}/principal`,
    );
    if (!resolution.principal) {
      return yield* new CliFailure({
        message: `No ${resolution.labels.principalLabel} matches your email address. Request this from the app, where you can pick yourself from the provider's list.`,
      });
    }
    const durationMinutes = yield* minutesOf(forText, "--for");
    const body = yield* api.json(org.id, REQUESTS_PATH, {
      method: "POST",
      headers: VIA,
      body: JSON.stringify({
        policyId: policy.id,
        scopeId: target.scopeId,
        roleId: target.roleId,
        durationMinutes,
        reason: why,
        ...(ticket ? { ticket } : {}),
      }),
    });
    if (session.output === "json") return yield* Print.json({ org: org.id, request: body });
    const created = yield* decodeBody(Request, REQUESTS_PATH)(body);
    yield* Print.line(
      `${c.green("Requested")} ${safe(created.roleName)} on ${safe(created.scopeName)} for ${duration(created.durationMinutes)} ` +
        c.dim(
          `(${created.id.slice(0, 8)}, granted to ${safe(created.principalName)}). Approvers have been notified.`,
        ),
    );
  }),
).pipe(Command.withDescription("Ask for a role, for a while, with a reason"));

const requestId = Argument.String("id").pipe(
  Argument.withDescription("The request, by id or its first characters (from `infrawrench jit`)"),
  Argument.optional,
);

/** POST one of the request's own actions and print what it became. */
const act = Effect.fnUntraced(function* (
  verb: "approve" | "deny" | "cancel" | "revoke" | "extend",
  id: Option.Option<string>,
  body: (request: Request) => Effect.Effect<Record<string, unknown>, CliUsageError>,
) {
  const session = yield* CliSession;
  const api = yield* CloudApi;
  const org = yield* currentOrg;
  const request = yield* findRequest(org.id, id);
  const path = `${REQUESTS_PATH}/${encodeURIComponent(request.id)}/${verb}`;
  const sent = yield* body(request);
  const answer = yield* api.json(org.id, path, {
    method: "POST",
    headers: VIA,
    body: JSON.stringify(sent),
  });
  if (session.output === "json") return yield* Print.json({ org: org.id, request: answer });
  const updated = yield* decodeBody(Request, path)(answer);
  yield* Print.line(
    `${safe(updated.roleName)} on ${safe(updated.scopeName)} for ${safe(updated.userName ?? "a member")}: ${statusCell(updated)}` +
      (updated.grantExpiresAt && updated.status === "active"
        ? c.dim(` until ${new Date(updated.grantExpiresAt).toLocaleString()}`)
        : "") +
      (updated.lastError ? `\n${c.red(safe(updated.lastError))}` : ""),
  );
});

const decision = (verb: "approve" | "deny", description: string) =>
  Command.make(
    verb,
    { id: requestId, note: text("note", "text", "A note kept with the decision") },
    Effect.fn(`jit.${verb}`)(function* (input) {
      const note = Option.getOrUndefined(input.note);
      yield* act(verb, input.id, () => Effect.succeed(note ? { note } : {}));
    }),
  ).pipe(Command.withDescription(description));

const plain = (verb: "cancel" | "revoke", description: string) =>
  Command.make(
    verb,
    { id: requestId },
    Effect.fn(`jit.${verb}`)(function* (input) {
      yield* act(verb, input.id, () => Effect.succeed({}));
    }),
  ).pipe(Command.withDescription(description));

const extend = Command.make(
  "extend",
  { id: requestId, by: text("by", "duration", "How much longer: 30m, 1h") },
  Effect.fn("jit.extend")(function* (input) {
    yield* act("extend", input.id, () =>
      Option.match(input.by, {
        onNone: () =>
          Effect.fail(
            new CliUsageError({ message: "Usage: infrawrench jit extend <id> --by 30m" }),
          ),
        onSome: (by) =>
          by
            ? minutesOf(by, "--by").pipe(Effect.map((minutes) => ({ minutes })))
            : Effect.fail(
                new CliUsageError({ message: "Usage: infrawrench jit extend <id> --by 30m" }),
              ),
      }),
    );
  }),
).pipe(Command.withDescription("Lengthen an active grant, within the policy maximum"));

export const jit = Command.make("jit", listFlags, listRequests).pipe(
  Command.withDescription(
    "Just-in-time access to cloud roles: the queue, live grants and failed revokes",
  ),
  Command.withSubcommands([
    list,
    policies,
    request,
    decision("approve", "Approve a request (you must be one of its approvers)"),
    decision("deny", "Deny a request (you must be one of its approvers)"),
    plain("cancel", "Withdraw your pending request"),
    extend,
    plain("revoke", "End a grant now and remove it from the provider"),
  ]),
);
