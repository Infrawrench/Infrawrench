/** Whether `Accept` ranks `text/markdown` at least as high as `text/html`. */
export function prefersMarkdown(accept: string | null): boolean {
  if (!accept) return false;
  let markdown = 0;
  let html = 0;
  for (const part of accept.split(",")) {
    const [type = "", ...params] = part.trim().toLowerCase().split(";");
    const q = Number(params.find((p) => p.trim().startsWith("q="))?.split("=")[1] ?? 1);
    if (type.trim() === "text/markdown") markdown = Math.max(markdown, q);
    else if (type.trim() === "text/html") html = Math.max(html, q);
  }
  return markdown > 0 && markdown >= html;
}
