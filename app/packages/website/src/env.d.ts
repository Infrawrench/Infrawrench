/// <reference types="astro/client" />

declare namespace Cloudflare {
  interface Env {
    GITHUB_TOKEN: string;
    GITHUB_OWNER: string;
    GITHUB_REPO: string;
  }
}

interface Env extends Cloudflare.Env {}

interface CacheStorage {
  readonly default: Cache;
}
