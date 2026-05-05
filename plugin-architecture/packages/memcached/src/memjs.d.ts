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
  interface StatsResult {
    server: string;
    stats: Record<string, string>;
  }
  class Client {
    static create(servers?: string, options?: ClientOptions): Client;
    get(key: string): Promise<GetResult>;
    set(key: string, value: string | Buffer, options?: SetOptions): Promise<boolean>;
    delete(key: string): Promise<boolean>;
    stats(): Promise<StatsResult[]>;
    flush(): Promise<void>;
    quit(): void;
  }
  export = { Client };
}
