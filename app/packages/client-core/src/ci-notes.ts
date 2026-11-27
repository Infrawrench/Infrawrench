// Note commands: lines a CI job prints that become notes on its commit's
// branch page on git.infrawrench.com.
//
//   ::must-fix file=src/db.ts,line=42,title=Unbounded query::No LIMIT here.
//   ::doubt file=src/db.ts,line=42::Is this index still used?
//
// `must-fix`, `should-fix` and `note` become findings of that severity;
// `doubt`, `decision`, `step` and `evidence` become trace entries of that
// kind. This module is the syntax and nothing else: it reads a job's output
// as the runner reported it (already masked by the runner) and says which
// lines are commands. Where the notes go, and under whose name, is
// server-core's `ci/git-notes.ts`; `ci-runner/README.md` ("Notes on the
// branch page") is the reference a pipeline's author reads, and its tables
// say what this file does.
//
// It is here, not in server-core, because three things spell the same names:
// the app (which writes the notes), the forge's API (which refuses the names
// to everyone else) and the forge's pages (which show where a note came
// from).

/** What a job's findings are reported as: `ci:<pipeline>/<job>`. */
export const CI_REVIEWER_PREFIX = "ci:";

/** The `kind` of the agent a CI job's trace entries are written by. */
export const CI_AGENT_KIND = "ci";

/** The name a job goes by on a note: its pipeline and its key. */
export function ciJobName(pipeline: string, job: string): string {
  return `${pipeline}/${job}`;
}

/** The reviewer a job's findings are reported under. */
export function ciReviewerName(pipeline: string, job: string): string {
  return `${CI_REVIEWER_PREFIX}${ciJobName(pipeline, job)}`;
}

/** Whether a reviewer name is one CI reports under. */
export function isCiReviewer(reviewerKind: string): boolean {
  return reviewerKind.startsWith(CI_REVIEWER_PREFIX);
}

/**
 * The job a CI reviewer name is of, as `<pipeline>/<job>`, for showing; null
 * for any other reviewer. Not split further: a pipeline's name and a
 * matrix or package job's key (`build[app/packages/ui]`) may both hold a `/`.
 */
export function ciReviewerJob(reviewerKind: string): string | null {
  if (!isCiReviewer(reviewerKind)) return null;
  const name = reviewerKind.slice(CI_REVIEWER_PREFIX.length);
  return name === "" ? null : name;
}

export type CiNoteSeverity = "must_fix" | "should_fix" | "note";
export type CiNoteTraceKind = "doubt" | "decision" | "step" | "evidence";

/** The commands that become findings, and the severity each one is. */
export const CI_NOTE_FINDING_COMMANDS: Readonly<Record<string, CiNoteSeverity>> = {
  "must-fix": "must_fix",
  "should-fix": "should_fix",
  note: "note",
};

/** The commands that become trace entries. Each is the entry's kind. */
export const CI_NOTE_TRACE_COMMANDS: readonly CiNoteTraceKind[] = [
  "doubt",
  "decision",
  "step",
  "evidence",
];

export const CI_NOTE_LIMITS = {
  /** Notes one job leaves. Commands after these are ignored and counted. */
  perJob: 100,
  /** Notes one run leaves, over all its jobs. */
  perRun: 1000,
  /** A message, in UTF-8 bytes, after its escapes are read. */
  messageBytes: 8 * 1024,
  /** A `title`, in characters. */
  titleLength: 200,
  /** A `file`, in characters. */
  pathLength: 1024,
  /** A title taken from a message's first line is cut to this. */
  derivedTitleLength: 120,
} as const;

/** One command, as the job wrote it. */
export interface CiNote {
  readonly command: string;
  /** Set for `must-fix`, `should-fix` and `note`. */
  readonly severity: CiNoteSeverity | null;
  /** Set for `doubt`, `decision`, `step` and `evidence`. */
  readonly traceKind: CiNoteTraceKind | null;
  /** Relative to the repository's root. Null for a note about the whole change. */
  readonly file: string | null;
  readonly line: number | null;
  readonly endLine: number | null;
  /** As given. Null when the command had none. */
  readonly title: string | null;
  /** As given. Null when the command did not say. */
  readonly needsCode: boolean | null;
  readonly message: string;
  /**
   * The line of the job's log it is on, from 1, counting the job's output
   * and then its errors: the number the run's page gives the line.
   */
  readonly logLine: number;
}

