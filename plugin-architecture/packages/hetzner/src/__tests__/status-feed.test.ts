import { describe, expect, it } from "vitest";
import { extractLocations, parseStatusFeed } from "../status-feed.js";

describe("extractLocations", () => {
  it("matches unambiguous slugs case-insensitively", () => {
    expect(extractLocations("outage in FSN1 and nbg1")).toEqual(
      expect.arrayContaining(["fsn1", "nbg1"]),
    );
  });

  it("matches ambiguous codes with location-like context, case-insensitive", () => {
    expect(extractLocations("Location: Ash network issues")).toEqual(["ash"]);
    expect(extractLocations("DC: hil degraded")).toEqual(["hil"]);
    expect(extractLocations("Standort sin")).toEqual(["sin"]);
    expect(extractLocations("problem in (ash)")).toEqual(["ash"]);
  });

  it("matches standalone ambiguous codes only when uppercase", () => {
    expect(extractLocations("ASH region offline")).toEqual(["ash"]);
    expect(extractLocations("ash tree fell on a cable")).toEqual([]);
    expect(extractLocations("hil is a common German name")).toEqual([]);
  });
});

describe("parseStatusFeed", () => {
  it("extracts Location: Ash from an Atom entry", () => {
    const published = new Date().toISOString();
    const body = `<?xml version="1.0" encoding="utf-8"?>
      <feed xmlns="http://www.w3.org/2005/Atom">
        <entry>
          <id>inc-1</id>
          <title>Network degradation</title>
          <updated>${published}</updated>
          <summary>Location: Ash — elevated packet loss</summary>
        </entry>
      </feed>`;
    const incidents = parseStatusFeed(body);
    expect(incidents).toHaveLength(1);
    expect(incidents[0]?.regions).toEqual(["ash"]);
    expect(incidents[0]?.providerWide).toBeUndefined();
  });
});
