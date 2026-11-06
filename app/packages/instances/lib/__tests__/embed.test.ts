import { afterEach, describe, expect, it, vi } from "vitest";
import { embedPath, getInfrawrenchUrl, playerCardTags } from "../embed";

describe("player cards", () => {
  it("name an absolute, locale-prefixed player", () => {
    expect(playerCardTags("fr", "/aws/ec2/m5.large")).toEqual({
      "twitter:player": "https://instances.infrawrench.com/embed/fr/aws/ec2/m5.large",
      "twitter:player:width": "640",
      "twitter:player:height": "480",
    });
  });

  it("keep the English prefix, which only proxy.ts would strip", () => {
    expect(embedPath("en", "/v/abc")).toBe("/embed/en/v/abc");
  });
});

describe("the call to action", () => {
  it("opens the download dialog, tagged with the embed", () => {
    const url = new URL(getInfrawrenchUrl("view"));
    expect(url.origin).toBe("https://infrawrench.com");
    expect(url.hash).toBe("#download");
    expect(url.searchParams.get("utm_source")).toBe("x");
    expect(url.searchParams.get("utm_content")).toBe("view");
  });
});

describe("the embeds' cookie jar", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("keeps cookies in memory, without their attributes", async () => {
    const document = {} as { cookie: string };
    vi.stubGlobal("document", document);
    vi.resetModules();
    await import("../embed-cookies");
    document.cookie = "generaltranslation.locale=fr;path=/";
    document.cookie = "other=1; Max-Age=60";
    expect(document.cookie).toBe("generaltranslation.locale=fr; other=1");
    document.cookie = "generaltranslation.locale=de;path=/";
    expect(document.cookie).toBe("generaltranslation.locale=de; other=1");
  });
});

describe("the site's cookies in a frame", () => {
  afterEach(() => vi.unstubAllGlobals());

  async function load(framed: boolean) {
    const document = { cookie: "real=1" } as { cookie: string };
    const self = {};
    vi.stubGlobal("document", document);
    vi.stubGlobal("window", { self, top: framed ? {} : self });
    vi.resetModules();
    await import("../frame-cookies");
    document.cookie = "generaltranslation.locale=he;path=/";
    return document.cookie;
  }

  it("stay in memory inside a frame, where a cross-site page cannot write them", async () => {
    expect(await load(true)).toBe("generaltranslation.locale=he");
  });

  it("are left alone in a top-level page", async () => {
    expect(await load(false)).toBe("generaltranslation.locale=he;path=/");
  });
});
