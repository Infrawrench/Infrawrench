/**
 * A picture someone chose, made ready to upload as an organisation's: the
 * centre square of it, no larger than {@link AVATAR_SIDE}, drawn again by
 * the browser. Drawing it again is what makes a camera's photo small enough
 * and leaves its metadata (where it was taken) behind. The Worker checks
 * what arrives all the same (contract `inspectAvatar`).
 */
import { AVATAR_LIMITS } from "@infrawrench/git-contract";

/** The side of the square that is uploaded, in pixels. */
export const AVATAR_SIDE = 512;

/** What a file input offers. What the file is is read from its bytes, here and on the server. */
export const AVATAR_ACCEPT = "image/png,image/jpeg,image/webp";

export interface SquareCrop {
  /** The top left corner of the square in the source. */
  readonly sx: number;
  readonly sy: number;
  /** The side of the square in the source. */
  readonly side: number;
  /** The side it is drawn at: never larger than the source's. */
  readonly size: number;
}

/** The centre square of a `width` by `height` picture, drawn at `max` pixels at most. */
export function centreSquare(width: number, height: number, max: number = AVATAR_SIDE): SquareCrop {
  const side = Math.min(width, height);
  return {
    sx: Math.floor((width - side) / 2),
    sy: Math.floor((height - side) / 2),
    side,
    size: Math.min(side, max),
  };
}

const toBlob = (canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> =>
  new Promise((resolve) => canvas.toBlob(resolve, type, quality));

const toBase64 = async (blob: Blob): Promise<string> => {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let text = "";
  for (let at = 0; at < bytes.length; at += 0x8000) {
    text += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  }
  return btoa(text);
};

/**
 * The chosen file as the base64 of a square PNG (or a JPEG, when the PNG
 * would be past the limit). Rejects with a sentence when the browser cannot
 * read the file as a picture.
 */
export async function prepareAvatar(file: Blob): Promise<string> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error("The picture must be a PNG, JPEG or WebP image");
  }
  try {
    const crop = centreSquare(bitmap.width, bitmap.height);
    if (crop.size < AVATAR_LIMITS.minDimension) {
      throw new Error(
        `The picture must be at least ${AVATAR_LIMITS.minDimension} pixels on each side`,
      );
    }
    const canvas = document.createElement("canvas");
    canvas.width = crop.size;
    canvas.height = crop.size;
    const context = canvas.getContext("2d");
    if (context === null) throw new Error("This browser cannot prepare the picture");
    context.imageSmoothingQuality = "high";
    context.drawImage(bitmap, crop.sx, crop.sy, crop.side, crop.side, 0, 0, crop.size, crop.size);
    const png = await toBlob(canvas, "image/png");
    if (png !== null && png.size <= AVATAR_LIMITS.maxBytes) return toBase64(png);
    const jpeg = await toBlob(canvas, "image/jpeg", 0.9);
    if (jpeg !== null && jpeg.size <= AVATAR_LIMITS.maxBytes) return toBase64(jpeg);
    throw new Error("The picture must be 1 MB or smaller");
  } finally {
    bitmap.close();
  }
}
