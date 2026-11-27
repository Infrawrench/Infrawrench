import { describe, expect, it } from "vitest";

import {
  CI_NOTE_LIMITS,
  ciNoteTitle,
  ciNotesIgnoredSummary,
  ciReviewerJob,
  ciReviewerName,
  escapeCiNote,
  isCiReviewer,
  parseCiNotes,
  unescapeCiNote,
} from "../ci-notes";

const parse = (stdout: string, stderr = "", limit?: number) =>
  parseCiNotes({ stdout, stderr }, limit);

describe("note commands", () => {
  it("reads each finding command as its severity", () => {
    const { notes, ignored } = parse(
      [
        "::must-fix file=src/db.ts,line=42,end_line=44,title=Unbounded query::No LIMIT here.",
        "::should-fix file=src/db.ts,line=7::Name this constant.",
        "::note::Coverage went from 81% to 83%.",
      ].join("\n"),
    );
    expect(ignored).toEqual({ malformed: 0, tooLong: 0, overLimit: 0 });
    expect(notes).toEqual([
      {
        command: "must-fix",
        severity: "must_fix",
        traceKind: null,
        file: "src/db.ts",
        line: 42,
        endLine: 44,
        title: "Unbounded query",
        needsCode: null,
        message: "No LIMIT here.",
        logLine: 1,
      },
      {
        command: "should-fix",
        severity: "should_fix",
        traceKind: null,
        file: "src/db.ts",
        line: 7,
        endLine: null,
        title: null,
        needsCode: null,
        message: "Name this constant.",
        logLine: 2,
      },
      {
        command: "note",
        severity: "note",
        traceKind: null,
        file: null,
        line: null,
        endLine: null,
        title: null,
        needsCode: null,
        message: "Coverage went from 81% to 83%.",
        logLine: 3,
      },
    ]);
  });

  it("reads each trace command as its kind, with or without a place", () => {
    const { notes } = parse(
      [
        "::doubt file=src/retry.ts,line=12::Is three attempts enough?",
        "::decision::Kept the old parser behind a flag.",
        "::step::Ran the migration against a copy.",
        "::evidence file=bench.txt::p95 went from 41 ms to 18 ms.",
      ].join("\n"),
    );
    expect(notes.map((note) => [note.traceKind, note.severity, note.file, note.line])).toEqual([
      ["doubt", null, "src/retry.ts", 12],
      ["decision", null, null, null],
      ["step", null, null, null],
      ["evidence", null, "bench.txt", null],
    ]);
  });

  it("takes needs_code as said, and leaves it unsaid otherwise", () => {
    const { notes } = parse(
      [
        "::note file=a.ts,line=1,needs_code=false::Stands on its own.",
        "::doubt file=a.ts,needs_code=true::Read the file.",
        "::doubt file=a.ts,line=1::Unsaid.",
      ].join("\n"),
    );
    expect(notes.map((note) => note.needsCode)).toEqual([false, true, null]);
  });

  it("reads the escapes in a message and in a parameter", () => {
    const { notes } = parse(
      "::must-fix file=src/a%2Cb.ts,line=3,title=Ratio 1%3A2%2C not 2%3A1::First line%0ASecond: with, a comma%0A100%25 sure",
    );
    expect(notes[0]).toMatchObject({
      file: "src/a,b.ts",
      title: "Ratio 1:2, not 2:1",
      message: "First line\nSecond: with, a comma\n100% sure",
    });
  });

  it("reads an escaped percent once, so the text %0A survives", () => {
    expect(unescapeCiNote("a%250Ab")).toBe("a%0Ab");
    expect(unescapeCiNote("100%")).toBe("100%");
    expect(unescapeCiNote("%zz %0a")).toBe("%zz \n");
  });

  it("escapes what it reads back", () => {
    const text = "50%: a, b\r\nnext";
    expect(unescapeCiNote(escapeCiNote(text))).toBe(text);
    expect(unescapeCiNote(escapeCiNote(text, "parameter"))).toBe(text);
    expect(escapeCiNote("a:b,c", "parameter")).toBe("a%3Ab%2Cc");
    expect(escapeCiNote("a:b,c")).toBe("a:b,c");
    const title = "x::y, z";
    const { notes } = parse(
      `::note title=${escapeCiNote(title, "parameter")}::${escapeCiNote("m::n")}`,
    );
    expect(notes[0]).toMatchObject({ title, message: "m::n" });
  });

  it("keeps a message's own colons and a line ending", () => {
    const { notes } = parse("::note::see https://example.com/a::b\r\n");
    expect(notes[0]?.message).toBe("see https://example.com/a::b");
  });

  it("normalises a path and refuses one outside the repository", () => {
    expect(parse("::note file=./src/a.ts::x").notes[0]?.file).toBe("src/a.ts");
    const bad = parse(
      [
        "::note file=/etc/passwd::x",
        "::note file=../up.ts::x",
        "::note file=src//a.ts::x",
        "::note file=src\\a.ts::x",
        "::note file=::x",
      ].join("\n"),
    );
    expect(bad.notes).toEqual([]);
    expect(bad.ignored.malformed).toBe(5);
  });

  it("counts a malformed command and leaves no note", () => {
    const { notes, ignored } = parse(
      [
        "::must-fix path=src/a.ts::unknown parameter",
        "::must-fix file=src/a.ts,line=0::line from 1",
        "::must-fix file=src/a.ts,line=4x::not a number",
        "::must-fix line=4::a line with no file",
        "::must-fix file=src/a.ts,end_line=4::an end with no start",
        "::must-fix file=src/a.ts,line=9,end_line=4::an end before its start",
        "::must-fix file=src/a.ts,file=src/b.ts::twice",
        "::must-fix file=src/a.ts,needs_code=yes::not true or false",
        "::must-fix file=src/a.ts::",
        "::doubt title=Only a title::",
        "::must-fix file=src/a.ts no closing",
        "::must-fix nonsense::x",
      ].join("\n"),
    );
    expect(notes).toEqual([]);
    expect(ignored).toEqual({ malformed: 12, tooLong: 0, overLimit: 0 });
  });

  it("lets a finding be its title alone", () => {
    const { notes, ignored } = parse("::should-fix file=a.ts,line=2,title=Unused import::");
    expect(ignored.malformed).toBe(0);
    expect(notes[0]).toMatchObject({ title: "Unused import", message: "" });
  });

  it("leaves other tools' commands and ordinary lines alone, uncounted", () => {
    const { notes, ignored } = parse(
      [
        "::error file=a.ts,line=1::GitHub's",
        "::group::Install",
        "::endgroup::",
        "::notes::not ours",
        " ::note::indented is not a command",
        "text ::note::mid-line is not a command",
        "::",
        "",
      ].join("\n"),
    );
    expect(notes).toEqual([]);
    expect(ignored).toEqual({ malformed: 0, tooLong: 0, overLimit: 0 });
  });

  it("counts what is too long", () => {
    const { notes, ignored } = parse(
      [
        `::note::${"x".repeat(CI_NOTE_LIMITS.messageBytes + 1)}`,
        `::note title=${"t".repeat(CI_NOTE_LIMITS.titleLength + 1)}::x`,
        `::note file=${"p".repeat(CI_NOTE_LIMITS.pathLength + 1)}::x`,
        `::note::${"x".repeat(CI_NOTE_LIMITS.messageBytes)}`,
      ].join("\n"),
    );
    expect(notes).toHaveLength(1);
    expect(ignored).toEqual({ malformed: 0, tooLong: 3, overLimit: 0 });
  });

  it("measures a message in bytes", () => {
    const { ignored } = parse(`::note::${"é".repeat(CI_NOTE_LIMITS.messageBytes / 2 + 1)}`);
    expect(ignored.tooLong).toBe(1);
  });

  it("stops at the job's limit and counts the rest", () => {
    const lines = Array.from({ length: CI_NOTE_LIMITS.perJob + 7 }, (_, i) => `::note::n${i}`);
    const { notes, ignored } = parse(lines.join("\n"));
    expect(notes).toHaveLength(CI_NOTE_LIMITS.perJob);
    expect(notes.at(-1)?.message).toBe(`n${CI_NOTE_LIMITS.perJob - 1}`);
    expect(ignored.overLimit).toBe(7);
  });

  it("takes a smaller limit when the run has less left, and never a larger one", () => {
    const lines = Array.from({ length: 5 }, (_, i) => `::note::n${i}`).join("\n");
    expect(parse(lines, "", 2).notes).toHaveLength(2);
    expect(parse(lines, "", 0)).toMatchObject({ notes: [], ignored: { overLimit: 5 } });
    const many = Array.from({ length: CI_NOTE_LIMITS.perJob + 1 }, () => "::note::n").join("\n");
    expect(parse(many, "", 10_000).notes).toHaveLength(CI_NOTE_LIMITS.perJob);
  });

  it("numbers lines as the run's page does: the output, then the errors", () => {
    const { notes } = parse("building\n::note::in the output\n", "warn\n::doubt::in the errors");
    expect(notes.map((note) => [note.message, note.logLine])).toEqual([
      ["in the output", 2],
      ["in the errors", 4],
    ]);
  });

  it("keeps what the runner masked as it is", () => {
    const { notes } = parse("::must-fix file=.env,line=1::The key *** is committed.");
    expect(notes[0]?.message).toBe("The key *** is committed.");
  });
});

