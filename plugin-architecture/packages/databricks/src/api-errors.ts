/** A non-2xx answer, with what `listResources` needs to tell the failures apart. */
export class DatabricksApiError extends Error {
  readonly status: number;
  readonly errorCode: string;

  constructor(method: string, path: string, status: number, body: string) {
    super(`Databricks ${method} ${path} failed: ${status} ${body}`);
    this.name = "DatabricksApiError";
    this.status = status;
    this.errorCode = errorCodeOf(body);
  }
}

function errorCodeOf(body: string): string {
  try {
    const parsed: { error_code?: string } | null = JSON.parse(body);
    return typeof parsed?.error_code === "string" ? parsed.error_code : "";
  } catch {
    return "";
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
