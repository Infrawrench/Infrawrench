import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_AUDIO_BYTES,
  audioExtensionFor,
  audioMimeForExtension,
  audioSizeError,
  describeSynthesis,
  describeTranscript,
  formatAudioBytes,
  speechTextError,
} from "../speech";

describe("audioExtensionFor", () => {
  it("maps the types providers actually return", () => {
    expect(audioExtensionFor("audio/mpeg")).toBe(".mp3");
    expect(audioExtensionFor("audio/wav")).toBe(".wav");
    expect(audioExtensionFor("audio/mp4")).toBe(".m4a");
    expect(audioExtensionFor("audio/flac")).toBe(".flac");
  });

  it("ignores codec parameters and case", () => {
    expect(audioExtensionFor("audio/webm;codecs=opus")).toBe(".webm");
    expect(audioExtensionFor("Audio/OGG")).toBe(".ogg");
  });

  it("falls back rather than guessing", () => {
    expect(audioExtensionFor("application/octet-stream")).toBe(".audio");
  });
});

describe("audioMimeForExtension", () => {
  it("resolves what a native recorder names its file", () => {
    expect(audioMimeForExtension(".m4a")).toBe("audio/mp4");
    expect(audioMimeForExtension("3gp")).toBe("audio/3gpp");
    expect(audioMimeForExtension(".WAV")).toBe("audio/wav");
  });

  it("falls back to a type every provider will reject loudly", () => {
    expect(audioMimeForExtension(".xyz")).toBe("application/octet-stream");
  });
});

describe("formatAudioBytes", () => {
  it("switches units at the KB and MB boundaries", () => {
    expect(formatAudioBytes(512)).toBe("512 B");
    expect(formatAudioBytes(2048)).toBe("2.0 KB");
    expect(formatAudioBytes(3 * 1024 * 1024)).toBe("3.0 MB");
  });
});

describe("speechTextError", () => {
  it("rejects blank text", () => {
    expect(speechTextError("   ")).toBe("Enter some text to synthesize.");
  });

  it("enforces the plugin's character cap", () => {
    expect(speechTextError("abcdef", 5)).toBe("Text is 6 characters — the limit is 5.");
    expect(speechTextError("abcde", 5)).toBeNull();
  });

  it("passes anything through when no cap is declared", () => {
    expect(speechTextError("a".repeat(10_000))).toBeNull();
  });
});

describe("audioSizeError", () => {
  it("allows a clip at exactly the cap", () => {
    expect(audioSizeError(DEFAULT_MAX_AUDIO_BYTES, DEFAULT_MAX_AUDIO_BYTES)).toBeNull();
  });

  it("names the file when one was picked", () => {
    expect(audioSizeError(2 * 1024 * 1024, 1024 * 1024, "meeting.m4a")).toBe(
      "meeting.m4a is 2.0 MB — the limit is 1.0 MB.",
    );
  });

  it("defaults to talking about the clip", () => {
    expect(audioSizeError(2 * 1024 * 1024, 1024 * 1024)).toBe(
      "Clip is 2.0 MB — the limit is 1.0 MB.",
    );
  });
});

describe("describeSynthesis", () => {
  it("appends billed characters only when the provider reported them", () => {
    expect(describeSynthesis(1024, 42)).toBe("1.0 KB · 42 characters billed");
    expect(describeSynthesis(1024)).toBe("1.0 KB");
  });
});

describe("describeTranscript", () => {
  it("joins whatever the provider reported", () => {
    expect(
      describeTranscript({
        text: "hello",
        durationSeconds: 3.14,
        language: "en",
        confidence: 0.912,
      }),
    ).toBe("3.1s of audio · en · 91% confidence");
  });

  it("is empty when the provider reported nothing", () => {
    expect(describeTranscript({ text: "hello" })).toBe("");
  });
});
