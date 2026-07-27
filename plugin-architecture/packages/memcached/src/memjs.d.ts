declare module "memjs" {
  interface ClientOptions {
    timeout?: number;
    retries?: number;
    expires?: number;
  }
  interface SetOptions {
    expires?: number;
  }
  interface GetResult {
    value: Buffer | null;
    flags: Buffer | null;
  }
  /**
   * `stats` is the one command memjs never promisified. It takes a required
   * callback that fires **once per server** — and once more with a null
   * `server` to signal the end of the walk — so there is no single value to
   * resolve. See `lib/memjs/memjs.js` (`Client.prototype.stats`), which
   * forwards straight to `statsWithKey('', callback)`.
   */
  type StatsCallback = (
    err: Error | null,
    server: string | null,
    stats: Record<string, string> | null,
  ) => void;
  class Client {
    static create(servers?: string, options?: ClientOptions): Client;
    get(key: string): Promise<GetResult>;
    set(key: string, value: string | Buffer, options?: SetOptions): Promise<boolean>;
    delete(key: string): Promise<boolean>;
    stats(callback: StatsCallback): void;
    /** Resolves to a per-server map of `"host:port"` → `true` or the error. */
    flush(): Promise<Record<string, true | Error>>;
    quit(): void;
  }
  export = { Client };
}
