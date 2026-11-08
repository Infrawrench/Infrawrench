/**
 * An already-shaped error response that is not one of the API's error
 * classes (`BadRequest`, `NotFound`, ... in `@infrawrench/api-contract`),
 * such as the auth chain's refusals, which keep whatever status and body the
 * original middleware sent. Server-only: no endpoint declares it.
 */
export class HttpFailure extends Error {
  readonly status: number;
  readonly body: Readonly<Record<string, unknown>>;
  constructor(status: number, body: Readonly<Record<string, unknown>>) {
    super(typeof body["error"] === "string" ? body["error"] : `HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}
