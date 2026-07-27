// `infrawrench page` and `infrawrench costs push` — the two push-up surfaces,
// from the machine that has the news.
//
// This is the CLI's reason to exist on a server rather than a laptop: a cron,
// a deploy script, or a health check can reach the org's on-call fan-out and
// its cost history without embedding Twilio, Slack, Expo, or a ClickHouse
// client. Both commands are thin wrappers over `POST /pages` and
// `POST /costs/rows`; the server owns every rule, including the paging cooldown
// that makes it safe to call `page` on every tick of a monitor.
import { readFileSync } from "node:fs";

import { CliError, orgFetch, resolveOrg, type CliContext } from "../context";
import type { PushFlags } from "../args";
import { c, printJson, println } from "../output";

/** Mirrors the `PageResponse` schema in the web package's OpenAPI paths. */
interface PageResult {
  delivered: boolean;
  suppressed: boolean;
  sms: number;
  push: number;
  slack: number;
  msTeams: number;
  retryAt?: string;
}

function requireSource(flags: PushFlags): string {
  if (!flags.source) {
    throw new CliError("--source <name> is required — it names the system raising this.", 2);
  }
  return flags.source;
}

/** `infrawrench page <message>` — raise an alert to the org's transports. */
export async function cmdPage(ctx: CliContext, rest: string[], flags: PushFlags): Promise<void> {
  if (ctx.flags.local) {
    throw new CliError("Paging goes through Infrawrench Cloud — `--local` has nobody to page.");
  }

  // `page clear` shares the command so the cooldown a page started can be
  // cleared from the same script that raised it.
  if (rest[0] === "clear") {
    return clearPage(ctx, flags);
  }

  const message = rest.join(" ").trim();
  if (!message) throw new CliError("Nothing to say — pass the alert text: `infrawrench page …`", 2);
  const source = requireSource(flags);

  const org = await resolveOrg(ctx);
  const result = await orgFetch<PageResult>(org.id, "/pages", {
    method: "POST",
    body: JSON.stringify({
      source,
      message,
      ...(flags.title ? { title: flags.title } : {}),
      ...(flags.key ? { key: flags.key } : {}),
      ...(flags.cooldown !== undefined ? { cooldownMinutes: flags.cooldown } : {}),
      ...(flags.voice ? { voice: true } : {}),
    }),
  });

  if (ctx.flags.output === "json") {
    printJson(result);
    return;
  }

  if (result.suppressed) {
    const retry = result.retryAt ? ` until ${result.retryAt}` : "";
    println(`${c.yellow("○")} suppressed — this key is still in cooldown${retry}`);
    return;
  }
  const counts = [
    result.sms > 0 ? `${result.sms} sms/voice` : null,
    result.push > 0 ? `${result.push} push` : null,
    result.slack > 0 ? `${result.slack} slack` : null,
    result.msTeams > 0 ? `${result.msTeams} teams` : null,
  ].filter(Boolean);

  if (!result.delivered) {
    // Not an error: the page was accepted and its cooldown rolled back, so the
    // next call tries again. Say so rather than implying the alert is lost.
    println(`${c.yellow("!")} nobody was reached — check the org's paging settings`);
    return;
  }
  println(`${c.green("✓")} paged ${c.dim(counts.join(", "))}`);
}

/** `infrawrench page clear` — drop a key's cooldown after a recovery. */
async function clearPage(ctx: CliContext, flags: PushFlags): Promise<void> {
  const source = requireSource(flags);
  const org = await resolveOrg(ctx);
  const query = new URLSearchParams({ source, ...(flags.key ? { key: flags.key } : {}) });
  const result = await orgFetch<{ cleared: boolean }>(org.id, `/pages?${query}`, {
    method: "DELETE",
  });

  if (ctx.flags.output === "json") {
    printJson(result);
    return;
  }
  println(
    result.cleared
      ? `${c.green("✓")} cooldown cleared — the next page delivers immediately`
      : `${c.dim("·")} nothing to clear — that key wasn't in cooldown`,
  );
}

/**
 * `infrawrench costs push --source <name> [--file rows.json]` — report spend
 * Infrawrench has no plugin for. Rows come from a file or stdin, so the usual
 * shape is a pipeline: `parse-invoice | infrawrench costs push --source colo`.
 */
export async function cmdCostsPush(ctx: CliContext, flags: PushFlags): Promise<void> {
  if (ctx.flags.local) {
    throw new CliError("Cost data lives in Infrawrench Cloud — there is no local cost history.");
  }
  const source = requireSource(flags);
  const rows = parseRows(await readRowsInput(flags.file));

  const org = await resolveOrg(ctx);
  const result = await orgFetch<{ written: number }>(org.id, "/costs/rows", {
    method: "POST",
    body: JSON.stringify({ source, rows }),
  });

  if (ctx.flags.output === "json") {
    printJson(result);
    return;
  }
  println(`${c.green("✓")} pushed ${result.written} row${result.written === 1 ? "" : "s"}`);
}

/** Rows from `--file`, or from stdin when it isn't a terminal. */
async function readRowsInput(file: string | undefined): Promise<string> {
  if (file) {
    try {
      return readFileSync(file, "utf8");
    } catch (e) {
      throw new CliError(`Can't read ${file}: ${e instanceof Error ? e.message : String(e)}`, 2);
    }
  }
  if (process.stdin.isTTY) {
    throw new CliError("No rows — pass --file <path> or pipe JSON on stdin.", 2);
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Accept either a bare array of rows or the request envelope, so output from
 * `costs push --json` (and anything shaped like the API body) round-trips.
 */
function parseRows(text: string): unknown[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new CliError(`Rows aren't valid JSON: ${e instanceof Error ? e.message : String(e)}`, 2);
  }
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === "object" && Array.isArray((parsed as { rows?: unknown }).rows)) {
    return (parsed as { rows: unknown[] }).rows;
  }
  throw new CliError('Expected a JSON array of rows, or an object with a "rows" array.', 2);
}
