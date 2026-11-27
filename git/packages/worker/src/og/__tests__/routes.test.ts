/**
 * A link preview image's address has three ends (CLAUDE.md, the forge's
 * section): the contract that builds it, the Worker's router and the
 * development server's proxy list. All three agree here.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { OG_IMAGE_PATH, ogImagePath } from "@infrawrench/git-contract";
import { routeOf } from "../../http/router";
import { parseOgImagePath } from "../mount";

const PATHS = [
  ogImagePath("0123456789abcdef", "/"),
  ogImagePath("0123456789abcdef", "/acme"),
  ogImagePath("0123456789abcdef", "/acme/infra"),
  ogImagePath("0123456789abcdef", "/acme/infra/branches/feature/a"),
];

describe("a link preview image's address", () => {
  it("is built under the image path and read back by the route", () => {
    expect(PATHS[0]).toBe(`${OG_IMAGE_PATH}/0123456789abcdef`);
    for (const path of PATHS) {
      expect(routeOf(path).kind, path).toBe("og-image");
      expect(parseOgImagePath(path), path).not.toBeNull();
    }
  });

  it("is proxied to the Worker by the development server", () => {
    const config = readFileSync(new URL("../../../../web/vite.config.ts", import.meta.url), "utf8");
    const patterns = [...config.matchAll(/^\s*"(\^[^"]+)": WORKER,/gm)].map(
      (match) => new RegExp(JSON.parse(`"${match[1]}"`) as string),
    );
    for (const path of PATHS) {
      expect([path, patterns.some((pattern) => pattern.test(path))]).toEqual([path, true]);
    }
  });
});
