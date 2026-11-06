import { installMemoryCookies } from "./memory-cookies";

/**
 * The embeds' cookies, in memory (see `memory-cookies.ts`). Import it before
 * anything from gt-react: `components/embed/EmbedI18nProvider.tsx` imports it
 * first. Framed or not: the embeds also promise to store nothing, and show no
 * consent prompt on that basis, so this applies in the mobile popup as well,
 * where a real cookie would work.
 */
installMemoryCookies();

export {};
