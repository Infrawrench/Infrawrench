import { describe, expect, it } from "vitest";
import { latestState, parseStatusFeed } from "../status-feed.js";

const item = (
  guid: string,
  title: string,
  log: string,
  link = `https://status.io/pages/incident/x/${guid}`,
) =>
  `<item><title><![CDATA[${title}]]></title><description><![CDATA[${log}]]></description><link>${link}</link><guid isPermaLink="false">${guid}</guid><pubDate>Fri, 02 Oct 2026 14:33:06 GMT</pubDate></item>`;

const feed = (items: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title><![CDATA[CoreWeave Cloud]]></title>${items}</channel></rss>`;

describe("CoreWeave status feed", () => {
  it("reports only items whose latest update is still open", () => {
    const withClosed = feed(
      item(
        "a",
        "Degraded networking - US-EAST-04A",
        "<small>Oct 2</small><br /><b>Investigating</b> - Looking into it.<br /><small>Oct 2</small><br /><b>Identified</b> - Found it.",
      ) +
        item("b", "Old outage", "<b>Investigating</b> - x<br /><b>Resolved</b> - fixed.") +
        item(
          "c",
          "Scheduled CoreWeave Power Maintenance - US-EAST-15A",
          "<b>Scheduled</b> - Details: work.",
          "https://status.io/pages/maintenance/x/c",
        ) +
        item(
          "d",
          "Scheduled CoreWeave Facilities Maintenance - US-CENTRAL-09A",
          "<b>Scheduled</b> - Details.<br /><b>Active</b> - Planned maintenance has started.",
          "https://status.io/pages/maintenance/x/d",
        ),
    );
    const incidents = parseStatusFeed(withClosed);
    expect(incidents.map((i) => i.externalId)).toEqual(["a", "d"]);
    expect(incidents[0]).toMatchObject({
      state: "identified",
      impact: "major",
      regions: ["US-EAST-04A"],
    });
    expect(incidents[1]).toMatchObject({ impact: "maintenance", regions: ["US-CENTRAL-09A"] });
  });

  it("treats an empty channel as healthy and rejects non-RSS", () => {
    expect(parseStatusFeed(feed(""))).toEqual([]);
    expect(() => parseStatusFeed("<html></html>")).toThrow(/not an RSS/);
  });

  it("finds the last state word in an update log", () => {
    expect(latestState("Investigating - a Monitoring - b")).toBe("Monitoring");
    expect(latestState("no states")).toBeUndefined();
  });
});
