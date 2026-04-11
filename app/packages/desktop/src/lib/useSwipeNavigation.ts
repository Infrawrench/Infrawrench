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
const COOLDOWN_MS = 600;

function canScrollHorizontally(el: EventTarget | null, fingerDirection: "left" | "right"): boolean {
  let node = el as HTMLElement | null;
  while (node && node !== document.documentElement) {
    const { scrollWidth, clientWidth, scrollLeft } = node;
    if (scrollWidth > clientWidth + 1) {
      if (fingerDirection === "right" && scrollLeft > 0) return true;
      if (fingerDirection === "left" && Math.ceil(scrollLeft) + clientWidth < scrollWidth)
        return true;
    }
    node = node.parentElement;
  }
  return false;
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
  const cooldownUntilRef = useRef(0);
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

  useEffect(() => {
    function handleWheel(e: WheelEvent) {
      if (e.deltaMode !== 0) return;
      if (Date.now() < cooldownUntilRef.current) return;

      if (lockRef.current === null) {
        const absX = Math.abs(e.deltaX);
        const absY = Math.abs(e.deltaY);
        if (absX < 2 && absY < 2) return;
        lockRef.current = absX >= absY * 0.6 ? "swipe" : "scroll";
      }
      if (lockRef.current === "scroll") {
        if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
        idleTimerRef.current = setTimeout(reset, IDLE_TIMEOUT_MS);
        return;
      }

      const fingerDir: "left" | "right" = e.deltaX < 0 ? "right" : "left";
      if (canScrollHorizontally(e.target, fingerDir)) {
        if (stateRef.current.active) reset();
        return;
      }

      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
      idleTimerRef.current = setTimeout(reset, IDLE_TIMEOUT_MS);

      if (triggeredRef.current) return;

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
        cooldownUntilRef.current = Date.now() + COOLDOWN_MS;
        if (idleTimerRef.current) {
          clearTimeout(idleTimerRef.current);
          idleTimerRef.current = null;
        }
        pushState({ active: true, direction, progress: 1, triggered: true });
        if (direction === "back") onBackRef.current();
        else onForwardRef.current();
        triggerTimerRef.current = setTimeout(reset, 300);
      } else {
        pushState({ active: true, direction, progress, triggered: false });
      }
    }

    function handleNativeSwipe(...args: unknown[]) {
      const direction = args[0] as string;
      if (direction !== "back" && direction !== "forward") return;
      if (triggeredRef.current || Date.now() < cooldownUntilRef.current) return;
      triggeredRef.current = true;
      cooldownUntilRef.current = Date.now() + COOLDOWN_MS;
      pushState({ active: true, direction, progress: 1, triggered: true });
      if (direction === "back") onBackRef.current();
      else onForwardRef.current();
      triggerTimerRef.current = setTimeout(reset, 300);
    }

    window.addEventListener("wheel", handleWheel, { passive: true });
    if (window.electronAPI) {
      window.electronAPI.on("swipe-navigate", handleNativeSwipe);
    }

    return () => {
      window.removeEventListener("wheel", handleWheel);
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
      if (triggerTimerRef.current) clearTimeout(triggerTimerRef.current);
      if (window.electronAPI) window.electronAPI.offAll("swipe-navigate");
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pushState, reset]);

  return renderState;
}
