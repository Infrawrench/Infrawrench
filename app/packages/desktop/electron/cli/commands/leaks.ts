// `infrawrench leaks`: leaked credentials. Secrets a scanner plugin (GitHub
// secret scanning, GitLab secret detection) found committed to code,
// attributed to the account or stored secret they belong to, and closed by
// rotating them.
//
//   infrawrench leaks [list]             open leaks (--status, --account), scanners, counts
//   infrawrench leaks scan               scan every scanner account now
//   infrawrench leaks rotate <id>        reissue, or replace from stdin (--value-stdin)
//   infrawrench leaks mark-rotated <id>  record a rotation done at the provider
//   infrawrench leaks dismiss <id>       accept it   --reason <r> [--comment <c>]
//   infrawrench leaks reopen <id>        undo a dismissal or a manual rotation
//
// Cloud only: scanning and matching run on the server, against the scanner
// accounts the organization connected. The CLI never sees a leaked value,
// only the masked hint the server keeps, and a replacement value is read from
// stdin rather than argv so it never lands in shell history.
//
// The response schemas are checked against `@infrawrench/client-core` by
// `wire`, so a server-side change breaks the CLI's build rather than its
// output; the labels and derivations it prints live in `../format`.
import { Effect, Option, Schema } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import type { LeakedSecret, LeakedSecretListResponse } from "@infrawrench/client-core" with {
  "resolution-mode": "import",
};
import { listCloudAccounts, resolveAccount } from "../context";
import { CloudApi, currentOrg, decodeBody } from "../effect/cloud-api";
import { CliExit, CliFailure, CliUsageError } from "../effect/errors";
import * as Print from "../effect/print";
import { CliSession } from "../effect/session";
import { reasonOf, statusOf } from "../effect/triage-flags";
import { spreadBody, wire } from "../effect/wire";
import {
  formatChangeTime,
  formatLeakCounts,
  formatLeakLocation,
  formatLeakScanner,
  formatLeakSeverity,
  formatLeakStatus,
  formatLeakTarget,
  leakRotateRefusal,
  matchIdPrefix,
  parseLeakDismissReason,
  parseLeakStatusFlag,
  shortId,
} from "../format";
import { c, safe, type Column } from "../output";

const PATH = "/leaked-secrets";

const Leak = wire<LeakedSecret>()(
  Schema.Struct({
    id: Schema.String,
    // The enums read as text: the labels fall back to a newer server's word.
    status: Schema.String,
    scannerAccountName: Schema.String,
    tokenTypeLabel: Schema.String,
    ownerPluginName: Schema.NullOr(Schema.String),
    secretHint: Schema.NullOr(Schema.String),
    repository: Schema.NullOr(Schema.String),
    path: Schema.NullOr(Schema.String),
    line: Schema.NullOr(Schema.Finite),
    upstreamResolution: Schema.NullOr(Schema.String),
    validity: Schema.NullOr(Schema.String),
    detectedAt: Schema.String,
    matchKind: Schema.String,
    matchConfidence: Schema.String,
    matchedAccountId: Schema.NullOr(Schema.String),
    matchedAccountName: Schema.NullOr(Schema.String),
    matchedResourceId: Schema.NullOr(Schema.String),
    matchedResourceName: Schema.NullOr(Schema.String),
    candidateAccountIds: Schema.Array(Schema.String),
    rotation: Schema.Struct({ mode: Schema.String, manageUrl: Schema.NullOr(Schema.String) }),
    rotatedBy: Schema.NullOr(Schema.String),
    rotationMethod: Schema.NullOr(Schema.String),
    dismissedReason: Schema.NullOr(Schema.String),
    upstreamResolvedAt: Schema.NullOr(Schema.String),
    upstreamResolveError: Schema.NullOr(Schema.String),
  }),
);
type Leak = typeof Leak.Type;

const Listing = wire<LeakedSecretListResponse>()(
  Schema.Struct({
    leaks: Schema.Array(Leak),
    counts: Schema.Record(Schema.String, Schema.Finite),
    scanners: Schema.Array(
      Schema.Struct({
        accountName: Schema.String,
        label: Schema.String,
        returnsSecretValue: Schema.Boolean,
        lastScannedAt: Schema.NullOr(Schema.String),
        lastError: Schema.NullOr(Schema.String),
        lastCount: Schema.NullOr(Schema.Finite),
        lastPartial: Schema.optional(Schema.Boolean),
      }),
    ),
  }),
);

/** An action's answer: the leak as it now stands, kept raw for `--json`. */
const ActionEnvelope = Schema.Struct({ leak: Schema.Unknown });

const Scan = Schema.Struct({
  scanned: Schema.Finite,
  newLeaks: Schema.Finite,
  errors: Schema.Finite,
});

