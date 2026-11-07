/** A non-2xx answer, with what `listResources` needs to tell the failures apart. */
export class DatabricksApiError extends Error {
  readonly status: number;
  readonly errorCode: string;
  readonly errorMessage: string;

  constructor(method: string, path: string, status: number, body: string) {
    super(`Databricks ${method} ${path} failed: ${status} ${body}`);
    this.name = "DatabricksApiError";
    this.status = status;
    const parsed = parseErrorBody(body);
    this.errorCode = typeof parsed?.error_code === "string" ? parsed.error_code : "";
    this.errorMessage = typeof parsed?.message === "string" ? parsed.message : "";
  }
}

function parseErrorBody(body: string): { error_code?: string; message?: string } | null {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

/**
 * This principal may not read here. Checked by code rather than by status because a 403
 * is also how Databricks answers a bad token ("error_code":"403") and a blocked IP, and
 * those have to fail the type.
 */
export function isAccessRefusal(err: unknown): boolean {
  return (
    err instanceof DatabricksApiError &&
    err.status === 403 &&
    (err.errorCode === "PERMISSION_DENIED" || err.errorCode === "INSUFFICIENT_PERMISSIONS")
  );
}

/**
 * Databricks itself says the parent is not there. A 404 with no such code came from
 * something in front of it and says nothing about the parent.
 */
export function isGone(err: unknown): boolean {
  return (
    err instanceof DatabricksApiError &&
    err.status === 404 &&
    /^(RESOURCE|CATALOG|SCHEMA)_DOES_NOT_EXIST$|^(ENDPOINT_)?NOT_FOUND$/.test(err.errorCode)
  );
}

const THROTTLE_CODES = new Set([
  "REQUEST_LIMIT_EXCEEDED",
  "RESOURCE_EXHAUSTED",
  "TOO_MANY_REQUESTS",
  "TEMPORARILY_UNAVAILABLE",
]);

/** CANNOT_ESTABLISH_CONNECTION* are the documented classes; the rest is the driver's wording. */
const CONNECTION_FAULT =
  /CANNOT_ESTABLISH_CONNECTION|connection (?:refused|reset|timed out|failed)|(?:could not|unable to|failed to) connect/i;

/**
 * A fault in a foreign catalog's connection to its external database, which lasts until
 * someone repairs it and says nothing about the rest of the account. Only an answer in
 * Databricks' own error shape counts, and never a throttle or a rejected credential,
 * which would be just as true of every other catalog.
 */
export function isForeignCatalogFault(err: unknown): boolean {
  if (!(err instanceof DatabricksApiError)) return false;
  const { status, errorCode, errorMessage } = err;
  if (!errorCode || /^\d+$/.test(errorCode) || errorCode === "UNAUTHENTICATED") return false;
  if (status === 401 || status === 429 || THROTTLE_CODES.has(errorCode)) return false;
  if (status >= 400 && status < 500) return true;
  return status >= 500 && CONNECTION_FAULT.test(`${errorCode} ${errorMessage}`);
}
