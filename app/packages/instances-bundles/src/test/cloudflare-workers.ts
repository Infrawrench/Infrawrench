/**
 * Stand-in for the `cloudflare:workers` module, which exists only inside
 * workerd. Vitest runs under Node, so `vitest.config.ts` aliases the import here.
 */
export class WorkerEntrypoint<Env = unknown> {
  protected ctx: ExecutionContext;
  protected env: Env;
  constructor(ctx: ExecutionContext, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}
