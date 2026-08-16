import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { T, useGT } from "gt-react";
import { decompress } from "fzstd";
import {
  ButtonState,
  Codec,
  RectOp,
  applyPayload,
  axisFromWheel,
  decodeImageTiles,
  dirtyBounds,
  evdevFromCode,
  pointerButtonFromDom,
  pointerPosition,
  type AppSession,
  type InputEvent,
  type PixelPayload,
} from "@infrawrench/appstream-core";

/**
 * One window of a remote Linux application, painted onto a canvas.
 *
 * The canvas is sized in *buffer* pixels and scaled down by CSS, so a retina
 * display gets a window rendered at its own resolution rather than an upscaled
 * one — which is also why every pointer coordinate goes through
 * `pointerPosition` rather than being sent as-is.
 */
export interface AppWindowViewerProps {
  session: AppSession;
  windowId: number;
  /** Shown over the canvas until the first frame arrives. */
  status?: string;
  onClose?: () => void;
  className?: string;
}

/**
 * `fzstd` decompresses in JS; a wasm build would be faster but is an
 * optimisation, not a gate. The output buffer is pre-sized because the payload
 * header already says exactly how many pixel bytes to expect, which saves the
 * decompressor growing a buffer on every frame.
 */
function zstdDecompress(input: Uint8Array, expectedBytes: number): Uint8Array {
  return decompress(input, new Uint8Array(expectedBytes));
}

/**
 * Paint a lossy frame: one JPEG per damaged rectangle, decoded by the browser.
 *
 * Drawn straight onto the canvas — decoding to a pixel array first would mean
 * a second full copy of every frame, and the browser's own path is the reason
 * this tier costs the client nothing. The buffer is then read back so the two
 * stay in step: the *next* frame may be lossless, and a lossless frame may be
 * a difference against exactly these pixels.
 */
async function paintImageTiles(
  payload: PixelPayload,
  context: CanvasRenderingContext2D,
  buffer: { pixels: Uint8ClampedArray<ArrayBuffer>; width: number; height: number },
): Promise<void> {
  const tiles = decodeImageTiles(payload);
  let index = 0;
  const drawn: Array<Promise<void>> = [];
  for (const rect of payload.rects) {
    if (rect.op === RectOp.Solid) {
      // A solid carries no image; it is the same little-endian BGRA the
      // lossless path unpacks.
      const b = rect.solid & 0xff;
      const g = (rect.solid >>> 8) & 0xff;
      const r = (rect.solid >>> 16) & 0xff;
      const a = ((rect.solid >>> 24) & 0xff) / 255;
      context.fillStyle = `rgba(${r}, ${g}, ${b}, ${a})`;
      context.fillRect(rect.x, rect.y, rect.w, rect.h);
      continue;
    }
    const tile = tiles[index++];
    if (!tile) continue;
    // Copied into a fresh buffer: the payload is a view over the frame we were
    // handed, and `createImageBitmap` is asynchronous, so the underlying bytes
    // must not be something the transport can reuse underneath it.
    const blob = new Blob([new Uint8Array(tile)], { type: "image/jpeg" });
    drawn.push(
      createImageBitmap(blob).then((bitmap) => {
        context.drawImage(bitmap, rect.x, rect.y);
        bitmap.close();
      }),
    );
  }
  await Promise.all(drawn);
  // Read the canvas back so the buffer holds what the user is looking at. The
  // host knows a JPEG rectangle is approximate and will never send a delta
  // against one, but every *other* rectangle of the next frame may be one.
  buffer.pixels.set(context.getImageData(0, 0, buffer.width, buffer.height).data);
}

