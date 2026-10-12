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
// Type-only imports from client-core, so the CLI still takes no runtime
// dependency; the labels and derivations it prints live in `../format`.
import {
  CliError,
  listCloudAccounts,
  orgFetch,
  resolveAccount,
  resolveOrg,
  type CliContext,
  type OrgInfo,
} from "../context";
import type { LeakFlags } from "../args";
import type {
  LeakedSecret,
  LeakedSecretListResponse,
  LeakedSecretScanner,
} from "@infrawrench/client-core" with { "resolution-mode": "import" };
import { c, printJson, println, printTable, safe, type Column } from "../output";
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

const USAGE =
  "Usage: infrawrench leaks [list|scan|rotate <id>|mark-rotated <id>|dismiss <id>|reopen <id>]";

function requireCloud(ctx: CliContext): void {
  if (ctx.flags.local) {
    throw new CliError(
      "Leaked credentials live in Infrawrench Cloud: scanning runs on the server against the organization's GitHub and GitLab accounts. Drop --local.",
      2,
    );
  }
}

/** A pure helper's validation error, as a usage error. */
function usage<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    throw new CliError(e instanceof Error ? e.message : String(e), 2);
  }
}

/** Resolve an id or a unique prefix of one (the listing prints {@link shortId}). */
async function findLeak(
  org: OrgInfo,
  arg: string | undefined,
  verb: string,
): Promise<LeakedSecret> {
  if (!arg) {
    throw new CliError(
      `Usage: infrawrench leaks ${verb} <id>\nIds are printed by \`infrawrench leaks --status all\`.`,
      2,
    );
  }
  const { leaks } = await orgFetch<LeakedSecretListResponse>(org.id, "/leaked-secrets");
  const found = matchIdPrefix(leaks, arg);
  if (found.match) return found.match;
  throw new CliError(
    found.candidates.length > 1
      ? `"${arg}" matches ${found.candidates.length} leaks: ${found.candidates
          .map((l) => l.id)
          .join(", ")}. Give more of the id.`
      : `No leaked credential matches "${arg}". Run \`infrawrench leaks --status all\` to list them.`,
  );
}

/**
 * Read the replacement value from stdin. Piped input is read to EOF; at a
 * terminal the value is typed with echo off (raw mode), so it is never shown
 * on screen either. Surrounding whitespace is dropped: a trailing newline
 * from `echo` or a paste is never part of a secret.
 */
async function readSecretFromStdin(): Promise<string> {
  const stdin = process.stdin;
  let value: string;
  if (stdin.isTTY) {
    process.stderr.write("New value (input hidden, Enter to finish): ");
    value = await new Promise<string>((resolve, reject) => {
      let buf = "";
      const wasRaw = stdin.isRaw;
      stdin.setRawMode?.(true);
      stdin.resume();
      const done = (err: Error | null): void => {
        stdin.off("data", onData);
        stdin.setRawMode?.(wasRaw ?? false);
        stdin.pause();
        process.stderr.write("\n");
        if (err) reject(err);
        else resolve(buf);
      };
      function onData(data: Buffer): void {
        for (const ch of data.toString("utf8")) {
          if (ch === "\u0003") return done(new CliError("Canceled.", 130));
          if (ch === "\r" || ch === "\n" || ch === "\u0004") return done(null);
          if (ch === "\u007f" || ch === "\b") buf = buf.slice(0, -1);
          else buf += ch;
        }
      }
      stdin.on("data", onData);
    });
  } else {
    const chunks: Buffer[] = [];
    for await (const chunk of stdin) chunks.push(Buffer.from(chunk));
    value = Buffer.concat(chunks).toString("utf8");
  }
  value = value.trim();
  if (!value) throw new CliError("No value on stdin. Nothing was rotated.", 2);
  return value;
}

/** The one-line outcome after an action, plus any scanner-side failure. */
function printOutcome(verb: string, leak: LeakedSecret): void {
  println(
    `${c.bold(verb)} ${shortId(leak.id)} ${c.dim(
      `· ${safe(leak.tokenTypeLabel)} · ${formatLeakStatus(leak)}`,
    )}`,
  );
  if (leak.upstreamResolvedAt) {
    println(c.dim(`Closed on the scanner ${formatChangeTime(leak.upstreamResolvedAt)}.`));
  }
  if (leak.upstreamResolveError) {
    println(c.yellow(`Couldn't close it on the scanner: ${safe(leak.upstreamResolveError)}`));
  }
}

function emit(ctx: CliContext, org: OrgInfo, verb: string, leak: LeakedSecret): void {
  if (ctx.flags.output === "json") printJson({ org: org.id, leak });
  else printOutcome(verb, leak);
}

async function act(
  org: OrgInfo,
  leak: LeakedSecret,
  action: string,
  body: Record<string, unknown>,
): Promise<LeakedSecret> {
  const res = await orgFetch<{ leak: LeakedSecret }>(
    org.id,
    `/leaked-secrets/${encodeURIComponent(leak.id)}/${action}`,
    { method: "POST", body: JSON.stringify(body) },
  );
  return res.leak;
}

