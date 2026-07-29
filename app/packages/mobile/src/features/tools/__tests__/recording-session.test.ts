import { describe, expect, it, vi } from "vitest";
import { releaseRecordingMode, withRecordingMode } from "../recording-session";

/** Records every mode the screen asks for, in order. */
function tracker(impl?: () => Promise<void>) {
  const modes: Array<{ allowsRecording: boolean; playsInSilentMode: boolean }> = [];
  const setAudioMode = vi.fn(
    async (mode: { allowsRecording: boolean; playsInSilentMode: boolean }) => {
      modes.push(mode);
      if (impl) await impl();
    },
  );
  return { modes, setAudioMode };
}

describe("releaseRecordingMode", () => {
  it("turns recording off while keeping silent-mode playback on", async () => {
    const { modes, setAudioMode } = tracker();

    await releaseRecordingMode(setAudioMode);

    expect(modes).toEqual([{ allowsRecording: false, playsInSilentMode: true }]);
  });

  it("swallows failures — it runs on error paths and during unmount", async () => {
    const setAudioMode = vi.fn().mockRejectedValue(new Error("session busy"));

    await expect(releaseRecordingMode(setAudioMode)).resolves.toBeUndefined();
  });
});

describe("withRecordingMode", () => {
  it("enables the session and leaves it on while recording runs", async () => {
    const { modes, setAudioMode } = tracker();

    await withRecordingMode(setAudioMode, async () => {});

    expect(modes).toEqual([{ allowsRecording: true, playsInSilentMode: true }]);
  });

  it("releases the session when the recorder fails to start", async () => {
    // The leak this exists to prevent: `allowsRecording` is already on by the
    // time `prepareToRecordAsync()` throws, so without the rollback every clip
    // synthesized afterwards would play through the iOS earpiece.
    const { modes, setAudioMode } = tracker();
    const start = vi.fn().mockRejectedValue(new Error("prepareToRecordAsync failed"));

    await expect(withRecordingMode(setAudioMode, start)).rejects.toThrow(
      "prepareToRecordAsync failed",
    );

    expect(modes).toEqual([
      { allowsRecording: true, playsInSilentMode: true },
      { allowsRecording: false, playsInSilentMode: true },
    ]);
  });

  it("still rethrows when the rollback itself fails", async () => {
    // A failed release must not mask why recording never started.
    const setAudioMode = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("session busy"));

    await expect(
      withRecordingMode(setAudioMode, () => Promise.reject(new Error("no mic"))),
    ).rejects.toThrow("no mic");
    expect(setAudioMode).toHaveBeenCalledTimes(2);
  });

  it("does not swallow a failure to enable the session", async () => {
    // Nothing was turned on, so there is nothing to roll back — and the caller
    // needs to hear about it rather than watch a recorder that never starts.
    const setAudioMode = vi.fn().mockRejectedValue(new Error("category denied"));
    const start = vi.fn();

    await expect(withRecordingMode(setAudioMode, start)).rejects.toThrow("category denied");
    expect(start).not.toHaveBeenCalled();
    expect(setAudioMode).toHaveBeenCalledTimes(1);
  });
});