const requireCloud = Effect.gen(function* () {
  const session = yield* CliSession;
  if (session.local) {
    return yield* new CliUsageError({
      message:
        "Leaked credentials live in Infrawrench Cloud: scanning runs on the server against the organization's GitHub and GitLab accounts. Drop --local.",
    });
  }
});

/** Resolve an id or a unique prefix of one (the listing prints {@link shortId}). */
const findLeak = Effect.fnUntraced(function* (
  orgId: string,
  arg: Option.Option<string>,
  verb: string,
) {
  const api = yield* CloudApi;
  if (Option.isNone(arg) || !arg.value) {
    return yield* new CliUsageError({
      message: `Usage: infrawrench leaks ${verb} <id>\nIds are printed by \`infrawrench leaks --status all\`.`,
    });
  }
  const wanted = arg.value;
  const { leaks } = yield* api.decode(Listing, orgId, PATH);
  const found = matchIdPrefix(leaks, wanted);
  if (found.match) return found.match;
  return yield* new CliFailure({
    message:
      found.candidates.length > 1
        ? `"${wanted}" matches ${found.candidates.length} leaks: ${found.candidates
            .map((l) => l.id)
            .join(", ")}. Give more of the id.`
        : `No leaked credential matches "${wanted}". Run \`infrawrench leaks --status all\` to list them.`,
  });
});

/**
 * Read the replacement value from stdin. Piped input is read to EOF; at a
 * terminal the value is typed with echo off (raw mode), so it is never shown
 * on screen either. Surrounding whitespace is dropped: a trailing newline
 * from `echo` or a paste is never part of a secret. `null` is Ctrl-C.
 */
async function readSecretFromStdin(): Promise<string | null> {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of stdin) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks).toString("utf8").trim();
  }
  process.stderr.write("New value (input hidden, Enter to finish): ");
  const typed = await new Promise<string | null>((resolve) => {
    let buf = "";
    const wasRaw = stdin.isRaw;
    stdin.setRawMode?.(true);
    stdin.resume();
    const done = (value: string | null): void => {
      stdin.off("data", onData);
      stdin.setRawMode?.(wasRaw ?? false);
      stdin.pause();
      process.stderr.write("\n");
      resolve(value);
    };
    function onData(data: Buffer): void {
      for (const ch of data.toString("utf8")) {
        if (ch === "\u0003") return done(null);
        if (ch === "\r" || ch === "\n" || ch === "\u0004") return done(buf);
        if (ch === "\u007f" || ch === "\b") buf = buf.slice(0, -1);
        else buf += ch;
      }
    }
    stdin.on("data", onData);
  });
  return typed === null ? null : typed.trim();
}

/** {@link readSecretFromStdin}: Ctrl-C is exit 130, nothing typed a usage error. */
const readSecret = Effect.gen(function* () {
  const value = yield* Effect.promise(readSecretFromStdin);
  if (value === null) {
    yield* Print.errLine(c.red("Canceled."));
    return yield* new CliExit({ exitCode: 130 });
  }
  if (!value) {
    return yield* new CliUsageError({ message: "No value on stdin. Nothing was rotated." });
  }
  return value;
});

/** POST one of a leak's actions; prints it (`--json`: `{ org, leak }`) with any scanner failure. */
const act = Effect.fnUntraced(function* (
  orgId: string,
  leak: Leak,
  action: string,
  verb: string,
  body: Record<string, unknown>,
) {
  const session = yield* CliSession;
  const api = yield* CloudApi;
  const path = `${PATH}/${encodeURIComponent(leak.id)}/${action}`;
  const answer = yield* api.decode(ActionEnvelope, orgId, path, {
    method: "POST",
    body: JSON.stringify(body),
  });
  if (session.output === "json") return yield* Print.json({ org: orgId, leak: answer.leak });
  const updated = yield* decodeBody(Leak, path)(answer.leak);
  yield* Print.line(
    `${c.bold(verb)} ${shortId(updated.id)} ${c.dim(
      `· ${safe(updated.tokenTypeLabel)} · ${formatLeakStatus(updated)}`,
    )}`,
  );
  if (updated.upstreamResolvedAt) {
    yield* Print.line(
      c.dim(`Closed on the scanner ${formatChangeTime(updated.upstreamResolvedAt)}.`),
    );
  }
  if (updated.upstreamResolveError) {
    yield* Print.line(
      c.yellow(`Couldn't close it on the scanner: ${safe(updated.upstreamResolveError)}`),
    );
  }
});

const leakId = Argument.String("id").pipe(
  Argument.withDescription(
    "The leak, by id or its first characters (`leaks --status all` lists them)",
  ),
  Argument.optional,
);

const keepUpstreamOpen = Flag.Boolean("keep-upstream-open").pipe(
  Flag.withDescription("Leave the finding open on the scanner"),
  Flag.withDefault(false),
  Flag.withoutNegation,
);

