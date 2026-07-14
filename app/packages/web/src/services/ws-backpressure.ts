/**
 * Simple WebSocket send-side backpressure for the streaming proxies
 * (ssh-proxy, kubectl-pty-session, k8s-pf-proxy).
 *
 * `ws.send` never blocks — a fast source (SSH stream, PTY, TCP socket) with a
 * slow browser buffers unboundedly in `ws.bufferedAmount`. Call `check()`
 * after each send: when the buffer crosses the high-water mark the source is
 * paused, then polled (ws has no drain event) until it falls below the
 * low-water mark and the source is resumed. `dispose()` stops the poller and
 * resumes the source; call it from the session's teardown path.
 */
import type { WebSocket } from "ws";

const HIGH_WATER_BYTES = 4 * 1024 * 1024; // 4 MiB
const LOW_WATER_BYTES = 1 * 1024 * 1024; // 1 MiB
const DRAIN_POLL_MS = 50;

type BackpressureWs = Pick<WebSocket, "bufferedAmount" | "readyState" | "OPEN">;

export interface WsBackpressure {
  /** Call after each ws.send of source data. */
  check: () => void;
  /** Stop polling and resume the source. Idempotent. */
  dispose: () => void;
}

export function makeWsBackpressure(
  ws: BackpressureWs,
  source: { pause: () => void; resume: () => void },
): WsBackpressure {
  let paused = false;
  let timer: NodeJS.Timeout | null = null;

  const resume = () => {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    if (paused) {
      paused = false;
      try {
        source.resume();
      } catch {
        /* source already gone */
      }
    }
  };

  const check = () => {
    if (paused || ws.bufferedAmount <= HIGH_WATER_BYTES) return;
    paused = true;
    try {
      source.pause();
    } catch {
      /* source already gone */
    }
    timer = setInterval(() => {
      if (ws.readyState !== ws.OPEN || ws.bufferedAmount <= LOW_WATER_BYTES) {
        resume();
      }
    }, DRAIN_POLL_MS);
    timer.unref?.();
  };

  return { check, dispose: resume };
}
