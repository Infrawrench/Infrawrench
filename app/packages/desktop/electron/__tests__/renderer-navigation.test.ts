import { describe, expect, it } from "vitest";
import { isInternalRendererUrl } from "../renderer-navigation";

const packaged = {
  indexFileUrl:
    "file:///Applications/Infrawrench.app/Contents/Resources/app.asar/out/renderer/index.html",
};

describe("isInternalRendererUrl (packaged)", () => {
  it("accepts the bundle's own index.html with any hash or query", () => {
    expect(isInternalRendererUrl(packaged.indexFileUrl, packaged)).toBe(true);
    expect(isInternalRendererUrl(`${packaged.indexFileUrl}#/settings`, packaged)).toBe(true);
    expect(isInternalRendererUrl(`${packaged.indexFileUrl}?x=1#/a`, packaged)).toBe(true);
  });

  it("refuses any other local file", () => {
    expect(isInternalRendererUrl("file:///tmp/evil.html", packaged)).toBe(false);
    expect(
      isInternalRendererUrl(
        "file:///Applications/Infrawrench.app/Contents/Resources/app.asar/out/renderer/other.html",
        packaged,
      ),
    ).toBe(false);
  });

  it("refuses a file URL with a host (a UNC path on Windows)", () => {
    expect(
      isInternalRendererUrl(
        "file://attacker.example/Applications/Infrawrench.app/Contents/Resources/app.asar/out/renderer/index.html",
        packaged,
      ),
    ).toBe(false);
  });

  it("refuses web URLs and garbage", () => {
    expect(isInternalRendererUrl("https://example.com/", packaged)).toBe(false);
    expect(isInternalRendererUrl("not a url", packaged)).toBe(false);
  });

  it("folds case only when asked to (Windows)", () => {
    const win = {
      indexFileUrl:
        "file:///C:/Program%20Files/Infrawrench/resources/app.asar/out/renderer/index.html",
      caseInsensitivePaths: true,
    };
    expect(
      isInternalRendererUrl(
        "file:///c:/program%20files/infrawrench/resources/app.asar/out/renderer/index.html",
        win,
      ),
    ).toBe(true);
    expect(
      isInternalRendererUrl(
        "file:///c:/program%20files/infrawrench/resources/app.asar/out/renderer/index.html",
        { ...win, caseInsensitivePaths: false },
      ),
    ).toBe(false);
  });
});

describe("isInternalRendererUrl (dev)", () => {
  const dev = { devServerUrl: "http://localhost:5173", indexFileUrl: packaged.indexFileUrl };

  it("accepts the dev server origin only", () => {
    expect(isInternalRendererUrl("http://localhost:5173/#/a", dev)).toBe(true);
    expect(isInternalRendererUrl("http://localhost:5173.evil.com/", dev)).toBe(false);
    expect(isInternalRendererUrl("http://localhost:5174/", dev)).toBe(false);
    expect(isInternalRendererUrl(packaged.indexFileUrl, dev)).toBe(false);
  });
});