export function AppWindowViewer({
  session,
  windowId,
  status,
  onClose,
  className,
}: AppWindowViewerProps) {
  const gt = useGT();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  /** The RGBA buffer frames are applied to, kept between frames. */
  // Typed against a plain ArrayBuffer rather than ArrayBufferLike: `ImageData`
  // refuses a view that might be backed by a SharedArrayBuffer.
  const bufferRef = useRef<{
    pixels: Uint8ClampedArray<ArrayBuffer>;
    width: number;
    height: number;
    /** Kept rather than rebuilt per frame; it is a view, not a copy. */
    image: ImageData;
  } | null>(null);
  const [painted, setPainted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cursor, setCursor] = useState<string>("default");

  const scale = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;

  const paint = useCallback(async (payload: PixelPayload) => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let buffer = bufferRef.current;
    if (!buffer || buffer.width !== payload.width || buffer.height !== payload.height) {
      const pixels = new Uint8ClampedArray(new ArrayBuffer(payload.width * payload.height * 4));
      buffer = {
        pixels,
        width: payload.width,
        height: payload.height,
        image: new ImageData(pixels, payload.width, payload.height),
      };
      bufferRef.current = buffer;
      canvas.width = payload.width;
      canvas.height = payload.height;
    }

    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return;

    try {
      if (payload.codec === Codec.JpegTiles) {
        await paintImageTiles(payload, context, buffer);
      } else {
        applyPayload(payload, buffer.pixels, buffer.width, buffer.height, zstdDecompress);
        // Only the region the frame touched. Handing the whole canvas to
        // `putImageData` uploads every pixel of the window for a frame that
        // changed one line of a terminal — which on a HiDPI window is
        // megabytes, at whatever rate the application redraws.
        const dirty = dirtyBounds(payload);
        if (dirty) {
          context.putImageData(buffer.image, 0, 0, dirty.x, dirty.y, dirty.w, dirty.h);
        }
      }
    } catch (cause) {
      // A frame we cannot decode is not fatal — the next keyframe repairs the
      // window — but silently painting nothing looks like a hang.
      setError(cause instanceof Error ? cause.message : String(cause));
      return;
    }

    setError(null);
    setPainted(true);
  }, []);

  // Frames and cursor changes for this window.
  useEffect(() => {
    // Returning the promise is what makes the ack wait for the paint: on the
    // lossy tier the decode is the browser's and only finishes later.
    const handleFrame = (id: number, payload: PixelPayload) =>
      id === windowId ? paint(payload) : undefined;
    const handleCursor = (id: number, shape: string | undefined) => {
      if (id !== windowId) return;
      setCursor(cssCursor(shape));
    };
    session.addFrameListener(handleFrame);
    session.addCursorListener(handleCursor);
    return () => {
      session.removeFrameListener(handleFrame);
      session.removeCursorListener(handleCursor);
    };
  }, [session, windowId, paint]);

  // Attach on mount, detach on unmount: a tab in the background costs no
  // bandwidth, and the application keeps running either way.
  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return;
    const rect = surface.getBoundingClientRect();
    session.attach(
      windowId,
      Math.max(1, Math.round(rect.width * scale)),
      Math.max(1, Math.round(rect.height * scale)),
      scale,
    );
    return () => session.detach(windowId);
  }, [session, windowId, scale]);

  // Follow the tab's size. Debounced, because a drag-resize would otherwise
  // ask the application to relayout on every animation frame.
  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface || typeof ResizeObserver === "undefined") return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const { width, height } = entry.contentRect;
      clearTimeout(timer);
      timer = setTimeout(() => {
        session.resize(
          windowId,
          Math.max(1, Math.round(width * scale)),
          Math.max(1, Math.round(height * scale)),
          scale,
        );
      }, 120);
    });
    observer.observe(surface);
    return () => {
      clearTimeout(timer);
      observer.disconnect();
    };
  }, [session, windowId, scale]);

  const started = useMemo(() => Date.now(), []);
  const now = useCallback(() => (Date.now() - started) % 0xffffffff, [started]);

  const sendPointer = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>, extra?: InputEvent[]) => {
      const canvas = canvasRef.current;
      const buffer = bufferRef.current;
      if (!canvas || !buffer) return;
      const rect = canvas.getBoundingClientRect();
      // `object-contain` letterboxes: when the buffer's aspect ratio differs
      // from the box — which it does for the whole round trip of every resize,
      // and permanently if the application refuses a size — the picture is
      // centred inside the element with bars beside it. Measuring against the
      // element rather than the picture then puts the pointer somewhere the
      // user is not looking.
      const shown = containedRect(buffer.width, buffer.height, rect.width, rect.height);
      const { x, y } = pointerPosition(
        (event.clientX - rect.left - shown.left) * (buffer.width / shown.width),
        (event.clientY - rect.top - shown.top) * (buffer.height / shown.height),
        1,
      );
      session.sendInput(windowId, [
        { kind: "pointerMotion", timeMs: now(), x, y },
        ...(extra ?? []),
      ]);
    },
    [session, windowId, now],
  );

  const onKey = useCallback(
    (event: React.KeyboardEvent<HTMLCanvasElement>, state: ButtonState) => {
      const keycode = evdevFromCode(event.code);
      if (keycode === undefined) return;
      // The remote application owns every key while focused, including the
      // browser's own shortcuts — otherwise Ctrl-W closes the tab instead of
      // the document.
      event.preventDefault();
      session.sendInput(windowId, [{ kind: "key", timeMs: now(), keycode, state }]);
    },
    [session, windowId, now],
  );

  return (
    <div
      ref={surfaceRef}
      className={`relative h-full w-full overflow-hidden bg-surface-sunken ${className ?? ""}`}
    >
      <canvas
        ref={canvasRef}
        tabIndex={0}
        role="img"
        aria-label={gt("Remote application window")}
        className="h-full w-full object-contain outline-none"
        // Smooth rather than `pixelated`: the host renders at the next whole
        // scale up from this display's device pixel ratio, so at a fractional
        // ratio the canvas is *larger* than the box and the browser is
        // downsampling. Nearest-neighbour there throws away the extra detail
        // the bigger buffer was for.
        style={{ cursor, imageRendering: "auto" }}
        onPointerMove={(event) => sendPointer(event)}
        onPointerDown={(event) => {
          event.currentTarget.focus();
          const button = pointerButtonFromDom(event.button);
          if (button === undefined) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          sendPointer(event, [
            { kind: "pointerButton", timeMs: now(), button, state: ButtonState.Pressed },
          ]);
        }}
        onPointerUp={(event) => {
          const button = pointerButtonFromDom(event.button);
          if (button === undefined) return;
          event.currentTarget.releasePointerCapture(event.pointerId);
          sendPointer(event, [
            { kind: "pointerButton", timeMs: now(), button, state: ButtonState.Released },
          ]);
        }}
        onPointerLeave={() =>
          session.sendInput(windowId, [{ kind: "pointerLeave", timeMs: now() }])
        }
        onWheel={(event) => {
          const { dx, dy } = axisFromWheel(event);
          session.sendInput(windowId, [{ kind: "pointerAxis", timeMs: now(), dx, dy }]);
        }}
        onKeyDown={(event) => onKey(event, ButtonState.Pressed)}
        onKeyUp={(event) => onKey(event, ButtonState.Released)}
        onContextMenu={(event) => event.preventDefault()}
      />

      {!painted && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <p className="text-sm text-on-surface-muted">{status ?? gt("Waiting for the window…")}</p>
        </div>
      )}

      {error && (
        <div className="absolute bottom-3 left-3 right-3 rounded-md border border-warning-border bg-warning-surface px-3 py-2 text-xs text-warning-on-surface">
          {error}
        </div>
      )}

      {onClose && (
        <button
          type="button"
          onClick={onClose}
          className="absolute right-3 top-3 rounded-md border border-border bg-surface-overlay px-2 py-1 text-xs text-on-surface-secondary hover:text-on-surface"
        >
          <T>Close window</T>
        </button>
      )}
    </div>
  );
}

