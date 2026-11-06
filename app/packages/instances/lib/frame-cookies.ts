import { installMemoryCookies } from "./memory-cookies";

/**
 * The site's cookies when another page frames it, where a cross-site frame
 * cannot write them (see `memory-cookies.ts`). A top-level page is untouched.
 * Import it before anything from gt-react: `components/I18nProvider.tsx` does.
 */
if (typeof window !== "undefined" && window.self !== window.top) installMemoryCookies();

export {};