export async function cmdLeaks(ctx: CliContext, args: string[], flags: LeakFlags): Promise<void> {
  requireCloud(ctx);
  const [sub = "list", target] = args;
  const resolveUpstream = !flags.keepUpstreamOpen;

  switch (sub) {
    case "list":
      return listLeaks(ctx, flags);
    case "scan": {
      const org = await resolveOrg(ctx);
      const r = await orgFetch<{ scanned: number; newLeaks: number; errors: number }>(
        org.id,
        "/leaked-secrets/scan",
        { method: "POST", body: "{}" },
      );
      if (ctx.flags.output === "json") {
        printJson({ org: org.id, ...r });
        return;
      }
      if (r.scanned === 0) {
        println(
          c.dim(
            "No scanner accounts to scan. Connect a GitHub organization or a GitLab account to start finding committed credentials.",
          ),
        );
        return;
      }
      const failed = r.errors > 0 ? c.red(`, ${r.errors} failed`) : "";
      println(
        `Scanned ${r.scanned} account${r.scanned === 1 ? "" : "s"}${failed}. New leaks: ${
          r.newLeaks > 0 ? c.red(String(r.newLeaks)) : "0"
        }.`,
      );
      if (r.errors > 0) process.exitCode = 1;
      return;
    }
    case "rotate": {
      const org = await resolveOrg(ctx);
      const leak = await findLeak(org, target, "rotate");
      const refusal = leakRotateRefusal(leak);
      if (refusal) throw new CliError(refusal);
      const body: Record<string, unknown> = { resolveUpstream };
      if (leak.rotation.mode === "replace") {
        if (!flags.valueStdin) {
          throw new CliError(
            "This secret is stored as a literal value, so rotating it means supplying the new one.\n" +
              "Create it at the provider, then pass it on stdin (never as an argument, which lands in shell history):\n" +
              `  infrawrench leaks rotate ${shortId(leak.id)} --value-stdin < new-value.txt`,
            2,
          );
        }
        body.value = await readSecretFromStdin();
      } else if (flags.valueStdin) {
        throw new CliError(
          "The provider reissues this value itself, so there is nothing to read from stdin. Drop --value-stdin.",
          2,
        );
      }
      return emit(ctx, org, "Rotated", await act(org, leak, "rotate", body));
    }
    case "mark-rotated": {
      const org = await resolveOrg(ctx);
      const leak = await findLeak(org, target, "mark-rotated");
      return emit(
        ctx,
        org,
        "Marked rotated",
        await act(org, leak, "mark-rotated", { resolveUpstream }),
      );
    }
    case "dismiss": {
      const reason = usage(() => parseLeakDismissReason(ctx.flags.reason));
      const org = await resolveOrg(ctx);
      const leak = await findLeak(org, target, "dismiss");
      const body: Record<string, unknown> = { reason, resolveUpstream };
      if (flags.comment?.trim()) body.comment = flags.comment.trim();
      return emit(ctx, org, "Dismissed", await act(org, leak, "dismiss", body));
    }
    case "reopen": {
      const org = await resolveOrg(ctx);
      const leak = await findLeak(org, target, "reopen");
      return emit(ctx, org, "Reopened", await act(org, leak, "reopen", {}));
    }
    default:
      throw new CliError(`Unknown leaks subcommand "${sub}".\n${USAGE}`, 2);
  }
}

const SEVERITY_COLOR = { critical: c.red, high: c.yellow } as const;

async function listLeaks(ctx: CliContext, flags: LeakFlags): Promise<void> {
  const status = usage(() => parseLeakStatusFlag(flags.status));
  const org = await resolveOrg(ctx);
  const accountId = ctx.flags.account
    ? resolveAccount(await listCloudAccounts(org.id), ctx.flags.account).id
    : null;
  const params = new URLSearchParams();
  if (status) params.set("status", status);
  if (accountId) params.set("accountId", accountId);
  const qs = params.toString();
  const response = await orgFetch<LeakedSecretListResponse>(
    org.id,
    `/leaked-secrets${qs ? `?${qs}` : ""}`,
  );

  if (ctx.flags.output === "json") {
    printJson({ org: org.id, ...response });
    return;
  }

  const open = response.counts.open ?? 0;
  println(
    `${c.bold(safe(org.displayName))} ${c.dim("· leaked credentials")}  ${
      open > 0 ? c.red(formatLeakCounts(response.counts)) : c.dim(formatLeakCounts(response.counts))
    }`,
  );
  printScanners(response.scanners);
  println();

  if (response.scanners.length === 0) {
    println(
      c.dim(
        "No scanner connected. Add a GitHub organization or a GitLab account to start finding credentials committed to code.",
      ),
    );
    return;
  }
  if (response.leaks.length === 0) {
    println(
      c.dim(
        status
          ? `No ${status} leaks${accountId ? " for that account" : ""}. \`--status all\` lists every one.`
          : `No leaks${accountId ? " for that account" : ""}.`,
      ),
    );
    return;
  }

  // The server orders open first, newest first within a status; keep it.
  const columns: Column<LeakedSecret>[] = [
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
  printTable(response.leaks, columns);

  const failed = response.leaks.filter((l) => l.upstreamResolveError);
  for (const l of failed) {
    println(
      c.yellow(
        `${shortId(l.id)}: couldn't close it on the scanner: ${safe(l.upstreamResolveError)}`,
      ),
    );
  }

  if (response.leaks.some((l) => l.status === "open")) {
    println();
    println(
      c.dim(
        "Act on one with `leaks rotate <id>`, `leaks mark-rotated <id>` or `leaks dismiss <id> --reason <r>`; `--json` has full ids, finding URLs and each leak's rotation mode.",
      ),
    );
  }
}

function printScanners(scanners: LeakedSecretScanner[]): void {
  for (const s of scanners) {
    const line = formatLeakScanner(s);
    println(s.lastError ? c.red(line) : c.dim(line));
  }
}
