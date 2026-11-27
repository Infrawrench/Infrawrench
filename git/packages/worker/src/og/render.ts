/**
 * A card as a PNG: Satori lays it out and turns its text into paths (an
 * SVG), and resvg draws that at 1200x630. Both are WebAssembly, handed in
 * compiled (`./assets.ts` in the Worker, where a module must be compiled at
 * upload and never from bytes at run time; the files themselves in tests),
 * with the fonts.
 *
 * Loaded only by the image route, on first use: none of it is start-up work.
 */
import { Resvg, initWasm } from "@resvg/resvg-wasm";
import satori, { init as initSatori } from "satori/standalone";
import { OG_IMAGE_SIZE } from "@infrawrench/git-contract";
import type { Node } from "./card";

export interface CardFont {
  readonly name: string;
  readonly weight: 400 | 600 | 700;
  readonly data: ArrayBuffer;
}

export interface RendererAssets {
  /** Satori's layout engine (`satori/yoga.wasm`). */
  readonly yoga: WebAssembly.Module;
  /** resvg (`@resvg/resvg-wasm/index_bg.wasm`). */
  readonly resvg: WebAssembly.Module;
  readonly fonts: readonly CardFont[];
}

let ready: Promise<void> | null = null;

/** Both engines started, once per isolate. A failed start is tried again next time. */
const start = (assets: RendererAssets): Promise<void> => {
  ready ??= Promise.all([initSatori(assets.yoga), initWasm(assets.resvg)]).then(
    () => undefined,
    (error: unknown) => {
      ready = null;
      throw error;
    },
  );
  return ready;
};

/** The SVG Satori makes of `node`. */
export async function cardSvg(node: Node, assets: RendererAssets): Promise<string> {
  await start(assets);
  return satori(node as never, {
    width: OG_IMAGE_SIZE.width,
    height: OG_IMAGE_SIZE.height,
    fonts: assets.fonts.map((font) => ({
      name: font.name,
      weight: font.weight,
      style: "normal" as const,
      data: font.data,
    })),
  });
}

/** `node` drawn as a 1200x630 PNG. */
export async function renderCard(node: Node, assets: RendererAssets): Promise<Uint8Array> {
  const svg = await cardSvg(node, assets);
  const resvg = new Resvg(svg, { fitTo: { mode: "original" } });
  try {
    const image = resvg.render();
    try {
      return image.asPng();
    } finally {
      image.free();
    }
  } finally {
    resvg.free();
  }
}
