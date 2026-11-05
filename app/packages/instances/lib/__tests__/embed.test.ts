import { afterEach, describe, expect, it, vi } from "vitest";
import { embedPath, getInfrawrenchUrl, instanceHasPlayerCard, playerCardTags } from "../embed";
import { instancePath } from "../platforms";

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

  it("match the rollout list against real instance paths", () => {
    expect(instanceHasPlayerCard(instancePath("ec2", "m5.large"))).toBe(true);
    expect(instanceHasPlayerCard(instancePath("ec2", "m5.xlarge"))).toBe(false);
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
