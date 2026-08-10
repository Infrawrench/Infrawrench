import { writeFile } from "node:fs/promises";

import { CliError, orgFetch, orgFetchText, resolveOrg, type CliContext } from "../context";
import type {
  SessionRecording,
  SessionRecordingSettings,
  SessionRecordingStatus,
} from "@infrawrench/client-core" with { "resolution-mode": "import" };
import { c, printJson, println, printTable, type Column } from "../output";

/** "4m 12s" — kept local so the CLI has no DOM-adjacent import. */
function duration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return "—";
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}

function bytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = value;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v >= 10 || u === 0 ? Math.round(v) : v.toFixed(1)} ${units[u]}`;
}

function statusCell(status: SessionRecordingStatus): string {
  switch (status) {
    case "complete":
      return c.dim("complete");
    case "recording":
      return c.green("live");
    case "truncated":
      return c.yellow("truncated");
    case "abandoned":
      return c.yellow("incomplete");
  }
}

/**
 * `infrawrench recordings` — recorded SSH sessions for the org.
 *
 * `infrawrench recordings get <id>` writes the asciicast to stdout (or to
 * `--file`), which is the point of the subcommand existing at all: the format
 * is asciinema's, so `infrawrench recordings get <id> | asciinema play -`
 * replays a session on a machine that has never seen our UI. That is the shape
 * an auditor or an incident responder actually wants.
 */
export async function cmdRecordings(
  ctx: CliContext,
  rest: string[],
  opts: { file?: string | null | undefined } = {},
): Promise<void> {
  const org = await resolveOrg(ctx);
  const sub = rest[0];

  if (sub === "get") {
    const id = rest[1];
    if (!id) throw new CliError("Usage: infrawrench recordings get <recording-id> [--file <path>]");
    const cast = await orgFetchText(
      org.id,
      `/session-recordings/${encodeURIComponent(id)}/cast?download=1`,
    );
    if (opts.file) {
      await writeFile(opts.file, cast, "utf8");
      println(c.dim(`Wrote ${bytes(Buffer.byteLength(cast, "utf8"))} to ${opts.file}`));
      println(c.dim(`Play it with: asciinema play ${opts.file}`));
      return;
    }
    // Straight to stdout with no framing, so the pipe into `asciinema play -`
    // works. `println` would be wrong here: it is for human output.
    process.stdout.write(cast);
    return;
  }

  if (sub !== undefined && sub !== "list") {
    throw new CliError(`Unknown subcommand "${sub}". Try: recordings, recordings get <id>`);
  }

  const [recordings, settings] = await Promise.all([
    orgFetch<SessionRecording[]>(org.id, "/session-recordings"),
    orgFetch<SessionRecordingSettings>(org.id, "/session-recordings/settings"),
  ]);

  if (ctx.flags.output === "json") {
    printJson({ org: org.id, settings, recordings });
    return;
  }

  if (!settings.enabled) {
    println(
      c.yellow(
        "Session recording is off for this organization. Turn it on in Settings → Session Recordings.",
      ),
    );
    println();
  }

  if (recordings.length === 0) {
    println(
      c.dim(
        "No recorded sessions. Only SSH opened through the cloud is recorded — a desktop session that dials a host directly never reaches the server.",
      ),
    );
    return;
  }

  println(
    `${c.bold(org.displayName)} ${c.dim(
      `· ${settings.usage.recordingCount} recording${settings.usage.recordingCount === 1 ? "" : "s"}, ` +
        `${bytes(settings.usage.storedBytes)} stored, kept ${settings.retentionDays}d`,
    )}`,
  );
  println();

  const columns: Column<SessionRecording>[] = [
    { header: "id", value: (r) => c.dim(r.id.slice(0, 8)) },
    { header: "started", value: (r) => r.startedAt.replace("T", " ").slice(0, 16) + "Z" },
    { header: "who", value: (r) => r.userName ?? c.dim("api key") },
    { header: "target", value: (r) => `${r.username}@${r.host}` },
    { header: "duration", value: (r) => duration(r.durationMs) },
    { header: "size", value: (r) => c.dim(bytes(r.outputBytes)) },
    { header: "status", value: (r) => statusCell(r.status) },
  ];
  printTable(recordings, columns);
  println();
  println(
    c.dim("infrawrench recordings get <id> | asciinema play -   (or --file out.cast to save it)"),
  );
}
