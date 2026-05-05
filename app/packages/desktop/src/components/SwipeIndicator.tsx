import type { SwipeGestureState } from "../lib/useSwipeNavigation";

interface SwipeIndicatorProps {
  gesture: SwipeGestureState;
}

/**
 * Safari-style edge indicator shown during a trackpad swipe gesture.
 *
 * Both the left and right edge containers are always mounted so that React
 * reconciliation across route changes never destroys and recreates them
 * (which would replay the CSS transition).
 */
export function SwipeIndicator({ gesture }: SwipeIndicatorProps) {
  const { active, direction, progress, triggered } = gesture;

  const showBack = active && direction === "back";
  const showForward = active && direction === "forward";

  return (
    <>
      <EdgePill side="left" visible={showBack} progress={progress} triggered={triggered} />
      <EdgePill side="right" visible={showForward} progress={progress} triggered={triggered} />
    </>
  );
}

function EdgePill({
  side,
  visible,
  progress,
  triggered,
}: {
  side: "left" | "right";
  visible: boolean;
  progress: number;
  triggered: boolean;
}) {
  const size = 24 + progress * 12;

  // Slide in from off-screen edge. At progress 0 → mostly hidden, progress 1 → fully in.
  const edgeOffset = -14 + progress * 20;
  const translateX = triggered
    ? side === "left"
      ? edgeOffset + 4
      : -(edgeOffset + 4)
    : side === "left"
      ? edgeOffset
      : -edgeOffset;

  return (
    <div
      className="pointer-events-none fixed inset-y-0 z-50 flex items-center"
      style={{
        [side]: 0,
        visibility: visible ? "visible" : "hidden",
      }}
    >
      <div
        className={`flex items-center justify-center rounded-full ${
          triggered ? "bg-blue-500 shadow-lg shadow-blue-500/30" : "bg-surface-sunken/60"
        }`}
        style={{
          width: size,
          height: size,
          opacity: visible ? (triggered ? 1 : 0.3 + progress * 0.7) : 0,
          transform: `translateX(${translateX}px) scale(${triggered ? 1.15 : 1})`,
          transition: triggered
            ? "transform 200ms ease-out, background-color 150ms, box-shadow 150ms, opacity 150ms"
            : "none",
        }}
      >
        <svg
          width={14}
          height={14}
          viewBox="0 0 14 14"
          fill="none"
          className="text-white"
          style={{
            opacity: triggered ? 1 : 0.8,
            transform: side === "left" ? "rotate(180deg)" : "none",
          }}
        >
          <path
            d="M5 2.5L9.5 7L5 11.5"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </div>
    </div>
  );
}