/** Commands that were recognised and not turned into a note, by why. */
export interface CiNotesIgnored {
  /** A parameter it does not take, a line that is not a number, no message. */
  malformed: number;
  /** A message, a title or a path past its limit. */
  tooLong: number;
  /** Past the job's or the run's limit. */
  overLimit: number;
}

export interface CiNotesParse {
  readonly notes: CiNote[];
  readonly ignored: CiNotesIgnored;
}

const COMMANDS = new Set<string>([
  ...Object.keys(CI_NOTE_FINDING_COMMANDS),
  ...CI_NOTE_TRACE_COMMANDS,
]);

/** `::<command>`, then a space and parameters or nothing, up to the next `::`. */
const HEAD = /^::([a-z][a-z-]*)(?: ([^\n]*?))?::/;

const ESCAPES: Readonly<Record<string, string>> = {
  "25": "%",
  "0A": "\n",
  "0D": "\r",
  "3A": ":",
  "2C": ",",
};

/**
 * Reads the escapes, in one pass, so `%250A` is the text `%0A` and not a
 * line break. Anything else after a `%` is left as it is.
 */
export function unescapeCiNote(text: string): string {
  return text.replace(/%(25|0A|0D|3A|2C)/gi, (_, code: string) => ESCAPES[code.toUpperCase()]!);
}

/** The reverse, for something that writes commands: a message's or a parameter's value. */
export function escapeCiNote(text: string, where: "message" | "parameter" = "message"): string {
  const escaped = text.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
  return where === "message" ? escaped : escaped.replace(/:/g, "%3A").replace(/,/g, "%2C");
}

const utf8 = new TextEncoder();

const PARAMETERS = new Set(["file", "line", "end_line", "title", "needs_code"]);
const LINE_NUMBER = /^[1-9][0-9]{0,8}$/;

type Refusal = "malformed" | "tooLong";

/** A path inside the repository, as a diff names it. Null when it is not one. */
function repositoryPath(value: string): string | null {
  let path = value.trim();
  while (path.startsWith("./")) path = path.slice(2);
  if (path === "" || path.startsWith("/") || path.includes("\\")) return null;
  for (let at = 0; at < path.length; at++) {
    const code = path.charCodeAt(at);
    if (code < 0x20 || code === 0x7f) return null;
  }
  if (path.split("/").some((segment) => segment === ".." || segment === "." || segment === "")) {
    return null;
  }
  return path;
}

function parseLine(text: string, logLine: number): CiNote | Refusal | null {
  if (!text.startsWith("::")) return null;
  const head = HEAD.exec(text);
  if (!head) {
    // One of ours that never closes its parameters is a mistake worth counting.
    const name = /^::([a-z][a-z-]*)(?: |$)/.exec(text)?.[1];
    return name !== undefined && COMMANDS.has(name) ? "malformed" : null;
  }
  const command = head[1]!;
  // Another tool's command (`::error`, `::group::`): not ours, and not a mistake.
  if (!COMMANDS.has(command)) return null;

  const given = new Map<string, string>();
  const parameters = head[2] ?? "";
  if (parameters.trim() !== "") {
    for (const pair of parameters.split(",")) {
      const at = pair.indexOf("=");
      if (at <= 0) return "malformed";
      const key = pair.slice(0, at).trim();
      if (!PARAMETERS.has(key) || given.has(key)) return "malformed";
      given.set(key, unescapeCiNote(pair.slice(at + 1)));
    }
  }

  let file: string | null = null;
  if (given.has("file")) {
    const value = given.get("file")!;
    if (value.length > CI_NOTE_LIMITS.pathLength) return "tooLong";
    file = repositoryPath(value);
    if (file === null) return "malformed";
  }
  let line: number | null = null;
  let endLine: number | null = null;
  if (given.has("line")) {
    const value = given.get("line")!.trim();
    if (file === null || !LINE_NUMBER.test(value)) return "malformed";
    line = Number(value);
  }
  if (given.has("end_line")) {
    const value = given.get("end_line")!.trim();
    if (line === null || !LINE_NUMBER.test(value)) return "malformed";
    endLine = Number(value);
    if (endLine < line) return "malformed";
  }
  let needsCode: boolean | null = null;
  if (given.has("needs_code")) {
    const value = given.get("needs_code")!.trim();
    if (value !== "true" && value !== "false") return "malformed";
    needsCode = value === "true";
  }
  let title: string | null = null;
  if (given.has("title")) {
    title = given.get("title")!.replace(/\s+/g, " ").trim();
    if (title === "") return "malformed";
    if (title.length > CI_NOTE_LIMITS.titleLength) return "tooLong";
  }

  const message = unescapeCiNote(text.slice(head[0].length)).trim();
  const severity = CI_NOTE_FINDING_COMMANDS[command] ?? null;
  // A finding may be its title alone; a trace entry is its message.
  if (message === "" && (severity === null || title === null)) return "malformed";
  if (utf8.encode(message).length > CI_NOTE_LIMITS.messageBytes) return "tooLong";

  return {
    command,
    severity,
    traceKind: severity === null ? (command as CiNoteTraceKind) : null,
    file,
    line,
    endLine,
    title,
    needsCode,
    message,
    logLine,
  };
}