const statusFlag = statusOf({
  metavar: "open|rotated|dismissed|resolved|all",
  description: "Which leaks to list (default: open)",
  parse: (raw) => parseLeakStatusFlag(Option.getOrUndefined(raw)),
});

const SEVERITY_COLOR = { critical: c.red, high: c.yellow } as const;

const listLeaks = Effect.fn("leaks.list")(function* (input: {
  readonly status: ReturnType<typeof parseLeakStatusFlag>;
}) {
  yield* requireCloud;
  const session = yield* CliSession;
  const api = yield* CloudApi;
  const org = yield* currentOrg;
  const { status } = input;
  const wantedAccount = session.account;
  const accountId = wantedAccount
    ? yield* Effect.promise(() => listCloudAccounts(org.id)).pipe(
        Effect.map((accounts) => resolveAccount(accounts, wantedAccount).id),
      )
    : null;
  const params = new URLSearchParams();
  if (status) params.set("status", status);
  if (accountId) params.set("accountId", accountId);
  const qs = params.toString();
  const path = `${PATH}${qs ? `?${qs}` : ""}`;
  const body = yield* api.json(org.id, path);

  if (session.output === "json") {
    return yield* Print.json(yield* spreadBody({ org: org.id }, body, path));
  }
  const response = yield* decodeBody(Listing, path)(body);

  const open = response.counts.open ?? 0;
  yield* Print.line(
    `${c.bold(safe(org.displayName))} ${c.dim("· leaked credentials")}  ${
      open > 0 ? c.red(formatLeakCounts(response.counts)) : c.dim(formatLeakCounts(response.counts))
    }`,
  );
  for (const s of response.scanners) {
    const line = formatLeakScanner(s);
    yield* Print.line(s.lastError ? c.red(line) : s.lastPartial ? c.yellow(line) : c.dim(line));
  }
  yield* Print.line();

  if (response.scanners.length === 0) {
    return yield* Print.line(
      c.dim(
        "No scanner connected. Add a GitHub organization or a GitLab account to start finding credentials committed to code.",
      ),
    );
  }
  if (response.leaks.length === 0) {
    return yield* Print.line(
      c.dim(
        status
          ? `No ${status} leaks${accountId ? " for that account" : ""}. \`--status all\` lists every one.`
          : `No leaks${accountId ? " for that account" : ""}.`,
      ),
    );
  }

  // The server orders open first, newest first within a status; keep it.
  const columns: Column<Leak>[] = [
    { header: "id", value: (l) => c.dim(shortId(l.id)) },
    {
      header: "severity",
      value: (l) => {
        const sev = formatLeakSeverity(l);
        return SEVERITY_COLOR[sev](sev);
      },
    },
    {
      header: "token",
      value: (l) => safe(l.tokenTypeLabel) + (l.secretHint ? c.dim(` ${safe(l.secretHint)}`) : ""),
    },
    {
      header: "location",
      value: (l) => safe(formatLeakLocation(l) || l.scannerAccountName),
    },
    { header: "matched to", value: (l) => formatLeakTarget(l) },
    { header: "detected", value: (l) => c.dim(formatChangeTime(l.detectedAt)) },
    {
      header: "status",
      value: (l) => (l.status === "open" ? c.red(formatLeakStatus(l)) : c.dim(formatLeakStatus(l))),
    },
  ];
  yield* Print.table(response.leaks, columns);

  for (const l of response.leaks.filter((x) => x.upstreamResolveError)) {
    yield* Print.line(
      c.yellow(
        `${shortId(l.id)}: couldn't close it on the scanner: ${safe(l.upstreamResolveError)}`,
      ),
    );
  }

  if (response.leaks.some((l) => l.status === "open")) {
    yield* Print.line();
    yield* Print.line(
      c.dim(
        "Act on one with `leaks rotate <id>`, `leaks mark-rotated <id>` or `leaks dismiss <id> --reason <r>`; `--json` has full ids, finding URLs and each leak's rotation mode.",
      ),
    );
  }
});

const list = Command.make("list", { status: statusFlag }, listLeaks).pipe(
  Command.withDescription("Leaked credentials, the scanners and the counts"),
);

