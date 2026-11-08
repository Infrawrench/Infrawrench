// `infrawrench recordings`: recorded SSH sessions for the org.
//
// `infrawrench recordings get <id>` writes the asciicast to stdout (or to
// `--file`), which is the point of the subcommand existing at all: the format
// is asciinema's, so `infrawrench recordings get <id> | asciinema play -`
// replays a session on a machine that has never seen our UI. That is the shape
// an auditor or an incident responder actually wants.
import { writeFile } from "node:fs/promises";
import { Effect, Option, Schema } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import type { SessionRecording, SessionRecordingSettings } from "@infrawrench/client-core" with {
  "resolution-mode": "import",
};
import { CloudApi, currentOrg, decodeBody } from "../effect/cloud-api";
import { CliFailure } from "../effect/errors";
import { file } from "../effect/file-flags";
import * as Print from "../effect/print";
import { CliSession } from "../effect/session";
import { knownOr, Unrecognized, wire } from "../effect/wire";
import { c, type Column, safe } from "../output";

const LIST_PATH = "/session-recordings";
const SETTINGS_PATH = "/session-recordings/settings";

const Recording = Schema.Struct({
  id: Schema.String,
  startedAt: Schema.String,
  userName: Schema.NullOr(Schema.String),
  username: Schema.String,
  host: Schema.String,
  durationMs: Schema.NullOr(Schema.Finite),
  outputBytes: Schema.Finite,
  status: knownOr(["recording", "complete", "truncated", "abandoned"]),
});
type Recording = typeof Recording.Type;
const Recordings = wire<SessionRecording[]>()(Schema.Array(Recording));

const Settings = wire<SessionRecordingSettings>()(
  Schema.Struct({
    enabled: Schema.Boolean,
    retentionDays: Schema.Finite,
    usage: Schema.Struct({ recordingCount: Schema.Finite, storedBytes: Schema.Finite }),
  }),
);

/** "4m 12s": kept local so the CLI has no DOM-adjacent import. */
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

function statusCell(status: Recording["status"]): string {
  if (status instanceof Unrecognized) return c.dim(safe(status.raw));
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

const list = Effect.fn("recordings")(function* () {
  const session = yield* CliSession;
  const api = yield* CloudApi;
  const org = yield* currentOrg;
  const [recordingsBody, settingsBody] = yield* Effect.all(
    [api.json(org.id, LIST_PATH), api.json(org.id, SETTINGS_PATH)],
    { concurrency: "unbounded" },
  );

  if (session.output === "json") {
    return yield* Print.json({ org: org.id, settings: settingsBody, recordings: recordingsBody });
  }
  const recordings = yield* decodeBody(Recordings, LIST_PATH)(recordingsBody);
  const settings = yield* decodeBody(Settings, SETTINGS_PATH)(settingsBody);

  if (!settings.enabled) {
    yield* Print.line(
      c.yellow(
        "Session recording is off for this organization. Turn it on in Settings → Session Recordings.",
      ),
    );
    yield* Print.line();
  }

  if (recordings.length === 0) {
    return yield* Print.line(
      c.dim(
        "No recorded sessions. Only SSH opened through the cloud is recorded. A desktop session that dials a host directly never reaches the server.",
      ),
    );
  }

  yield* Print.line(
    `${c.bold(safe(org.displayName))} ${c.dim(
      `· ${settings.usage.recordingCount} recording${settings.usage.recordingCount === 1 ? "" : "s"}, ` +
        `${bytes(settings.usage.storedBytes)} stored, kept ${settings.retentionDays}d`,
    )}`,
  );
  yield* Print.line();

  const columns: Column<Recording>[] = [
    { header: "id", value: (r) => c.dim(r.id.slice(0, 8)) },
    { header: "started", value: (r) => r.startedAt.replace("T", " ").slice(0, 16) + "Z" },
    { header: "who", value: (r) => (r.userName === null ? c.dim("api key") : safe(r.userName)) },
    { header: "target", value: (r) => safe(`${r.username}@${r.host}`) },
    { header: "duration", value: (r) => duration(r.durationMs) },
    { header: "size", value: (r) => c.dim(bytes(r.outputBytes)) },
    { header: "status", value: (r) => statusCell(r.status) },
  ];
  yield* Print.table(recordings, columns);
  yield* Print.line();
  yield* Print.line(
    c.dim("infrawrench recordings get <id> | asciinema play -   (or --file out.cast to save it)"),
  );
});

const get = Command.make(
  "get",
  {
    id: Argument.String("recording-id").pipe(
      Argument.withDescription("The recording (see `infrawrench recordings`)"),
      Argument.optional,
    ),
    file: file.pipe(Flag.withDescription("Save the asciicast here instead of printing it")),
  },
  Effect.fn("recordings.get")(function* (input) {
    const api = yield* CloudApi;
    const org = yield* currentOrg;
    const id = Option.getOrElse(input.id, () => "");
    if (!id) {
      return yield* new CliFailure({
        message: "Usage: infrawrench recordings get <recording-id> [--file <path>]",
      });
    }
    const cast = yield* api.text(
      org.id,
      `/session-recordings/${encodeURIComponent(id)}/cast?download=1`,
    );
    const target = Option.getOrElse(input.file, () => "");
    if (target) {
      yield* Effect.promise(() => writeFile(target, cast, "utf8"));
      yield* Print.line(c.dim(`Wrote ${bytes(Buffer.byteLength(cast, "utf8"))} to ${target}`));
      return yield* Print.line(c.dim(`Play it with: asciinema play ${target}`));
    }
    // Straight to stdout with no framing, so the pipe into `asciinema play -`
    // works. `Print.line` would be wrong here: it is for human output.
    yield* Print.write(cast);
  }),
).pipe(
  Command.withDescription(
    "Print the session's asciicast (pipe it: infrawrench recordings get <id> | asciinema play -)",
  ),
);

export const recordings = Command.make("recordings", {}, list).pipe(
  Command.withDescription("Recorded SSH sessions: who connected, to what, for how long"),
  Command.withSubcommands([
    Command.make("list", {}, list).pipe(Command.withDescription("Every recorded session")),
    get,
  ]),
);
