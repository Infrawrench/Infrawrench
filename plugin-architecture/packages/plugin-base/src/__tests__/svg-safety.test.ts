import { describe, expect, it } from "vitest";

import { findUnsafeSvgConstructs, isInertSvg } from "../svg-safety.js";
import { pluginManifestSchema } from "../validation/index.js";

/**
 * The shapes real plugin logos take. Every construct here appears in at least
 * one of the 49 bundled manifests, so a rule that rejects any of these would be
 * a rule that breaks the product — which is the other half of what this file
 * is for.
 */
const REAL_LOGO_SHAPES: ReadonlyArray<readonly [string, string]> = [
  ["the empty logo used by test fixtures", "<svg/>"],
  [
    "a rounded-rect canvas wrapping a scaled glyph",
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
      <rect width="100" height="100" rx="12" fill="#232F3E"/>
      <g transform="translate(8,14) scale(3.5)" fill="#FF9900">
        <path d="M6.763 10.036c0 .296.032.535.088.71z"/>
      </g>
    </svg>`,
  ],
  [
    "a gradient referenced by fragment",
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
      <defs>
        <radialGradient id="g" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse"
          gradientTransform="translate(4 8) rotate(45) scale(90)">
          <stop offset="0" stop-color="#1C7DFF"/>
          <stop offset="1" stop-color="#9977EE" stop-opacity="0"/>
        </radialGradient>
      </defs>
      <rect width="100" height="100" rx="12" fill="url(#g)"/>
    </svg>`,
  ],
  [
    "a clip path referenced by fragment",
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
      <clipPath id="c"><rect width="60" height="60"/></clipPath>
      <g clip-path="url(#c)" fill-rule="evenodd" clip-rule="evenodd">
        <path d="M0 0h10v10H0z"/>
      </g>
    </svg>`,
  ],
  [
    "a wordmark drawn with <text>",
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" role="img">
      <rect width="100" height="100" rx="12" fill="#111"/>
      <text x="50" y="62" text-anchor="middle" font-family="Helvetica, Arial, sans-serif"
        font-size="38" font-weight="700" fill="#fff" opacity="0.9">IW</text>
    </svg>`,
  ],
  [
    "a polygon with a stroke and an accessible title",
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
      <title>Example</title>
      <desc>A polygon</desc>
      <polygon points="50,10 90,90 10,90" fill="none" stroke="#fff"/>
    </svg>`,
  ],
  [
    "a same-document <use> reference",
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 100 100">
      <defs><path id="p" d="M0 0h10v10H0z"/></defs>
      <use href="#p" fill="#fff"/>
      <use xlink:href="#p" transform="translate(20,0)" fill="#fff"/>
    </svg>`,
  ],
  [
    "a drop-shadow filter",
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
      <filter id="f"><feDropShadow dx="0" dy="1" stdDeviation="2"/></filter>
      <rect width="100" height="100" rx="12" fill="#fff" filter="url(#f)"/>
    </svg>`,
  ],
  ["a logo with leading and trailing whitespace", "\n  <svg viewBox='0 0 1 1'></svg>\n  "],
  [
    "a logo with an XML comment",
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
      <!-- traced from the vendor's press kit -->
      <rect width="100" height="100" fill="#000"/>
    </svg>`,
  ],
];

/**
 * One entry per construct the rule exists to stop. Each is a real XSS shape
 * rather than a synthetic one, and each is listed separately so a regression
 * says which defence came off.
 */
