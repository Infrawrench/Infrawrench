/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** General Translation project id — dev-only live machine translation. */
  readonly VITE_GT_PROJECT_ID?: string;
  /** General Translation development API key (gtx-dev-…) — never a production key. */
  readonly VITE_GT_DEV_API_KEY?: string;
}
