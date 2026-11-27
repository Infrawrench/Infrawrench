import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { GitIcon } from "../../components/icons/GitIcon.js";
import { ProductGlyph } from "../ProductIcon.js";

/** What a glyph draws, whatever element wraps it. */
const shapes = (markup: string): string[] =>
  [...markup.matchAll(/<(path|line|circle|rect)\b[^>]*>/g)].map((match) => match[0]).sort();

describe("the Git entry's icon", () => {
  it("is not the glyph of the app it sits in", () => {
    const git = shapes(renderToStaticMarkup(<GitIcon />));
    const delivery = shapes(renderToStaticMarkup(<ProductGlyph product="delivery" />));
    expect(git.length).toBeGreaterThan(0);
    expect(delivery.length).toBeGreaterThan(0);
    expect(git).not.toEqual(delivery);
    // Nothing of one is drawn in the other: side by side they read apart.
    expect(git.filter((shape) => delivery.includes(shape))).toEqual([]);
  });

  it("is drawn on the sidebar's grid", () => {
    const markup = renderToStaticMarkup(<GitIcon size={14} />);
    expect(markup).toContain('viewBox="0 0 24 24"');
    expect(markup).toContain('stroke-width="2"');
    expect(markup).toContain('aria-hidden="true"');
  });
});
