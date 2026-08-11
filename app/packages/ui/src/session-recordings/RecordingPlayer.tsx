import { useCallback, useEffect, useRef, useState } from "react";
import {
  castOutputThrough,
  castResumeIndex,
  formatPlaybackClock,
  parseResizeData,
  type ParsedCast,
} from "@infrawrench/client-core";

import { getTerminalContainerProps } from "../xterm-options.js";
import type { MountPlaybackTerminal, PlaybackTerminal } from "./terminal.js";

const PLAYBACK_SPEEDS = [0.5, 1, 2, 4] as const;

/**
 * Playback for one recorded SSH session.
 *
 * The clock is a `requestAnimationFrame` loop rather than a chain of
 * `setTimeout`s per event: a busy session has tens of thousands of events,
 * many of them microseconds apart, and one timer each would both drift and
 * flood the event loop. Each frame asks "which events are now due" and writes
 * them in one go, which also means a backgrounded tab catches up in a single
 * batch instead of replaying in slow motion.
 *
 * **Seeking is a replay, not a jump.** A terminal's screen at time t is the
 * product of every byte before t — there is no keyframe to seek to — so moving
 * the scrubber resets the terminal and rewrites all output up to the target
 * with the delays removed. That is what `castOutputThrough` returns, and it is
 * why scrubbing is instant regardless of how far back you drag.
 *
 * Input events are never written. They were not rendered by the host in the
 * first place (what you see echoed is output), so replaying them would inject
 * text the session never actually displayed.
 */
export function RecordingPlayer({
  cast,
  mount,
  autoPlay = false,
}: {
  cast: ParsedCast;
  mount: MountPlaybackTerminal;
  autoPlay?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<PlaybackTerminal | null>(null);

  const [ready, setReady] = useState(false);
  const [playing, setPlaying] = useState(autoPlay);
  const [speed, setSpeed] = useState(1);
  /** Rendered position, in seconds. Updated at most a few times a second. */
  const [position, setPosition] = useState(0);

  /**
   * The playback clock lives in refs, not state: the rAF loop reads and writes
   * it every frame, and routing that through React would re-render the whole
   * player sixty times a second to move a progress bar.
   */
  const positionRef = useRef(0);
  const eventIndexRef = useRef(0);
  const speedRef = useRef(speed);
  // Keep the rAF loop reading the latest speed without re-subscribing every
  // change. Written in an effect so render stays pure (Strict Mode may replay
  // render and would otherwise double-write the ref for work that never commits).
  useEffect(() => {
    speedRef.current = speed;
  }, [speed]);

  const duration = cast.durationSeconds;

  /** Mount the terminal once per recording, at the geometry it was recorded at. */
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const terminal = mount(container, { cols: cast.width, rows: cast.height });
    terminalRef.current = terminal;
    setReady(true);
    return () => {
      terminalRef.current = null;
      setReady(false);
      terminal.dispose();
    };
  }, [cast, mount]);

  /** Reset and replay output up to `seconds`. The whole of seeking. */
  const seekTo = useCallback(
    (seconds: number) => {
      const terminal = terminalRef.current;
      const target = Math.min(Math.max(seconds, 0), duration);
      positionRef.current = target;
      eventIndexRef.current = castResumeIndex(cast, target);
      setPosition(target);
      if (!terminal) return;
      terminal.reset();
      // The last resize before the target is the geometry the session was at,
      // so apply it before the replay rather than letting the events do it —
      // replaying resizes mid-stream would reflow output that was written at
      // the older size.
      for (let i = eventIndexRef.current - 1; i >= 0; i--) {
        const event = cast.events[i]!;
        if (event.code !== "r") continue;
        const size = parseResizeData(event.data);
        if (size) terminal.resize(size.cols, size.rows);
        break;
      }
      terminal.write(castOutputThrough(cast, target));
    },
    [cast, duration],
  );

  /** Rewind whenever the recording changes. */
  useEffect(() => {
    if (!ready) return;
    seekTo(0);
    setPlaying(autoPlay);
  }, [ready, seekTo, autoPlay]);

  /** The clock. Runs only while playing. */
  useEffect(() => {
    if (!playing || !ready) return;
    let frame = 0;
    let last = performance.now();

    const step = (now: number) => {
      const terminal = terminalRef.current;
      if (!terminal) return;
      const advanced = ((now - last) / 1000) * speedRef.current;
      last = now;
      const next = positionRef.current + advanced;
      positionRef.current = next;

      // Write every event that has come due this frame in one pass.
      let pending = "";
      while (eventIndexRef.current < cast.events.length) {
        const event = cast.events[eventIndexRef.current]!;
        if (event.time > next) break;
        eventIndexRef.current++;
        if (event.code === "o") {
          pending += event.data;
        } else if (event.code === "r") {
          // Flush first: a resize applies to what comes after it, and writing
          // the buffered output afterwards would render it at the new size.
          if (pending) {
            terminal.write(pending);
            pending = "";
          }
          const size = parseResizeData(event.data);
          if (size) terminal.resize(size.cols, size.rows);
        }
      }
      if (pending) terminal.write(pending);

      setPosition(next);
      if (eventIndexRef.current >= cast.events.length && next >= duration) {
        positionRef.current = duration;
        setPosition(duration);
        setPlaying(false);
        return;
      }
      frame = requestAnimationFrame(step);
    };

    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [playing, ready, cast, duration]);

  const atEnd = position >= duration && duration > 0;

  const togglePlay = useCallback(() => {
    // Pressing play at the end restarts rather than doing nothing — the
    // alternative is a dead button on every finished recording.
    if (atEnd) seekTo(0);
    setPlaying((p) => !p);
  }, [atEnd, seekTo]);

  return (
    <div className="space-y-2">
      <div
        ref={containerRef}
        className="rounded-lg overflow-hidden bg-black p-2"
        // The cast's own geometry drives the terminal; the container just
        // scrolls when the recording is wider than the panel.
        style={{ overflowX: "auto" }}
        {...getTerminalContainerProps({ kind: "playback" })}
      />

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={togglePlay}
          disabled={!ready}
          className="px-3 py-1.5 text-sm font-medium border border-border hover:bg-surface-overlay disabled:opacity-50 text-on-surface-secondary rounded-lg transition-colors min-w-[5.5rem]"
        >
          {playing ? "Pause" : atEnd ? "Replay" : "Play"}
        </button>

        <input
          type="range"
          min={0}
          max={Math.max(duration, 0.001)}
          step={0.01}
          value={Math.min(position, duration)}
          onChange={(e) => {
            setPlaying(false);
            seekTo(Number(e.target.value));
          }}
          disabled={!ready || duration === 0}
          aria-label="Playback position"
          className="flex-1 accent-blue-500"
        />

        <span className="text-xs text-on-surface-muted tabular-nums whitespace-nowrap">
          {formatPlaybackClock(position)} / {formatPlaybackClock(duration)}
        </span>

        <div className="flex items-center gap-1" role="group" aria-label="Playback speed">
          {PLAYBACK_SPEEDS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setSpeed(s)}
              aria-pressed={speed === s}
              className={`px-2 py-1 text-xs rounded-md transition-colors ${
                speed === s
                  ? "bg-surface-overlay text-on-surface"
                  : "text-on-surface-tertiary hover:text-on-surface-secondary"
              }`}
            >
              {s}×
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
