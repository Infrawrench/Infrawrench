import { describe, expect, it } from "vitest";
import { safeRelativePathSegments } from "../download-paths";

describe("safeRelativePathSegments", () => {
  it("splits ordinary nested paths", () => {
    expect(safeRelativePathSegments("report.csv")).toEqual(["report.csv"]);
    expect(safeRelativePathSegments("logs/2026/app.log")).toEqual(["logs", "2026", "app.log"]);
    expect(safeRelativePathSegments("..hidden/file..txt")).toEqual(["..hidden", "file..txt"]);
  });

  it("rejects parent and current directory segments", () => {
    expect(safeRelativePathSegments("..")).toBeNull();
    expect(safeRelativePathSegments("../x")).toBeNull();
    expect(safeRelativePathSegments("a/../../x")).toBeNull();
    expect(safeRelativePathSegments("./x")).toBeNull();
  });

  it("rejects absolute and empty paths", () => {
    expect(safeRelativePathSegments("")).toBeNull();
    expect(safeRelativePathSegments("/etc/passwd")).toBeNull();
    expect(safeRelativePathSegments("a//b")).toBeNull();
    expect(safeRelativePathSegments("a/")).toBeNull();
  });

  it("rejects Windows separators, drives and NULs", () => {
    expect(safeRelativePathSegments("..\\Startup\\x.bat")).toBeNull();
    expect(safeRelativePathSegments("a\\b")).toBeNull();
    expect(safeRelativePathSegments("C:x")).toBeNull();
    expect(safeRelativePathSegments("C:\\Windows\\x")).toBeNull();
    expect(safeRelativePathSegments("file:stream")).toBeNull();
    expect(safeRelativePathSegments("a\0b")).toBeNull();
  });
});
