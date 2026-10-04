/**
 * Save a Blob through the browser's own download path: an object URL on a
 * transient anchor. Shared by web (a `fetch` body) and desktop (bytes from an
 * IPC handler), so an exported PDF lands the same way on both.
 *
 * The URL is revoked on the next tick rather than immediately: some engines
 * start the download asynchronously and a synchronous revoke cancels it.
 */
export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** {@link downloadBlob} for raw PDF bytes, the shape the desktop IPC returns. */
export function downloadPdfBytes(bytes: Uint8Array, fileName: string): void {
  // Copy into a fresh ArrayBuffer-backed view: an IPC payload's buffer is
  // typed `ArrayBufferLike`, which `BlobPart` does not accept.
  downloadBlob(new Blob([new Uint8Array(bytes)], { type: "application/pdf" }), fileName);
}