/**
 * Where `object-contain` actually paints an image inside its box.
 *
 * The picture keeps its aspect ratio and is centred, so one axis fills the box
 * and the other is inset by half the difference. Exported for the test that
 * pins it, because getting it wrong is invisible in a screenshot and obvious
 * to anyone trying to click something.
 */
export function containedRect(
  bufferWidth: number,
  bufferHeight: number,
  boxWidth: number,
  boxHeight: number,
): { left: number; top: number; width: number; height: number } {
  if (bufferWidth <= 0 || bufferHeight <= 0 || boxWidth <= 0 || boxHeight <= 0) {
    return { left: 0, top: 0, width: Math.max(1, boxWidth), height: Math.max(1, boxHeight) };
  }
  const scale = Math.min(boxWidth / bufferWidth, boxHeight / bufferHeight);
  const width = bufferWidth * scale;
  const height = bufferHeight * scale;
  return { left: (boxWidth - width) / 2, top: (boxHeight - height) / 2, width, height };
}

/**
 * Wayland cursor shape names to CSS cursors. The names come from
 * `wp_cursor_shape`, and the ones that do not map are left as the default
 * rather than guessed at.
 */
function cssCursor(shape: string | undefined): string {
  switch (shape) {
    case "none":
      return "none";
    case "text":
    case "xterm":
      return "text";
    case "pointer":
    case "hand":
      return "pointer";
    case "grab":
      return "grab";
    case "grabbing":
      return "grabbing";
    case "crosshair":
      return "crosshair";
    case "wait":
    case "watch":
      return "wait";
    case "progress":
      return "progress";
    case "not-allowed":
      return "not-allowed";
    case "col-resize":
    case "ew-resize":
      return "ew-resize";
    case "row-resize":
    case "ns-resize":
      return "ns-resize";
    default:
      return "default";
  }
}
