/** One sample from the Prometheus text exposition format. */
export interface PromSample {
  name: string;
  labels: Record<string, string>;
  value: number;
}

const LINE = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{(.*)\})?\s+(\S+)/;
const LABEL = /([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g;

/** Parse Prometheus text, skipping comments and non-numeric values. */
export function parsePrometheus(text: string): PromSample[] {
  const out: PromSample[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = LINE.exec(line);
    if (!m) continue;
    const value = Number(m[3]);
    if (!Number.isFinite(value)) continue;
    const labels: Record<string, string> = {};
    for (const l of (m[2] ?? "").matchAll(LABEL)) {
      labels[l[1]!] = l[2]!.replace(/\\(.)/g, "$1");
    }
    out.push({ name: m[1]!, labels, value });
  }
  return out;
}
