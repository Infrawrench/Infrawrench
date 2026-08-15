/**
 * The stop channel of a running deploy, owned by the caller instead of the
 * transport.
 *
 * The panel used to read `session.stop` synchronously right after `deploy()`
 * returned, trusting the transport to have assigned it by then. No transport
 * can honour that: every one of them awaits a websocket token before it opens a
 * socket, so the assignment landed a microtask later and the Stop button never
 * appeared at all. Handing the transport a controller the caller already holds
 * removes the ordering question entirely — there is nothing to read back, so
 * there is no moment at which reading it is too early.
 *
 * It also decides what an early stop means. A deploy is stoppable from the
 * instant the user asks for it: a click that arrives before the socket is up is
 * remembered and flushed the moment the transport arms the channel, rather than
 * being dropped or hidden behind a disabled button. That window is short but it
 * is exactly the window a user is most likely to change their mind in — they
 * have just clicked Deploy — and a Stop button that silently does nothing is
 * the bug this whole module exists to fix.
 *
 * Deliberately not reactive: with an early stop queued there is no "not ready
 * yet" state for a UI to render, so a controller needs no subscription and the
 * panel can hold it in plain state.
 */

/** Sends one stop frame over whatever channel the transport opened. */
export type DeployStopSender = () => void;

export interface DeployStopController {
  /** True once the user has asked to stop, whether or not it has been sent. */
  readonly requested: boolean;
  /** True once a transport has armed the channel. */
  readonly armed: boolean;
  /** True once the run has ended; `stop()` is a no-op from then on. */
  readonly finished: boolean;
  /**
   * Ask the run to stop. Safe at any point in the lifecycle: before the socket
   * opens it is queued, after the run finishes it does nothing, and repeat
   * calls send at most one frame.
   */
  stop(): void;
  /**
   * Transport: the channel can now carry a stop frame. Flushes an already
   * queued request. Ignored once the run has finished.
   */
  arm(send: DeployStopSender): void;
  /**
   * Transport: the run is over (resolved, rejected or the socket closed).
   * Idempotent, and callers may also invoke it to release the controller.
   */
  finish(): void;
}

export function createDeployStopController(): DeployStopController {
  let sender: DeployStopSender | null = null;
  let requested = false;
  let sent = false;
  let finished = false;

  const flush = (): void => {
    if (!requested || sent || finished || !sender) return;
    sent = true;
    sender();
  };

  return {
    get requested() {
      return requested;
    },
    get armed() {
      return sender !== null;
    },
    get finished() {
      return finished;
    },
    stop() {
      if (finished) return;
      requested = true;
      flush();
    },
    arm(send: DeployStopSender) {
      if (finished) return;
      sender = send;
      flush();
    },
    finish() {
      finished = true;
      sender = null;
    },
  };
}
