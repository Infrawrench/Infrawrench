/**
 * What an AWS failure means for a list that was reading.
 *
 * A sync soft-deletes whatever a list stops returning, so a failure may only
 * read as "no rows" when AWS has said the rows are not there for this
 * credential. Everything else has to throw, which keeps the stored rows.
 *
 * Reads three shapes: {@link AwsRequestError} from `fetchSigned`, an SDK
 * exception (`name`, `$metadata.httpStatusCode`), and a network failure, where
 * `fetch` says only "fetch failed" and the reason sits in `cause`.
 */

import { isIncompleteListError } from "@infrawrench/plugin-base";

/** A non-2xx answer to a hand-signed request. Its message stays the one callers already match. */
export class AwsRequestError extends Error {
  /** Read by the poller's error classification, which trusts it over digits in the text. */
  readonly status: number;
  /** AWS's error code, when the answer carried one. */
  readonly code: string | undefined;

  constructor(message: string, status: number, code: string | undefined) {
    super(message);
    this.name = "AwsRequestError";
    this.status = status;
    this.code = code;
  }
}

/**
 * A page after the first failed. Only a first page can say a region is closed to
 * this credential: anything later means rows had started arriving, so the list
 * is incomplete whatever the answer was.
 */
export class ListInterruptedError extends Error {
  readonly status: number | undefined;

  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "ListInterruptedError";
    this.status = statusOf(cause);
  }
}

/**
 * `credential`: the key itself is bad or expired. Keys are global, so this is
 * never about one region.
 * `throttled`: try again later.
 * `refused`: this credential may not read it here (an IAM or SCP deny, or a
 * service or region it has not opted in to).
 * `no-endpoint`: the service has no endpoint in this region.
 * `gone`: the row was deleted between being listed and being described.
 * `other`: anything else, which says nothing about whether rows exist.
 */
export type AwsFailureKind =
  "credential" | "throttled" | "refused" | "no-endpoint" | "gone" | "other";

const CREDENTIAL =
  /\b(ExpiredToken(Exception)?|RequestExpired|InvalidClientTokenId|UnrecognizedClient(Exception)?|SignatureDoesNotMatch|InvalidSignature(Exception)?|InvalidAccessKeyId|AuthFailure|IncompleteSignature(Exception)?|MissingAuthenticationToken(Exception)?|InvalidToken|TokenRefreshRequired)\b|security token included in the request is (invalid|expired)|signature we calculated does not match/i;

const THROTTLED =
  /\b(Throttl(ing|ed)(Exception)?|ThrottledException|TooManyRequests(Exception)?|RequestLimitExceeded|RequestThrottled(Exception)?|BandwidthLimitExceeded|LimitExceededException|SlowDown|EC2ThrottledException|ProvisionedThroughputExceeded(Exception)?)\b|Rate exceeded/i;

const NO_ENDPOINT = /\bENOTFOUND\b|\bERR_NAME_NOT_RESOLVED\b/;

const REFUSED =
  /\b(AccessDenied(Exception)?|UnauthorizedOperation|AuthorizationError(Exception)?|UnauthorizedException|ForbiddenException|Forbidden|OptInRequired|SubscriptionRequired(Exception)?|NotSignedUp|RegionDisabled(Exception)?|UnsupportedRegion|InvalidAction|UnknownOperation(Exception)?)\b|not authorized to perform/;

const GONE =
  /\b\w*NotFound(Exception)?\b|\bNoSuch[A-Z]\w*|\bQueueDoesNotExist\b|\bNonExistentQueue\b|\bWAFNonexistentItem(Exception)?\b/;

function field(value: object, key: string): unknown {
  return Reflect.get(value, key);
}

function causeChain(err: unknown): object[] {
  const chain: object[] = [];
  let current = err;
  for (let depth = 0; depth < 8 && typeof current === "object" && current !== null; depth++) {
    chain.push(current);
    current = field(current, "cause");
  }
  return chain;
}

