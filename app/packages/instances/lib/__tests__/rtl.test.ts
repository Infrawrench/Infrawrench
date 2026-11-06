import { describe, expect, it } from "vitest";
import ar from "../../_gt/ar.json";
import he from "../../_gt/he.json";
import hi from "../../_gt/hi.json";
import { formatMoney, USD } from "../format";
import { localeDir } from "../i18n/locales";
import { translatorFor } from "../i18n/server";
import { rtlBoxes } from "../og-text";

describe("localeDir", () => {
  it("is right to left for Hebrew and Arabic only", () => {
    expect(["he", "ar"].map(localeDir)).toEqual(["rtl", "rtl"]);
    expect(["en", "hi", "ja"].map(localeDir)).toEqual(["ltr", "ltr", "ltr"]);
  });
});

describe("formatMoney", () => {
  it("keeps a lettered currency symbol whole in a right-to-left language", () => {
    expect(formatMoney(0.096, USD, "ar")).toContain("⁦US$⁩");
  });

  it("adds no controls in a left-to-right language", () => {
    expect(formatMoney(0.096, USD, "hi")).not.toMatch(/[⁦-⁩]/);
    expect(formatMoney(0.096, USD, "en")).toBe("$0.096");
  });
});

describe("rtlBoxes", () => {
  it("keeps each right-to-left word in its own box", () => {
    expect(rtlBoxes("מחיר לשעה")).toEqual([["מחיר"], ["לשעה"]]);
  });

  it("keeps neighbouring Latin words together and in order", () => {
    expect(rtlBoxes("מחיר m5.large (AWS) לשעה")).toEqual([["מחיר"], ["m5.large (AWS)"], ["לשעה"]]);
  });

  it("splits a mixed word at its script boundary, with the separator on its own", () => {
    expect(rtlBoxes("$0.037/ساعة")).toEqual([["$0.037", "/", "ساعة"]]);
    expect(rtlBoxes("ב-m5.large")).toEqual([["ב", "-", "m5.large"]]);
  });

  it("mirrors a parenthesis that opens or closes around right-to-left text", () => {
    expect(rtlBoxes("(12 אזורים)")).toEqual([
      [")", "12"],
      ["אזורים", "("],
    ]);
  });

  it("drops bidi controls, which the boxes make redundant", () => {
    expect(rtlBoxes("‏0.096 ⁦US$⁩")).toEqual([["0.096 US$"]]);
  });
});

describe("the right-to-left and Hindi catalogs", () => {
  const catalogs = { he, ar, hi } as Record<string, Record<string, unknown>>;

  it("hold plurals that format for every count the languages distinguish", () => {
    const source = "Offered in {count, plural, one {# region} other {# regions}}";
    for (const [locale, catalog] of Object.entries(catalogs)) {
      const tr = translatorFor(locale, catalog as Record<string, string>);
      for (const count of [0, 1, 2, 3, 11, 100]) {
        const out = tr(source, { count });
        expect(out).not.toContain("{");
        // A missing catalog entry would fall back to the English source.
        expect(out).not.toMatch(/region|Offered/);
        // Arabic's and Hebrew's small counts can live in the word itself.
        if (count > 2) expect(out).toContain(String(count));
      }
    }
  });
});
