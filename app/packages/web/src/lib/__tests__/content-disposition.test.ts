import { describe, it, expect } from "vitest";
import { attachmentDisposition } from "../content-disposition";

describe("attachmentDisposition", () => {
  it("passes a plain filename through", () => {
    expect(attachmentDisposition("report.csv")).toBe(
      `attachment; filename="report.csv"; filename*=UTF-8''report.csv`,
    );
  });

  it("neutralizes a quote that would break out of the quoted string", () => {
    // `;` may stay — it's harmless inside a quoted-string. The quotes are what
    // would end the value early and let an attacker append their own params.
    expect(attachmentDisposition('a";x="y')).toContain('filename="a_;x=_y"');
  });

  it("strips CR/LF so the header can't be split", () => {
    const header = attachmentDisposition("a\r\nSet-Cookie: b=c");
    expect(header).not.toContain("\r");
    expect(header).not.toContain("\n");
  });

  it("strips backslashes, which are escape characters in a quoted-string", () => {
    expect(attachmentDisposition("a\\b")).toContain('filename="a_b"');
  });

  it("keeps the exact original in the RFC 5987 form", () => {
    const header = attachmentDisposition("résumé.pdf");
    expect(header).toContain("filename*=UTF-8''r%C3%A9sum%C3%A9.pdf");
    // …while the ASCII fallback stays representable.
    expect(header).toContain('filename="r_sum_.pdf"');
  });

  it("falls back to a usable name when nothing survives sanitizing", () => {
    expect(attachmentDisposition("   ")).toContain('filename="download"');
  });
});