describe("what was ignored, in a sentence", () => {
  it("says nothing when nothing was", () => {
    expect(ciNotesIgnoredSummary({ malformed: 0, tooLong: 0, overLimit: 0 })).toBeNull();
  });
  it("counts and says why", () => {
    expect(ciNotesIgnoredSummary({ malformed: 1, tooLong: 0, overLimit: 0 })).toBe(
      "1 note command ignored (1 malformed)",
    );
    expect(ciNotesIgnoredSummary({ malformed: 2, tooLong: 1, overLimit: 4 })).toBe(
      "7 note commands ignored (2 malformed, 1 too long, 4 past the limit)",
    );
  });
});

describe("a finding's title", () => {
  it("is the one given, over the whole message", () => {
    expect(ciNoteTitle({ title: "T", message: "body" })).toEqual({ title: "T", body: "body" });
  });
  it("is a one-line message itself, with nothing under it", () => {
    expect(ciNoteTitle({ title: null, message: "No LIMIT here." })).toEqual({
      title: "No LIMIT here.",
      body: "",
    });
  });
  it("is the first line of a longer message, which stays whole under it", () => {
    expect(ciNoteTitle({ title: null, message: "First\nmore" })).toEqual({
      title: "First",
      body: "First\nmore",
    });
  });
  it("is cut when the first line is long", () => {
    const long = "w".repeat(300);
    const { title, body } = ciNoteTitle({ title: null, message: long });
    expect(title).toHaveLength(CI_NOTE_LIMITS.derivedTitleLength);
    expect(title.endsWith("…")).toBe(true);
    expect(body).toBe(long);
  });
});

describe("the names CI writes under", () => {
  it("is ci:<pipeline>/<job>", () => {
    expect(ciReviewerName("lint", "eslint")).toBe("ci:lint/eslint");
    expect(isCiReviewer("ci:lint/eslint")).toBe(true);
    expect(isCiReviewer("general")).toBe(false);
    expect(isCiReviewer("circle")).toBe(false);
  });
  it("shows a matrix job's whole key", () => {
    expect(ciReviewerJob("ci:test/build[app/packages/ui]")).toBe("test/build[app/packages/ui]");
    expect(ciReviewerJob("security")).toBeNull();
    expect(ciReviewerJob("ci:")).toBeNull();
  });
});