/** A job's output as the run's page numbers it: no line for a trailing line break. */
function logLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * The note commands in one job's output. `limit` is how many notes the job
 * may still leave (the job's own limit, or what is left of the run's).
 *
 * Only ever give this what the runner reported: its report is masked, and a
 * note is read by everyone who can read the repository.
 */
export function parseCiNotes(
  output: { readonly stdout: string; readonly stderr: string },
  limit: number = CI_NOTE_LIMITS.perJob,
): CiNotesParse {
  const notes: CiNote[] = [];
  const ignored: CiNotesIgnored = { malformed: 0, tooLong: 0, overLimit: 0 };
  let logLine = 0;
  for (const stream of [output.stdout, output.stderr]) {
    // Not one command in it: the common case, and the cheap one.
    if (!stream.includes("::")) {
      logLine += logLines(stream).length;
      continue;
    }
    for (const raw of logLines(stream)) {
      logLine += 1;
      const parsed = parseLine(raw.endsWith("\r") ? raw.slice(0, -1) : raw, logLine);
      if (parsed === null) continue;
      if (parsed === "malformed" || parsed === "tooLong") ignored[parsed] += 1;
      else if (notes.length >= Math.min(limit, CI_NOTE_LIMITS.perJob)) ignored.overLimit += 1;
      else notes.push(parsed);
    }
  }
  return { notes, ignored };
}

/** One sentence saying how many commands were ignored and why, or null when none were. */
export function ciNotesIgnoredSummary(ignored: CiNotesIgnored): string | null {
  const total = ignored.malformed + ignored.tooLong + ignored.overLimit;
  if (total === 0) return null;
  const why = [
    ignored.malformed > 0 ? `${ignored.malformed} malformed` : null,
    ignored.tooLong > 0 ? `${ignored.tooLong} too long` : null,
    ignored.overLimit > 0 ? `${ignored.overLimit} past the limit` : null,
  ].filter((part) => part !== null);
  return `${total} note command${total === 1 ? "" : "s"} ignored (${why.join(", ")})`;
}

/**
 * What a finding is called: the title given, else the message's first line,
 * cut. `body` is what is left to say under it: the whole message, or
 * nothing when the title already is the message.
 */
export function ciNoteTitle(note: Pick<CiNote, "title" | "message">): {
  title: string;
  body: string;
} {
  if (note.title !== null) return { title: note.title, body: note.message };
  const first =
    note.message
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line !== "") ?? "";
  const whole = first === note.message.trim();
  if (first.length <= CI_NOTE_LIMITS.derivedTitleLength) {
    return { title: first, body: whole ? "" : note.message };
  }
  return {
    title: `${first.slice(0, CI_NOTE_LIMITS.derivedTitleLength - 1)}…`,
    body: note.message,
  };
}
