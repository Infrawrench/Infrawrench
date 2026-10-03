/**
 * The hand-rolled HTML shared by every email part the server composes (the
 * weekly digest, scheduled report deliveries, invoices).
 *
 * Hand-rolled rather than templated: the markup is a handful of tags and a
 * templating dependency would buy nothing. Styles are inline because mail
 * clients strip `<style>` blocks, and the palette is deliberately neutral so
 * it reads in both light and dark clients.
 */

/** Escape text for an HTML text node or a double-quoted attribute value. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** The call-to-action button under the body, or "" when there is no link. */
export function emailButton(url: string | null | undefined, label: string): string {
  return url
    ? `<p style="margin:24px 0 0;"><a href="${escapeHtml(url)}" style="display:inline-block;padding:10px 16px;background:#2563eb;color:#ffffff;text-decoration:none;border-radius:8px;font-weight:600;">${label}</a></p>`
    : "";
}

/** Wrap already-rendered blocks in the email container; empty blocks are dropped. */
export function emailDocument(blocks: string[]): string {
  return [
    `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.5;color:#1f2937;max-width:640px;">`,
    ...blocks,
    `</div>`,
  ]
    .filter((s) => s !== "")
    .join("\n");
}
