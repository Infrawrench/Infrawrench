import { describe, expect, it } from "vitest";
import { formatDuration, formatMoney, formatMoneyDelta } from "../amounts";
import { PLAIN, parseAnsiLine, stripAnsi } from "../ansi";

const ESC = "\u001b[";

describe("parseAnsiLine", () => {
  it("leaves plain text as one plain span", () => {
    expect(parseAnsiLine("hello").spans).toEqual([{ ...PLAIN, text: "hello" }]);
    expect(parseAnsiLine("").spans).toEqual([]);
  });

  it("colours a run and resets", () => {
    const { spans, style } = parseAnsiLine(`ok ${ESC}32mpassed${ESC}0m done`);
    expect(spans).toEqual([
      { ...PLAIN, text: "ok " },
      { ...PLAIN, color: "green", text: "passed" },
      { ...PLAIN, text: " done" },
    ]);
    expect(style).toEqual(PLAIN);
  });

  it("combines codes in one sequence and nests bold inside a colour", () => {
    const { spans } = parseAnsiLine(`${ESC}1;31mError: ${ESC}22mdetail${ESC}39m end`);
    expect(spans).toEqual([
      { ...PLAIN, color: "red", bold: true, text: "Error: " },
      { ...PLAIN, color: "red", text: "detail" },
      { ...PLAIN, text: " end" },
    ]);
  });

  it("carries a style left open onto the next line", () => {
    const first = parseAnsiLine(`${ESC}33mwarning starts`);
    expect(first.style.color).toBe("yellow");
    const second = parseAnsiLine("and continues", first.style);
    expect(second.spans).toEqual([{ ...PLAIN, color: "yellow", text: "and continues" }]);
  });

  it("reads bright colours as their plain ones and an empty sequence as a reset", () => {
    expect(parseAnsiLine(`${ESC}96mx${ESC}my`).spans).toEqual([
      { ...PLAIN, color: "cyan", text: "x" },
      { ...PLAIN, text: "y" },
    ]);
  });

  it("skips 256-colour and true-colour arguments without misreading them", () => {
    expect(parseAnsiLine(`${ESC}38;5;196ma${ESC}38;2;1;31;4mb`).spans).toEqual([
      { ...PLAIN, text: "a" },
      { ...PLAIN, text: "b" },
    ]);
    // The 1 after a 256-colour index is bold, not part of the colour.
    expect(parseAnsiLine(`${ESC}38;5;31;1mx`).spans).toEqual([{ ...PLAIN, bold: true, text: "x" }]);
  });

  it("drops cursor movement, erase and title sequences", () => {
    expect(parseAnsiLine(`${ESC}2K${ESC}1Gdone\u001b]0;title\u0007!`).spans).toEqual([
      { ...PLAIN, text: "done" },
      { ...PLAIN, text: "!" },
    ]);
  });

  it("shows what a carriage return left on the line", () => {
    expect(parseAnsiLine("10%\r50%\r100%").spans).toEqual([{ ...PLAIN, text: "100%" }]);
    expect(parseAnsiLine("windows line\r").spans).toEqual([{ ...PLAIN, text: "windows line" }]);
  });
});

describe("stripAnsi", () => {
  it("removes every sequence", () => {
    expect(stripAnsi(`${ESC}1m${ESC}32mSuccess!${ESC}0m The configuration is valid.`)).toBe(
      "Success! The configuration is valid.",
    );
  });
});

describe("amounts", () => {
  it("formats durations", () => {
    expect(formatDuration(null)).toBe("");
    expect(formatDuration(900)).toBe("1s");
    expect(formatDuration(187_000)).toBe("3m 7s");
    expect(formatDuration(3_840_000)).toBe("1h 4m");
  });

  it("formats money and signed changes", () => {
    expect(formatMoney(1204.5, "USD")).toBe("$1,204.50");
    expect(formatMoneyDelta(12.4, "USD")).toBe("+$12.40");
    expect(formatMoneyDelta(-3, "USD")).toBe("-$3.00");
    expect(formatMoneyDelta(0.001, "USD")).toBe("$0.00");
    expect(formatMoney(5, "not-a-code")).toBe("5.00 not-a-code");
  });
});
