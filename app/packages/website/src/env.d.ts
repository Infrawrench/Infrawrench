/// <reference types="astro/client" />

interface ImportMetaEnv {
  /** PostHog project API key (phc_…), inlined at build time. Unset turns analytics off. */
  readonly PUBLIC_POSTHOG_KEY?: string;
  /** PostHog ingestion host; defaults to US Cloud. */
  readonly PUBLIC_POSTHOG_HOST?: string;
}

declare module "typewriter-effect/dist/core" {
  interface TypewriterOptions {
    strings?: string[];
    autoStart?: boolean;
    loop?: boolean;
    delay?: number;
    deleteSpeed?: number;
    cursor?: string;
    wrapperClassName?: string;
    cursorClassName?: string;
    stringSplitter?: (text: string) => string[];
    onCreateTextNode?: (character: string) => Text | null;
    onRemoveNode?: (args: { node?: Node; charater?: string }) => void;
  }
  class Typewriter {
    constructor(element: string | HTMLElement, options?: TypewriterOptions);
  }
  export default Typewriter;
}

declare namespace Cloudflare {
  interface Env {
    /** Optional: raises the GitHub rate limit. The repo is public, so calls work without it. */
    GITHUB_TOKEN?: string;
    GITHUB_OWNER: string;
    GITHUB_REPO: string;
  }
}

interface Env extends Cloudflare.Env {}

interface CacheStorage {
  readonly default: Cache;
}
