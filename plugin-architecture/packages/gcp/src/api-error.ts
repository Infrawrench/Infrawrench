/**
 * Turning GCP's HTTP error bodies into something a user can act on.
 *
 * By far the most common failure against a fresh project is a disabled API:
 * every service is off until someone enables it, so touching a resource type
 * the project has never used answers 403 rather than an empty list. Raw, that
 * arrives as ~700 characters of JSON wrapped around one actionable sentence,
 * and it reaches the user through surfaces with no room for it.
 *
 * The body carries what we need structurally — `details[]` holds an ErrorInfo
 * with `reason: "SERVICE_DISABLED"` and `metadata.service` (the API's host
 * name), and `error.message` opens with the API's display name. We rebuild the
 * sentence from those rather than forwarding Google's, whose "Enable it by
 * visiting …" link points at the legacy console.developers.google.com host and
 * whose trailing propagation caveat is noise — callers retry on their own
 * schedule regardless.
 */

/** Shape of the fields we read off a GCP error body; everything is optional. */
interface GcpErrorBody {
  error?: {
    message?: string;
    status?: string;
    details?: Array<{
      reason?: string;
      metadata?: { service?: string; consumer?: string };
    }>;
  };
}

/**
 * The API's display name is the run of words before " has not been used" in
 * Google's message ("Cloud SQL Admin API has not been used in project …").
 * Falls back to the bare host name when the phrasing changes.
 */
function apiDisplayName(message: string, service: string): string {
  const cut = message.indexOf(" has not been used");
  const name = cut > 0 ? message.slice(0, cut).trim() : "";
  return name || service;
}

/**
 * Rewrite a "this API is switched off" 403 into one actionable sentence, or
 * return null when the body is anything else.
 *
 * `project` is the account's configured project id when the caller knows it —
 * preferred over the project *number* Google echoes back in `metadata.consumer`,
 * since the id is what the user recognizes. The console accepts either.
 */
export function describeDisabledApi(status: number, body: string, project?: string): string | null {
  if (status !== 403) return null;

  let parsed: GcpErrorBody | undefined;
  try {
    parsed = JSON.parse(body) as GcpErrorBody;
  } catch {
    // Not JSON (an HTML error page from a proxy, say).
    return null;
  }

  const err = parsed?.error;
  const disabled = err?.details?.find((d) => d.reason === "SERVICE_DISABLED");
  const service = disabled?.metadata?.service;
  if (!service) return null;

  // `consumer` is "projects/<number>"; keep only the identifier.
  const consumer = disabled?.metadata?.consumer?.replace(/^projects\//, "");
  const target = project || consumer;
  const name = apiDisplayName(err?.message ?? "", service);

  const where = target ? ` for project ${target}` : "";
  const link = target
    ? ` Enable it at https://console.cloud.google.com/apis/library/${service}?project=${encodeURIComponent(target)}`
    : ` Enable it in the API library: https://console.cloud.google.com/apis/library/${service}`;
  return `The ${name} (${service}) is not enabled${where}.${link} — it can take a few minutes to take effect.`;
}

/**
 * Build the error thrown for a non-2xx GCP response whose body has already
 * been read.
 *
 * The HTTP status is attached to the error object as well as being written
 * into the message. Hosts classify failures (is this worth retrying? should it
 * back the account off?) and reading a status back out of prose is unreliable:
 * any three digits in a project id or resource name can be mistaken for one.
 * `status` gives them something unambiguous to branch on.
 */
export function gcpApiError(status: number, url: string, body: string, project: string): Error {
  const disabled = describeDisabledApi(status, body, project);
  const err = disabled ? new Error(disabled) : new Error(`GCP API ${status} for ${url}: ${body}`);
  return Object.assign(err, { status });
}
