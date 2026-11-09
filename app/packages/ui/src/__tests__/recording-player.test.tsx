import { describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { parseCast } from "@infrawrench/client-core";
import { RecordingPlayer } from "../session-recordings/RecordingPlayer.js";
import type { PlaybackTerminal } from "../session-recordings/terminal.js";

const cast = parseCast(
  [
    JSON.stringify({ version: 2, width: 80, height: 24, timestamp: 1 }),
    JSON.stringify([0.5, "o", "hello"]),
  ].join("\n"),
);

function fakeTerminal(): PlaybackTerminal {
  return { write: vi.fn(), reset: vi.fn(), resize: vi.fn(), dispose: vi.fn() };
}

describe("RecordingPlayer", () => {
  it("mounts a terminal the host hands back later, at the recording's geometry", async () => {
    const terminal = fakeTerminal();
    let resolve: (t: PlaybackTerminal) => void = () => {};
    const mount = vi.fn(
      () =>
        new Promise<PlaybackTerminal>((r) => {
          resolve = r;
        }),
    );
    render(<RecordingPlayer cast={cast} mount={mount} />);
    expect(mount).toHaveBeenCalledWith(expect.any(HTMLElement), { cols: 80, rows: 24 });
    await act(async () => resolve(terminal));
    // Ready: the player seeks to the start, which resets the terminal.
    expect(terminal.reset).toHaveBeenCalled();
    expect(terminal.dispose).not.toHaveBeenCalled();
  });

  it("disposes a terminal that arrives after the recording was closed", async () => {
    const terminal = fakeTerminal();
    let resolve: (t: PlaybackTerminal) => void = () => {};
    const mount = () =>
      new Promise<PlaybackTerminal>((r) => {
        resolve = r;
      });
    const { unmount } = render(<RecordingPlayer cast={cast} mount={mount} />);
    unmount();
    await act(async () => resolve(terminal));
    expect(terminal.dispose).toHaveBeenCalledOnce();
    expect(terminal.write).not.toHaveBeenCalled();
  });

  it("still takes a terminal mounted synchronously", () => {
    const terminal = fakeTerminal();
    const { unmount } = render(<RecordingPlayer cast={cast} mount={() => terminal} />);
    expect(terminal.reset).toHaveBeenCalled();
    unmount();
    expect(terminal.dispose).toHaveBeenCalledOnce();
  });
});
