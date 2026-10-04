/**
 * A minimal PDF 1.4 writer: pages of vector shapes and text, nothing else.
 *
 * Why hand-rolled rather than a library: the documents this codebase renders
 * (cost charts, budget bars, tables, KPI tiles) need rectangles, lines,
 * filled polygons and Helvetica, which is a few hundred lines of a format
 * that has been stable since 2001. A PDF library would be a dependency to
 * audit and upgrade in every web pod for exactly that subset, and a headless
 * browser (the other common route) would put Chromium in the web pods. The
 * same reasoning the email transport gives for not carrying a Mailgun SDK.
 *
 * What it does: pages, the two standard Helvetica faces (no font embedding,
 * see `fonts.ts`), RGB fill and stroke, line width and dash, rectangles,
 * polylines and filled polygons, single-line text, URI link annotations, and
 * Flate-compressed content streams via `node:zlib`. Coordinates are points
 * from the **top-left** corner, converted to PDF's bottom-left origin here
 * so the layout code reads like any other 2D canvas.
 *
 * Pure apart from the clock in the info dictionary (injectable): bytes out,
 * no I/O, unit-testable.
 */
import { deflateSync } from "node:zlib";
import { PDF_BASE_FONTS, toWinAnsi, type PdfFontName } from "./fonts";

/** A colour as `#rrggbb`. */
export type PdfColor = string;

/** A4 portrait, in points. */
export const A4 = { width: 595.28, height: 841.89 } as const;

function num(n: number): string {
  if (!Number.isFinite(n)) return "0";
  const fixed = n.toFixed(2);
  return fixed.replace(/\.?0+$/, "") || "0";
}

function rgb(color: PdfColor): string {
  const hex = color.replace("#", "");
  const full =
    hex.length === 3
      ? hex
          .split("")
          .map((c) => c + c)
          .join("")
      : hex.padEnd(6, "0").slice(0, 6);
  const r = Number.parseInt(full.slice(0, 2), 16) / 255;
  const g = Number.parseInt(full.slice(2, 4), 16) / 255;
  const b = Number.parseInt(full.slice(4, 6), 16) / 255;
  return `${num(Number.isFinite(r) ? r : 0)} ${num(Number.isFinite(g) ? g : 0)} ${num(Number.isFinite(b) ? b : 0)}`;
}

/** A string as a PDF hex string of WinAnsi bytes: no escaping rules to get wrong. */
function hexString(text: string): string {
  return `<${toWinAnsi(text)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")}>`;
}

/** A string as a PDF literal string, for the info dictionary and URIs. */
function literalString(text: string): string {
  const bytes = toWinAnsi(text);
  let out = "(";
  for (const b of bytes) {
    const ch = String.fromCharCode(b);
    if (ch === "(" || ch === ")" || ch === "\\") out += `\\${ch}`;
    else if (b < 0x20 || b > 0x7e) out += `\\${b.toString(8).padStart(3, "0")}`;
    else out += ch;
  }
  return `${out})`;
}

export interface TextOptions {
  size?: number;
  font?: PdfFontName;
  color?: PdfColor;
}

export interface ShapeStyle {
  fill?: PdfColor | undefined;
  stroke?: PdfColor | undefined;
  lineWidth?: number | undefined;
  /** Dash pattern in points, e.g. `[3, 2]`. */
  dash?: number[] | undefined;
}

interface LinkAnnotation {
  x: number;
  y: number;
  width: number;
  height: number;
  uri: string;
}

/** One page's drawing operations. Top-left origin. */
export class PdfPage {
  readonly ops: string[] = [];
  readonly links: LinkAnnotation[] = [];

  constructor(
    readonly width: number,
    readonly height: number,
  ) {}

  private y(top: number): number {
    return this.height - top;
  }

  private applyStyle(style: ShapeStyle): string | null {
    const parts: string[] = [];
    if (style.fill) parts.push(`${rgb(style.fill)} rg`);
    if (style.stroke) {
      parts.push(`${rgb(style.stroke)} RG`);
      parts.push(`${num(style.lineWidth ?? 1)} w`);
      parts.push(
        style.dash && style.dash.length > 0 ? `[${style.dash.map(num).join(" ")}] 0 d` : "[] 0 d",
      );
    }
    if (!style.fill && !style.stroke) return null;
    this.ops.push(parts.join(" "));
    return style.fill && style.stroke ? "B" : style.fill ? "f" : "S";
  }

  rect(x: number, top: number, width: number, height: number, style: ShapeStyle): void {
    if (width <= 0 || height <= 0) return;
    this.ops.push("q");
    const paint = this.applyStyle(style);
    if (paint) {
      this.ops.push(
        `${num(x)} ${num(this.y(top + height))} ${num(width)} ${num(height)} re ${paint}`,
      );
    }
    this.ops.push("Q");
  }

  line(x1: number, y1: number, x2: number, y2: number, style: ShapeStyle): void {
    this.polyline(
      [
        [x1, y1],
        [x2, y2],
      ],
      style,
    );
  }

  /** An open path through the points (stroke only). */
  polyline(points: Array<[number, number]>, style: ShapeStyle): void {
    if (points.length < 2 || !style.stroke) return;
    this.ops.push("q");
    this.applyStyle({ ...style, fill: undefined });
    const [first, ...rest] = points;
    const path = [`${num(first![0])} ${num(this.y(first![1]))} m`];
    for (const [px, py] of rest) path.push(`${num(px)} ${num(this.y(py))} l`);
    this.ops.push(`${path.join(" ")} S`);
    this.ops.push("Q");
  }

