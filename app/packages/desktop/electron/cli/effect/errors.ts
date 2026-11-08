// The CLI's typed failures. Every one renders as a single red line on stderr
// (the runner prints `message`) and carries the exit code the process ends
// with: 2 for a usage mistake, 1 for everything else. A failure that is none
// of these, a defect, prints its stack instead, the way `runCli` always has.
import { Schema } from "effect";

/** A mistake on the command line (a bad flag value, a contradictory pair). Exit 2. */
export class CliUsageError extends Schema.TaggedError<CliUsageError>()("CliUsageError", {
  message: Schema.String,
}) {
  readonly exitCode = 2;
}

/** The command could not do what it was asked, for a reason worth one sentence. Exit 1. */
export class CliFailure extends Schema.TaggedError<CliFailure>()("CliFailure", {
  message: Schema.String,
}) {
  readonly exitCode = 1;
}

/**
 * The command has already said what went wrong (a failed test delivery,
 * printed with the rest of its output) and only the exit code is left: the
 * runner prints nothing more.
 */
export class CliExit extends Schema.TaggedError<CliExit>()("CliExit", {
  exitCode: Schema.Int,
}) {}

/** The person at the terminal backed out of a prompt (Ctrl-C, Esc): the shell's 130. */
export class Canceled extends Schema.TaggedError<Canceled>()("Canceled", {}) {
  readonly exitCode = 130;
  override get message(): string {
    return "Canceled.";
  }
}

/** No cloud session: no stored token, or the refresh token is dead. */
export class NotSignedIn extends Schema.TaggedError<NotSignedIn>()("NotSignedIn", {}) {
  readonly exitCode = 1;
  override get message(): string {
    return "Not signed in to Infrawrench Cloud. Run `infrawrench login` (or sign in from the desktop app; the CLI shares its session).";
  }
}

/** The cloud answered with a non-2xx status. */
export class CloudRequestFailed extends Schema.TaggedError<CloudRequestFailed>()(
  "CloudRequestFailed",
  { status: Schema.Int, path: Schema.String, body: Schema.String },
) {
  readonly exitCode = 1;
  override get message(): string {
    return `Cloud request failed: ${this.status} ${this.path}${describeBody(this.body)}`;
  }
}

/**
 * A 200 that is a web page: the SPA's catch-all answering for a route this
 * server does not have, which is a version skew rather than a failure.
 * `expected` names what a real answer would have been ("data", "a file").
 */
export class EndpointUnavailable extends Schema.TaggedError<EndpointUnavailable>()(
  "EndpointUnavailable",
  { path: Schema.String, baseUrl: Schema.String, expected: Schema.String },
) {
  readonly exitCode = 1;
  override get message(): string {
    return (
      `${this.path} is not available on ${this.baseUrl}.\n` +
      `The server answered with a web page instead of ${this.expected}, which usually means it is ` +
      `running a version without this endpoint.`
    );
  }
}

/**
 * A 2xx whose body is not what the caller can read: not JSON, or JSON that
 * does not decode against the command's schema. `detail` is already shaped
 * for the end of the sentence (a leading space or colon, or empty).
 */
export class MalformedResponse extends Schema.TaggedError<MalformedResponse>()(
  "MalformedResponse",
  { path: Schema.String, detail: Schema.String },
) {
  readonly exitCode = 1;
  override get message(): string {
    return `Cloud request returned a malformed response for ${this.path}${this.detail}`;
  }
}

const OrgCandidate = Schema.Struct({ id: Schema.String, displayName: Schema.String });

/** `--org` (or `INFRAWRENCH_ORG`) did not pick exactly one organization. */
export class OrgNotResolved extends Schema.TaggedError<OrgNotResolved>()("OrgNotResolved", {
  reason: Schema.Literals(["no-orgs", "unspecified", "no-match", "ambiguous"]),
  wanted: Schema.NullOr(Schema.String),
  candidates: Schema.Array(OrgCandidate),
}) {
  readonly exitCode = 1;
  override get message(): string {
    switch (this.reason) {
      case "no-orgs":
        return "You are not a member of any organization.";
      case "unspecified":
        return `Multiple organizations: pass --org <id|name>:\n${this.candidates
          .map((o) => `  ${o.id}  ${o.displayName}`)
          .join("\n")}`;
      case "no-match":
        return `No organization matches "${this.wanted}".`;
      case "ambiguous":
        return `"${this.wanted}" matches several organizations: ${this.candidates.map((o) => o.displayName).join(", ")}.`;
    }
  }
}

/** Every way a cloud call fails, short of a defect (a network error, a bug). */
export type CloudError =
  NotSignedIn | CloudRequestFailed | EndpointUnavailable | MalformedResponse | OrgNotResolved;

/** Every typed failure a command may end with. */
export type CliCommandError = CliUsageError | CliFailure | CliExit | Canceled | CloudError;

/** True for a response body that is a web page rather than data. */
export function looksLikeHtml(body: string): boolean {
  const head = body.slice(0, 200).trimStart().toLowerCase();
  return head.startsWith("<!doctype html") || head.startsWith("<html");
}

/**
 * A response body worth putting in an error message. HTML is summarised rather
 * than shown (a whole page of markup buries the actual problem) and anything
 * long is truncated.
 */
export function describeBody(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) return "";
  if (looksLikeHtml(trimmed)) return " (the server returned a web page, not data)";
  return ` ${trimmed.length > 300 ? `${trimmed.slice(0, 300)}…` : trimmed}`;
}