const UNSAFE_LOGOS: ReadonlyArray<readonly [string, string]> = [
  ["a <script> element", `<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`],
  [
    "a <script> element in mixed case",
    `<svg xmlns="http://www.w3.org/2000/svg"><ScRiPt>alert(1)</ScRiPt></svg>`,
  ],
  [
    "a <foreignObject> re-entering HTML parsing",
    `<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><img src=x onerror="alert(1)"></foreignObject></svg>`,
  ],
  [
    "HTML smuggled through <desc>, an HTML integration point",
    `<svg xmlns="http://www.w3.org/2000/svg"><desc><img src="x" onerror="alert(1)"></desc></svg>`,
  ],
  ["an <iframe>", `<svg xmlns="http://www.w3.org/2000/svg"><iframe src="//evil"></iframe></svg>`],
  [
    "an <image> fetching an external document",
    `<svg xmlns="http://www.w3.org/2000/svg"><image href="//evil/x.png"/></svg>`,
  ],
  [
    "a <use> pulling in an external document",
    `<svg xmlns="http://www.w3.org/2000/svg"><use href="https://evil.example/x.svg#a"/></svg>`,
  ],
  [
    "a <use> with a protocol-relative xlink:href",
    `<svg xmlns="http://www.w3.org/2000/svg"><use xlink:href="//evil.example/x.svg#a"/></svg>`,
  ],
  [
    "an onload handler on the root element",
    `<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><rect width="1" height="1"/></svg>`,
  ],
  [
    "an ONCLICK handler in upper case",
    `<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1" ONCLICK="alert(1)"/></svg>`,
  ],
  [
    "an onerror handler with an unquoted value",
    `<svg xmlns="http://www.w3.org/2000/svg"><rect width=1 height=1 onerror=alert(1)/></svg>`,
  ],
  [
    "a javascript: href on an <a>",
    `<svg xmlns="http://www.w3.org/2000/svg"><a href="javascript:alert(1)"><rect width="1" height="1"/></a></svg>`,
  ],
  [
    "a javascript: scheme smuggled through a numeric entity",
    `<svg xmlns="http://www.w3.org/2000/svg"><use href="&#106;avascript:alert(1)"/></svg>`,
  ],
  [
    "a javascript: scheme broken up with a tab",
    `<svg xmlns="http://www.w3.org/2000/svg"><use href="java&#9;script:alert(1)"/></svg>`,
  ],
  [
    "a data: URL in href",
    `<svg xmlns="http://www.w3.org/2000/svg"><use href="data:image/svg+xml;base64,PHN2Zz48L3N2Zz4="/></svg>`,
  ],
  [
    "a fill pointing at an external paint server",
    `<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1" fill="url(https://evil.example/x.svg#g)"/></svg>`,
  ],
  [
    "a style attribute fetching a background",
    `<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1" style="background:url(https://evil.example/beacon.png)"/></svg>`,
  ],
  [
    "a style attribute using -moz-binding",
    `<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1" style="-moz-binding:url(#x)"/></svg>`,
  ],
  [
    "a <style> element that can @import",
    `<svg xmlns="http://www.w3.org/2000/svg"><style>@import url(//evil.example/x.css);</style></svg>`,
  ],
  [
    "an <animate> rewriting an href at runtime",
    `<svg xmlns="http://www.w3.org/2000/svg"><use href="#a"><animate attributeName="href" to="javascript:alert(1)"/></use></svg>`,
  ],
  [
    "a <set> element",
    `<svg xmlns="http://www.w3.org/2000/svg"><set attributeName="href" to="javascript:alert(1)"/></svg>`,
  ],
  [
    "an <object> element",
    `<svg xmlns="http://www.w3.org/2000/svg"><object data="//evil.example/x.html"></object></svg>`,
  ],
  [
    "an <embed> element",
    `<svg xmlns="http://www.w3.org/2000/svg"><embed src="//evil.example/x.swf"></embed></svg>`,
  ],
  [
    "a <handler> element",
    `<svg xmlns="http://www.w3.org/2000/svg"><handler type="text/javascript">alert(1)</handler></svg>`,
  ],
  [
    "an entity declaration",
    `<!DOCTYPE svg [<!ENTITY x "boom">]><svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>`,
  ],
  [
    "a stylesheet processing instruction",
    `<?xml-stylesheet type="text/css" href="//evil.example/x.css"?><svg xmlns="http://www.w3.org/2000/svg"/>`,
  ],
  [
    "a CDATA section",
    `<svg xmlns="http://www.w3.org/2000/svg"><![CDATA[<script>alert(1)</script>]]></svg>`,
  ],
  ["markup that does not start with <svg", `<div><svg xmlns="http://www.w3.org/2000/svg"/></div>`],
  ["markup smuggled after the closing tag", `<svg viewBox="0 0 1 1"></svg><img src=x onerror=1>`],
  ["an unclosed element", `<svg xmlns="http://www.w3.org/2000/svg"><g fill="#fff"></svg>`],
  ["a stray < that opens nothing", `<svg xmlns="http://www.w3.org/2000/svg">a < b</svg>`],
  ["an empty string", ""],
  ["whitespace only", "   \n  "],
  ["a plain string that is not markup at all", "not an svg"],
];

describe("findUnsafeSvgConstructs", () => {
  describe("accepts the shapes real plugin logos use", () => {
    for (const [label, svg] of REAL_LOGO_SHAPES) {
      it(label, () => {
        expect(findUnsafeSvgConstructs(svg)).toEqual([]);
        expect(isInertSvg(svg)).toBe(true);
      });
    }
  });

  describe("rejects", () => {
    for (const [label, svg] of UNSAFE_LOGOS) {
      it(label, () => {
        expect(findUnsafeSvgConstructs(svg).length).toBeGreaterThan(0);
        expect(isInertSvg(svg)).toBe(false);
      });
    }
  });

  it("names the construct it rejected", () => {
    const [problem] = findUnsafeSvgConstructs(
      `<svg xmlns="http://www.w3.org/2000/svg"><foreignObject/></svg>`,
    );
    expect(problem).toContain("foreignObject");
  });

  it("terminates on pathological input rather than hanging", () => {
    const deep = `<svg viewBox="0 0 1 1">${"<g>".repeat(2000)}${"</g>".repeat(2000)}</svg>`;
    expect(findUnsafeSvgConstructs(deep)).toEqual([]);
  });
});

/**
 * The predicate is only worth anything if the manifest schema actually applies
 * it — both loaders drop a plugin whose manifest fails to parse, and that drop
 * is the enforcement.
 */
describe("pluginManifestSchema logoSvg refinement", () => {
  const manifest = {
    id: "example",
    version: "1.0.0",
    displayName: "Example",
    logoSvg: "<svg/>",
    author: "Infrawrench",
    minHostVersion: "0.1.0",
    credentialFields: [],
  };

  it("accepts an inert logo", () => {
    expect(pluginManifestSchema.safeParse(manifest).success).toBe(true);
  });

  it("rejects a logo carrying a script", () => {
    const result = pluginManifestSchema.safeParse({
      ...manifest,
      logoSvg: `<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.message.includes("logoSvg is not inert"))).toBe(
        true,
      );
    }
  });

  it("rejects a logo carrying an event handler", () => {
    expect(
      pluginManifestSchema.safeParse({
        ...manifest,
        logoSvg: `<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>`,
      }).success,
    ).toBe(false);
  });

  it("still rejects an empty logo", () => {
    expect(pluginManifestSchema.safeParse({ ...manifest, logoSvg: "" }).success).toBe(false);
  });
});
