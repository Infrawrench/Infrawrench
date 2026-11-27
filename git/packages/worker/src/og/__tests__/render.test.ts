/**
 * Every card drawn by the real renderer: a 1200x630 PNG each, deterministic,
 * and with the pictures it was given. `OG_CARDS_OUT=<dir>` also writes each
 * one there, to look at.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { cardImageUrls, cardNode } from "../card";
import { cardImages } from "../images";
import { cardOf } from "../meta";
import { type RendererAssets, renderCard } from "../render";
import { FIXTURES, nodeAssets, ownAsset } from "./fixtures";

let assets: RendererAssets;

beforeAll(async () => {
  assets = await nodeAssets();
});

/** Width and height from a PNG's header. */
const pngSize = (png: Uint8Array) => {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
};

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

describe("card images", () => {
  for (const [name, facts] of Object.entries(FIXTURES)) {
    it(`draws the ${name} card at 1200x630`, async () => {
      const { card } = cardOf(facts);
      const images = await cardImages(cardImageUrls(card), {
        fetch: async () => new Response("no network in tests", { status: 503 }),
        siteHosts: ["git.infrawrench.com"],
        assets: {
          fetch: async (request) =>
            ownAsset(new URL((request as unknown as Request).url).pathname) as never,
        },
        origin: "https://git.infrawrench.com",
      });
      const png = await renderCard(cardNode(card, images), assets);
      expect([...png.slice(0, 8)]).toEqual(PNG_SIGNATURE);
      expect(pngSize(png)).toEqual({ width: 1200, height: 630 });
      // A bot's own picture is read from the UI's files, never from the network.
      for (const url of cardImageUrls(card)) {
        if (url.startsWith("/assets/")) expect(images.has(url)).toBe(true);
      }
      const out = process.env["OG_CARDS_OUT"];
      if (out) {
        mkdirSync(out, { recursive: true });
        writeFileSync(join(out, `${name}.png`), png);
      }
    });
  }

  it("draws the same bytes for the same card", async () => {
    const { card } = cardOf(FIXTURES["issue"]!);
    const [first, second] = [
      await renderCard(cardNode(card), assets),
      await renderCard(cardNode(card), assets),
    ];
    expect(Buffer.from(first).equals(Buffer.from(second))).toBe(true);
  });
});
