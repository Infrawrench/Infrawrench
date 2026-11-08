/**
 * The refusal `requireScope` (`./api-auth.ts`) throws for a bearer credential
 * whose scopes lack the one a route needs. Its own light module so a handler
 * can recognise it without loading `api-auth.ts`, which loads the WorkOS
 * client (see `http/bearer-caller.ts`).
 */
export class MissingScopeError extends Error {
  /** Always a 403: an authorization failure, never a server fault. */
  readonly status = 403;
  constructor(readonly scope: string) {
    super(`Missing required scope: ${scope}`);
    this.name = "MissingScopeError";
  }
}