function statusOf(err: unknown): number | undefined {
  for (const link of causeChain(err)) {
    const metadata = field(link, "$metadata");
    const candidates = [
      field(link, "status"),
      field(link, "statusCode"),
      typeof metadata === "object" && metadata !== null
        ? field(metadata, "httpStatusCode")
        : undefined,
    ];
    for (const candidate of candidates) {
      if (typeof candidate === "number") return candidate;
    }
  }
  return undefined;
}

function failureText(err: unknown): string {
  if (typeof err !== "object" || err === null) return String(err);
  return causeChain(err)
    .flatMap((link) => [field(link, "name"), field(link, "code"), field(link, "message")])
    .filter((part) => typeof part === "string")
    .join(" ");
}

export function classifyAwsFailure(err: unknown): AwsFailureKind {
  if (err instanceof ListInterruptedError || isIncompleteListError(err)) return "other";
  const text = failureText(err);
  const status = statusOf(err);
  if (CREDENTIAL.test(text)) return "credential";
  if (status === 429 || THROTTLED.test(text)) return "throttled";
  if (NO_ENDPOINT.test(text)) return "no-endpoint";
  // Only guess from digits when the error carries no status to trust.
  if (status === 403 || (status === undefined && /\b403\b/.test(text))) return "refused";
  if (REFUSED.test(text)) return "refused";
  if (status === 404 || GONE.test(text)) return "gone";
  return "other";
}

/** A region this credential cannot use, which holds no rows it may see. */
export function isRegionUnavailable(err: unknown): boolean {
  const kind = classifyAwsFailure(err);
  return kind === "refused" || kind === "no-endpoint";
}

/**
 * For a catch around one row's describe: only a row that is gone, or that this
 * credential may not read, gets past it. A throttle or a 5xx says nothing about
 * the row, and dropping it would prune it.
 */
export function rethrowUnlessRowUnreadable(err: unknown): void {
  const kind = classifyAwsFailure(err);
  if (kind !== "refused" && kind !== "gone") throw err;
}

/**
 * Per-row describes where a row that cannot be read is left out. Being refused
 * every one of them is a policy that allows the list and not the describe, not
 * an account with nothing in it, so that throws rather than pruning them all.
 */
export class UnreadableRows {
  private refusals = 0;
  private firstRefusal: unknown;

  /** Call from the catch. Rethrows anything that does not mean "no row". */
  note(err: unknown): void {
    rethrowUnlessRowUnreadable(err);
    if (classifyAwsFailure(err) !== "refused") return;
    if (this.refusals === 0) this.firstRefusal = err;
    this.refusals++;
  }

  /** Call after the loop, with how many rows were listed. */
  throwIfEveryRowRefused(listed: number): void {
    if (listed > 0 && this.refusals === listed) throw this.firstRefusal;
  }
}

/** Every region a fan-out asked refused: not the same as an account with nothing there. */
export class AwsRegionsRefusedError extends Error {
  readonly status: number | undefined;

  constructor(what: string, regions: number, refusal: unknown) {
    const detail = refusal instanceof Error ? refusal.message : String(refusal);
    super(
      `AWS refused to list ${what} in all ${regions} ${regions === 1 ? "region" : "regions"} it was asked, ` +
        `so nothing could be read. Check that this credential is allowed to read it. Last answer: ${detail}`,
      { cause: refusal },
    );
    this.name = "AwsRegionsRefusedError";
    this.status = statusOf(refusal);
  }
}

/** The error code in a non-2xx answer: the header REST-JSON uses, or the body's. */
export function awsErrorCode(headers: Headers, body: string): string | undefined {
  const header = headers.get("x-amzn-errortype")?.split(":")[0]?.trim();
  if (header) return header;
  const xml = /<Code>([^<]+)<\/Code>/.exec(body)?.[1];
  if (xml) return xml;
  const json = /"(?:__type|code|Code)"\s*:\s*"([^"]+)"/.exec(body)?.[1];
  return json?.split("#").pop();
}