  /** A closed, filled (and optionally stroked) polygon. */
  polygon(points: Array<[number, number]>, style: ShapeStyle): void {
    if (points.length < 3) return;
    this.ops.push("q");
    const paint = this.applyStyle(style);
    if (paint) {
      const [first, ...rest] = points;
      const path = [`${num(first![0])} ${num(this.y(first![1]))} m`];
      for (const [px, py] of rest) path.push(`${num(px)} ${num(this.y(py))} l`);
      this.ops.push(`${path.join(" ")} h ${paint}`);
    }
    this.ops.push("Q");
  }

  /**
   * Single-line text with its **baseline** at `top + size * 0.8`, so `top`
   * reads as the top of the line box like everywhere else in the layout.
   */
  text(x: number, top: number, text: string, opts: TextOptions = {}): void {
    if (!text) return;
    const size = opts.size ?? 10;
    const font = opts.font === "bold" ? "F2" : "F1";
    const baseline = this.y(top + size * 0.8);
    this.ops.push(
      `BT ${rgb(opts.color ?? "#111827")} rg /${font} ${num(size)} Tf ${num(x)} ${num(baseline)} Td ${hexString(text)} Tj ET`,
    );
  }

  /** A clickable rectangle that opens `uri`. */
  link(x: number, top: number, width: number, height: number, uri: string): void {
    this.links.push({ x, y: this.y(top + height), width, height, uri });
  }
}

export interface PdfDocumentInfo {
  title: string;
  author?: string | undefined;
  subject?: string | undefined;
}

/** A document: an ordered list of pages, serialized by {@link PdfDocument.toBytes}. */
export class PdfDocument {
  readonly pages: PdfPage[] = [];

  constructor(
    readonly info: PdfDocumentInfo,
    readonly pageSize: { width: number; height: number } = A4,
  ) {}

  addPage(): PdfPage {
    const page = new PdfPage(this.pageSize.width, this.pageSize.height);
    this.pages.push(page);
    return page;
  }

  /** Serialize. `now` stamps the info dictionary's creation date. */
  toBytes(now = new Date()): Uint8Array {
    if (this.pages.length === 0) this.addPage();

    // Object numbering: 1 catalog, 2 page tree, 3 + 4 fonts, 5 info, then per
    // page a page object, its content stream, and one object per link.
    const objects: Array<Buffer> = [];
    const set = (n: number, body: Buffer | string) => {
      objects[n] = typeof body === "string" ? Buffer.from(body, "latin1") : body;
    };

    let next = 6;
    const pageIds: number[] = [];
    for (const page of this.pages) {
      const pageId = next++;
      const contentId = next++;
      const linkIds = page.links.map(() => next++);
      pageIds.push(pageId);

      const stream = deflateSync(Buffer.from(page.ops.join("\n"), "latin1"));
      set(
        contentId,
        Buffer.concat([
          Buffer.from(`<< /Length ${stream.length} /Filter /FlateDecode >>\nstream\n`, "latin1"),
          stream,
          Buffer.from("\nendstream", "latin1"),
        ]),
      );
      page.links.forEach((link, i) => {
        set(
          linkIds[i]!,
          `<< /Type /Annot /Subtype /Link /Rect [${num(link.x)} ${num(link.y)} ${num(link.x + link.width)} ${num(link.y + link.height)}] /Border [0 0 0] /A << /S /URI /URI ${literalString(link.uri)} >> >>`,
        );
      });
      set(
        pageId,
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(page.width)} ${num(page.height)}] ` +
          `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentId} 0 R` +
          (linkIds.length > 0 ? ` /Annots [${linkIds.map((id) => `${id} 0 R`).join(" ")}]` : "") +
          " >>",
      );
    }

    set(1, "<< /Type /Catalog /Pages 2 0 R >>");
    set(
      2,
      `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`,
    );
    set(
      3,
      `<< /Type /Font /Subtype /Type1 /BaseFont /${PDF_BASE_FONTS.regular} /Encoding /WinAnsiEncoding >>`,
    );
    set(
      4,
      `<< /Type /Font /Subtype /Type1 /BaseFont /${PDF_BASE_FONTS.bold} /Encoding /WinAnsiEncoding >>`,
    );
    const pad = (n: number) => String(n).padStart(2, "0");
    const date = `D:${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`;
    set(
      5,
      `<< /Title ${literalString(this.info.title)} /Producer (Infrawrench) /Creator (Infrawrench)` +
        (this.info.author ? ` /Author ${literalString(this.info.author)}` : "") +
        (this.info.subject ? ` /Subject ${literalString(this.info.subject)}` : "") +
        ` /CreationDate (${date}) >>`,
    );

    // The header's second line is four bytes above 0x7F, the conventional
    // signal to transfer tools that the file is binary.
    const chunks: Buffer[] = [Buffer.from("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n", "latin1")];
    let offset = chunks[0]!.length;
    const offsets: number[] = [];
    for (let n = 1; n < objects.length; n++) {
      const body = objects[n];
      if (!body) continue;
      offsets[n] = offset;
      const chunk = Buffer.concat([
        Buffer.from(`${n} 0 obj\n`, "latin1"),
        body,
        Buffer.from("\nendobj\n", "latin1"),
      ]);
      chunks.push(chunk);
      offset += chunk.length;
    }

    const xrefOffset = offset;
    const xref = [`xref\n0 ${objects.length}\n`, "0000000000 65535 f \n"];
    for (let n = 1; n < objects.length; n++) {
      xref.push(`${String(offsets[n] ?? 0).padStart(10, "0")} 00000 n \n`);
    }
    xref.push(
      `trailer\n<< /Size ${objects.length} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`,
    );
    chunks.push(Buffer.from(xref.join(""), "latin1"));
    return new Uint8Array(Buffer.concat(chunks));
  }
}
