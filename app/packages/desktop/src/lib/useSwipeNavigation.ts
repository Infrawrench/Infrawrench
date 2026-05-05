import { useCallback, useEffect, useRef, useState } from "react";

export interface SwipeGestureState {
  active: boolean;
  direction: "back" | "forward" | null;
  progress: number;
  triggered: boolean;
}

const INITIAL_STATE: SwipeGestureState = {
  active: false,
  direction: null,
  progress: 0,
  triggered: false,
};

const DEAD_ZONE = 10;
const TRIGGER_THRESHOLD = 60;
const VISUAL_MAX = 120;
const IDLE_TIMEOUT_MS = 300;
const TRIGGER_VISUAL_MS = 300;

function findScrollableAncestor(el: EventTarget | null): HTMLElement | null {
  let node = el as HTMLElement | null;
  while (node && node !== document.documentElement) {
    if (node.scrollWidth > node.clientWidth) {
      return node;
    }
    node = node.parentElement;
  }
  return null;
}

/**
 * Detects two-finger horizontal trackpad swipes and calls `onBack` / `onForward`.
 * Returns live gesture state for rendering a visual indicator.
 *
 * Chromium's built-in overscroll history navigation must be disabled in the
 * main process (`--overscroll-history-navigation=0`) or it will double-fire.
 */
export function useSwipeNavigation(onBack: () => void, onForward: () => void): SwipeGestureState {
  const stateRef = useRef<SwipeGestureState>(INITIAL_STATE);
  const [renderState, setRenderState] = useState<SwipeGestureState>(INITIAL_STATE);

  const accDeltaRef = useRef(0);
  const triggeredRef = useRef(false);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const triggerTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lockRef = useRef<"swipe" | "scroll" | null>(null);

  const onBackRef = useRef(onBack);
  const onForwardRef = useRef(onForward);
  useEffect(() => {
    onBackRef.current = onBack;
  }, [onBack]);
  useEffect(() => {
    onForwardRef.current = onForward;
  }, [onForward]);

  const pushState = useCallback((next: SwipeGestureState) => {
    stateRef.current = next;
    setRenderState(next);
  }, []);

  const reset = useCallback(() => {
    accDeltaRef.current = 0;
    triggeredRef.current = false;
    lockRef.current = null;
    if (idleTimerRef.current) {
      clearTimeout(idleTimerRef.current);
      idleTimerRef.current = null;
    }
    if (triggerTimerRef.current) {
      clearTimeout(triggerTimerRef.current);
      triggerTimerRef.current = null;
    }
    pushState(INITIAL_STATE);
  }, [pushState]);

  const bumpIdleTimer = useCallback(() => {
    if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    idleTimerRef.current = setTimeout(reset, IDLE_TIMEOUT_MS);
  }, [reset]);

  useEffect(() => {
    function handleWheel(e: WheelEvent) {
      if (e.deltaMode !== 0) return;

      if (triggeredRef.current) {
        bumpIdleTimer();
        return;
      }

      if (lockRef.current === null) {
        const absX = Math.abs(e.deltaX);
        const absY = Math.abs(e.deltaY);
        if (absX < 2 && absY < 2) return;
        lockRef.current = absX >= absY * 0.6 ? "swipe" : "scroll";
      }
      if (lockRef.current === "scroll") {
        bumpIdleTimer();
        return;
      }

      const fingerDir: "left" | "right" = e.deltaX < 0 ? "right" : "left";
      const scrollContainer = findScrollableAncestor(e.target);
      if (scrollContainer) {
        const { scrollWidth, clientWidth, scrollLeft } = scrollContainer;
        const canScroll =
          fingerDir === "right"
            ? scrollLeft > 0
            : Math.ceil(scrollLeft) + clientWidth < scrollWidth;
        if (canScroll) {
          if (stateRef.current.active) reset();
          return;
        }
      }

      bumpIdleTimer();

      accDeltaRef.current += e.deltaX;
      const delta = accDeltaRef.current;
      const abs = Math.abs(delta);

      if (abs < DEAD_ZONE) {
        if (stateRef.current.active) pushState(INITIAL_STATE);
        return;
      }

      const direction: "back" | "forward" = delta < 0 ? "back" : "forward";
      const progress = Math.min((abs - DEAD_ZONE) / (VISUAL_MAX - DEAD_ZONE), 1);

      if (abs >= TRIGGER_THRESHOLD) {
        triggeredRef.current = true;
        pushState({ active: true, direction, progress: 1, triggered: true });
        if (direction === "back") onBackRef.current();
        else onForwardRef.current();
        triggerTimerRef.current = setTimeout(
          () => pushState({ ...stateRef.current, active: false }),
          TRIGGER_VISUAL_MS,
        );
      } else {
        pushState({ active: true, direction, progress, triggered: false });
      }
    }

    window.addEventListener("wheel", handleWheel, { passive: true });

    return () => {
      window.removeEventListener("wheel", handleWheel);
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
      if (triggerTimerRef.current) clearTimeout(triggerTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pushState, reset, bumpIdleTimer]);

  return renderState;
}
