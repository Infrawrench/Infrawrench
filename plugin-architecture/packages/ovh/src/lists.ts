import { reportUnreadListPart, requireListPage } from "@infrawrench/plugin-base";

function stringField(body: unknown, key: string): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const value: unknown = Reflect.get(body, key);
  return typeof value === "string" ? value : undefined;
}

function parsed(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

/** A non-2xx answer from the OVH API. Its message stays the one callers already match. */
export class OvhApiError extends Error {
  /** Read by the poller's error classification, which trusts it over digits in the text. */
  readonly status: number;
  /** Set by the authentication layer, as in `NOT_GRANTED_CALL` or `INVALID_CREDENTIAL`. */
  readonly errorCode: string | undefined;
  /** Set by the API behind it, as in `Client::Forbidden`. */
  readonly errorClass: string | undefined;

  constructor(path: string, status: number, body: string) {
    super(`OVH API error ${status} for ${path}: ${body}`);
    this.name = "OvhApiError";
    this.status = status;
    const answer = parsed(body);
    this.errorCode = stringField(answer, "errorCode");
    this.errorClass = stringField(answer, "class");
  }
}

/**
 * This credential may not read this: an access rule (`NOT_GRANTED_CALL`) or IAM
 * (`Client::Forbidden`). A key that is invalid or expired also answers 403, with
 * `INVALID_CREDENTIAL`, `NOT_CREDENTIAL` or `INVALID_KEY`, and that is not this.
 */
export function isAccessRefusal(err: unknown): boolean {
  if (!(err instanceof OvhApiError) || err.status !== 403) return false;
  if (err.errorCode) return err.errorCode === "NOT_GRANTED_CALL" || err.errorCode === "FORBIDDEN";
  return err.errorClass?.startsWith("Client::Forbidden") ?? false;
}

export function isMissingRoute(err: unknown): boolean {
  return err instanceof OvhApiError && err.status === 404;
}

/**
 * A 400 from the API rather than from the signature check, whose answers carry an
 * `errorCode` (`INVALID_SIGNATURE`, `QUERY_TIME_OUT_OF_BOUNDS`). These reads send
 * nothing a caller chose, so it says the thing asked for is not on offer here.
 */
export function isDeclinedRequest(err: unknown): boolean {
  return err instanceof OvhApiError && err.status === 400 && !err.errorCode;
}

/** One read whose whole answer is a list. An answer that is not one is never read as none. */
export async function readList<T>(
  fetch: <R>(path: string) => Promise<R>,
  path: string,
): Promise<T[]> {
  return requireListPage(await fetch<T[]>(path), { vendor: "OVH", path, key: null });
}

/** A credential refused a whole type: its stored rows stay, with no error. */
export function reportTypeUnread(): void {
  reportUnreadListPart({ idPrefixes: [""] });
}

/**
 * One list per region of `typeId`, whose rows have ids of `{accountId}:{typeId}:{region}/…`.
 * Everything except an answer about the region itself fails the type, which keeps the
 * stored rows: a sync prunes what a list stops returning.
 *
 * - 404: `/region` also names regions without this service, such as the storage-only
 *   GRA for floating IPs, and those have no such route. None.
 * - A refusal, or a 400: the region's rows stay, in case it has some. OVH documents no
 *   answer for a region without a service, so a 400 may mean that or something passing,
 *   and keeping the rows is right either way. A 400 from every region is the request
 *   itself being wrong, not anything about a region, so that fails the type.
 */
export async function perRegion<T>(
  regions: string[],
  typeId: string,
  accountId: string,
  read: (region: string) => Promise<T[]>,
): Promise<T[]> {
  const refused: string[] = [];
  const declined: Array<{ region: string; err: unknown }> = [];
  const results = await Promise.all(
    regions.map(async (region) => {
      try {
        return await read(region);
      } catch (err) {
        if (isMissingRoute(err)) return [];
        if (isAccessRefusal(err)) refused.push(region);
        else if (isDeclinedRequest(err)) declined.push({ region, err });
        else throw err;
        return [];
      }
    }),
  );
  const first = declined[0];
  if (first && declined.length === regions.length) throw first.err;
  const unread = [...refused, ...declined.map((d) => d.region)];
  if (unread.length === regions.length && unread.length > 0) {
    reportTypeUnread();
  } else if (unread.length > 0) {
    reportUnreadListPart({ idPrefixes: unread.map((r) => `${accountId}:${typeId}:${r}/`) });
  }
  return results.flat();
}
