/**
 * What of an error goes into a log line.
 *
 * Passing the error itself to `console.error` prints everything it carries.
 * Three kinds carry more than a log should hold:
 *
 * - a database error's message ends in the statement's parameters (a comment
 *   of a private repository, an email, a key);
 * - a schema error raised while encoding an answer holds the value that did
 *   not fit, which for the token endpoints is the token just minted;
 * - an error from a call to another service can quote the request, with its
 *   `Authorization` header.
 *
 * `describeError` keeps what finds the bug (the class, the message without
 * those parts, where it was thrown, and the same for its causes) and writes
 * anything shaped like one of our credentials as its prefix only.
 */

const MAX_MESSAGE = 1000;
const MAX_FRAMES = 12;
const MAX_CAUSES = 3;

/** Every `iw?_` secret (tokens, keys, OAuth codes and refresh tokens), bearer and basic credentials, sealed values. */
const CREDENTIALS: readonly (readonly [RegExp, string])[] = [
  [/\biw([a-z])_[A-Za-z0-9._~+/=-]{8,}/g, "iw$1_[redacted]"],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [redacted]"],
  [/\bv1\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[sealed]"],
  [/([?&](?:token|code|state|refresh_token|code_verifier)=)[^&\s"']+/gi, "$1[redacted]"],
];

/** Text safe to log: credentials cut to their kind, control characters out, bounded. */
export const redact = (value: string, limit = MAX_MESSAGE): string => {
  let out = value;
  for (const [pattern, replacement] of CREDENTIALS) out = out.replace(pattern, replacement);
  // One log line stays one line, whatever a client put in a name.
  out = out.replace(/[\u0000-\u0008\u000a-\u001f\u007f-\u009f\u2028\u2029]/g, " ");
  return out.length > limit ? `${out.slice(0, limit)}... (${out.length - limit} more)` : out;
};

const messageOf = (error: Error): string => {
  // drizzle: "Failed query: <statement>\nparams: <values>". The statement
  // names the tables; the values are the user's.
  const params = error.message.indexOf("\nparams:");
  return params < 0 ? error.message : error.message.slice(0, params);
};

const framesOf = (error: Error): string => {
  if (typeof error.stack !== "string") return "";
  const frames = error.stack
    .split("\n")
    .filter((line) => /^\s+at\s/.test(line))
    .slice(0, MAX_FRAMES)
    .map((line) => redact(line.trim(), 300));
  return frames.length > 0 ? `\n  ${frames.join("\n  ")}` : "";
};

const isSchemaError = (
  error: object,
): error is { readonly _tag: string; readonly kind?: unknown } =>
  "_tag" in error &&
  typeof error._tag === "string" &&
  (error._tag === "HttpApiSchemaError" || error._tag === "SchemaError");

const describe = (error: unknown, depth: number): string => {
  if (error === null || typeof error !== "object") {
    return typeof error === "string" ? redact(error) : `(${typeof error})`;
  }
  if (isSchemaError(error)) {
    // The issue quotes the value that failed; only what kind of failure it was is kept.
    const kind = typeof error.kind === "string" ? ` kind=${redact(error.kind, 40)}` : "";
    const frames = error instanceof Error ? framesOf(error) : "";
    return `${error._tag}${kind} (the value is not logged)${frames}`;
  }
  if (!(error instanceof Error)) {
    const tag = "_tag" in error && typeof error._tag === "string" ? error._tag : "object";
    return `(${redact(tag, 80)})`;
  }
  const code =
    "code" in error && (typeof error.code === "string" || typeof error.code === "number")
      ? ` code=${redact(String(error.code), 40)}`
      : "";
  const own = `${redact(error.name, 80)}${code}: ${redact(messageOf(error))}${framesOf(error)}`;
  if (error.cause === undefined || depth >= MAX_CAUSES) return own;
  return `${own}\ncaused by ${describe(error.cause, depth + 1)}`;
};

/** An error as one bounded string for a log line. Never throws. */
export const describeError = (error: unknown): string => {
  try {
    return describe(error, 0);
  } catch {
    return "(an error that could not be described)";
  }
};