const scan = Command.make(
  "scan",
  {},
  Effect.fn("leaks.scan")(function* () {
    yield* requireCloud;
    const session = yield* CliSession;
    const api = yield* CloudApi;
    const org = yield* currentOrg;
    const path = `${PATH}/scan`;
    const body = yield* api.json(org.id, path, { method: "POST", body: "{}" });
    if (session.output === "json") {
      return yield* Print.json(yield* spreadBody({ org: org.id }, body, path));
    }
    const r = yield* decodeBody(Scan, path)(body);
    if (r.scanned === 0) {
      return yield* Print.line(
        c.dim(
          "No scanner accounts to scan. Connect a GitHub organization or a GitLab account to start finding committed credentials.",
        ),
      );
    }
    const failed = r.errors > 0 ? c.red(`, ${r.errors} failed`) : "";
    yield* Print.line(
      `Scanned ${r.scanned} account${r.scanned === 1 ? "" : "s"}${failed}. New leaks: ${
        r.newLeaks > 0 ? c.red(String(r.newLeaks)) : "0"
      }.`,
    );
    // The failures are in the line above; the exit code is what a script reads.
    if (r.errors > 0) return yield* new CliExit({ exitCode: 1 });
  }),
).pipe(Command.withDescription("Scan every scanner account now"));

const rotate = Command.make(
  "rotate",
  {
    id: leakId,
    valueStdin: Flag.Boolean("value-stdin").pipe(
      Flag.withDescription("Read the replacement value from stdin (hidden at a terminal)"),
      Flag.withDefault(false),
      Flag.withoutNegation,
    ),
    keepUpstreamOpen,
  },
  Effect.fn("leaks.rotate")(function* (input) {
    yield* requireCloud;
    const org = yield* currentOrg;
    const leak = yield* findLeak(org.id, input.id, "rotate");
    const refusal = leakRotateRefusal(leak);
    if (refusal) return yield* new CliFailure({ message: refusal });
    const body: Record<string, unknown> = { resolveUpstream: !input.keepUpstreamOpen };
    if (leak.rotation.mode === "replace") {
      if (!input.valueStdin) {
        return yield* new CliUsageError({
          message:
            "This secret is stored as a literal value, so rotating it means supplying the new one.\n" +
            "Create it at the provider, then pass it on stdin (never as an argument, which lands in shell history):\n" +
            `  infrawrench leaks rotate ${shortId(leak.id)} --value-stdin < new-value.txt`,
        });
      }
      body.value = yield* readSecret;
    } else if (input.valueStdin) {
      return yield* new CliUsageError({
        message:
          "The provider reissues this value itself, so there is nothing to read from stdin. Drop --value-stdin.",
      });
    }
    yield* act(org.id, leak, "rotate", "Rotated", body);
  }),
).pipe(Command.withDescription("Reissue the credential, or replace it from stdin (--value-stdin)"));

const markRotated = Command.make(
  "mark-rotated",
  { id: leakId, keepUpstreamOpen },
  Effect.fn("leaks.mark-rotated")(function* (input) {
    yield* requireCloud;
    const org = yield* currentOrg;
    const leak = yield* findLeak(org.id, input.id, "mark-rotated");
    yield* act(org.id, leak, "mark-rotated", "Marked rotated", {
      resolveUpstream: !input.keepUpstreamOpen,
    });
  }),
).pipe(Command.withDescription("Record a rotation done at the provider"));

const dismiss = Command.make(
  "dismiss",
  {
    id: leakId,
    reason: reasonOf({
      metavar: "false-positive|wont-fix|used-in-tests",
      description: "Why it is accepted",
      parse: (raw) => parseLeakDismissReason(Option.getOrNull(raw)),
    }),
    comment: Flag.String("comment").pipe(
      Flag.withMetavar("text"),
      Flag.withDescription("A note kept with the dismissal"),
      Flag.optional,
    ),
    keepUpstreamOpen,
  },
  Effect.fn("leaks.dismiss")(function* (input) {
    yield* requireCloud;
    const org = yield* currentOrg;
    const leak = yield* findLeak(org.id, input.id, "dismiss");
    const body: Record<string, unknown> = {
      reason: input.reason,
      resolveUpstream: !input.keepUpstreamOpen,
    };
    const comment = Option.getOrUndefined(input.comment)?.trim();
    if (comment) body.comment = comment;
    yield* act(org.id, leak, "dismiss", "Dismissed", body);
  }),
).pipe(
  Command.withDescription("Accept a leak: --reason false-positive, wont-fix or used-in-tests"),
);

const reopen = Command.make(
  "reopen",
  { id: leakId },
  Effect.fn("leaks.reopen")(function* (input) {
    yield* requireCloud;
    const org = yield* currentOrg;
    const leak = yield* findLeak(org.id, input.id, "reopen");
    yield* act(org.id, leak, "reopen", "Reopened", {});
  }),
).pipe(Command.withDescription("Undo a dismissal or a manual rotation"));

export const leaks = Command.make("leaks", { status: statusFlag }, listLeaks).pipe(
  Command.withDescription(
    "Leaked credentials: secrets a scanner found committed to code, matched to what they unlock",
  ),
  Command.withSubcommands([list, scan, rotate, markRotated, dismiss, reopen]),
);
