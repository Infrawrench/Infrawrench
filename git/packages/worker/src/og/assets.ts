/**
 * The renderer's WebAssembly and fonts as the Worker carries them: modules
 * of the upload (`.wasm` compiled by Cloudflare when it is deployed, `.woff`
 * as bytes; `rules` in wrangler.jsonc), so nothing is compiled or fetched
 * when a card is drawn. Tests read the same files from disk instead.
 *
 * The fonts are Inter (SIL Open Font License 1.1, `fonts/OFL.txt`), from
 * `@fontsource/inter` 5.2.8: its Latin and Latin Extended subsets at the
 * three weights the cards use.
 */
import resvg from "@resvg/resvg-wasm/index_bg.wasm";
import yoga from "satori/yoga.wasm";
import latin400 from "./fonts/inter-latin-400-normal.woff";
import latin600 from "./fonts/inter-latin-600-normal.woff";
import latin700 from "./fonts/inter-latin-700-normal.woff";
import latinExt400 from "./fonts/inter-latin-ext-400-normal.woff";
import latinExt600 from "./fonts/inter-latin-ext-600-normal.woff";
import latinExt700 from "./fonts/inter-latin-ext-700-normal.woff";
import type { RendererAssets } from "./render";

export const workerAssets: RendererAssets = {
  yoga,
  resvg,
  fonts: [
    { name: "Inter", weight: 400, data: latin400 },
    { name: "Inter", weight: 600, data: latin600 },
    { name: "Inter", weight: 700, data: latin700 },
    { name: "Inter", weight: 400, data: latinExt400 },
    { name: "Inter", weight: 600, data: latinExt600 },
    { name: "Inter", weight: 700, data: latinExt700 },
  ],
};
