import { deflateSync, inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import type { ManagedInvoice } from "@infrawrench/client-core";
import { PdfImageError, readImageDataUrl, readJpeg, readPng } from "../pdf/image";
import { PdfDocument } from "../pdf/writer";
import { renderInvoicePdf } from "../cost/invoice-pdf";

/** A PNG built by hand: the decoder skips CRCs, so these are zero. */
function png(opts: {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
  interlace?: number;
  /** Unfiltered scanlines, without the filter byte. */
  rows: number[][];
  filter?: number;
  palette?: number[];
  trns?: number[];
}): Uint8Array {
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length);
    new DataView(out.buffer).setUint32(0, data.length);
    out.set(
      [...type].map((c) => c.charCodeAt(0)),
      4,
    );
    out.set(data, 8);
    return out;
  };
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, opts.width);
  view.setUint32(4, opts.height);
  ihdr.set([opts.bitDepth, opts.colorType, 0, 0, opts.interlace ?? 0], 8);
  const raw = opts.rows.flatMap((row) => [opts.filter ?? 0, ...row]);
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    ...(opts.palette ? [chunk("PLTE", new Uint8Array(opts.palette))] : []),
    ...(opts.trns ? [chunk("tRNS", new Uint8Array(opts.trns))] : []),
    chunk("IDAT", new Uint8Array(deflateSync(new Uint8Array(raw)))),
    chunk("IEND", new Uint8Array(0)),
  ];
  return new Uint8Array(Buffer.concat(parts.map((p) => Buffer.from(p))));
}

const rgbOf = (image: { data: Uint8Array }) => [...inflateSync(image.data)];

describe("readPng", () => {
  it("decodes RGBA and splits the transparency into a soft mask", () => {
    const image = readPng(
      png({
        width: 2,
        height: 1,
        bitDepth: 8,
        colorType: 6,
        rows: [[255, 0, 0, 255, 0, 0, 255, 0]],
      }),
    );
    expect(image).toMatchObject({ width: 2, height: 1, colorSpace: "DeviceRGB" });
    expect(rgbOf(image)).toEqual([255, 0, 0, 0, 0, 255]);
    expect([...inflateSync(image.smask!)]).toEqual([255, 0]);
  });

  it("leaves out the mask when every pixel is opaque", () => {
    const image = readPng(
      png({ width: 1, height: 1, bitDepth: 8, colorType: 2, rows: [[1, 2, 3]] }),
    );
    expect(image.smask).toBeUndefined();
    expect(rgbOf(image)).toEqual([1, 2, 3]);
  });

  it("expands a 1-bit palette with tRNS alpha", () => {
    const image = readPng(
      png({
        width: 3,
        height: 1,
        bitDepth: 1,
        colorType: 3,
        // indices 1, 0, 1 packed high bit first
        rows: [[0b10100000]],
        palette: [10, 20, 30, 200, 210, 220],
        trns: [0],
      }),
    );
    expect(rgbOf(image)).toEqual([200, 210, 220, 10, 20, 30, 200, 210, 220]);
    expect([...inflateSync(image.smask!)]).toEqual([255, 0, 255]);
  });

  it("undoes the Sub and Up filters", () => {
    const image = readPng(
      png({
        width: 2,
        height: 2,
        bitDepth: 8,
        colorType: 0,
        filter: 1,
        rows: [
          [10, 5],
          [20, 1],
        ],
      }),
    );
    expect(rgbOf(image)).toEqual([10, 10, 10, 15, 15, 15, 20, 20, 20, 21, 21, 21]);
  });

  it("refuses interlaced and 16-bit images with a message to act on", () => {
    expect(() =>
      readPng(
        png({ width: 1, height: 1, bitDepth: 8, colorType: 2, interlace: 1, rows: [[0, 0, 0]] }),
      ),
    ).toThrow(/Interlaced/);
    expect(() =>
      readPng(png({ width: 1, height: 1, bitDepth: 16, colorType: 2, rows: [[0, 0, 0, 0, 0, 0]] })),
    ).toThrow(/16-bit/);
    expect(() => readPng(new Uint8Array([1, 2, 3]))).toThrow(PdfImageError);
  });

  it("caps the pixel count before allocating anything", () => {
    expect(() =>
      readPng(png({ width: 5000, height: 5000, bitDepth: 8, colorType: 0, rows: [] })),
    ).toThrow(/too large/);
  });
});

describe("readJpeg", () => {
  it("reads the frame header and passes the bytes through", () => {
    const bytes = new Uint8Array([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x20,
      0x00, 0x40, 0x03, 0x01, 0x11, 0x00, 0xff, 0xd9,
    ]);
    const image = readJpeg(bytes);
    expect(image).toMatchObject({
      width: 64,
      height: 32,
      colorSpace: "DeviceRGB",
      filter: "DCTDecode",
    });
    expect(image.data).toBe(bytes);
  });

  it("reads a data URL by its declared type", () => {
    const url = `data:image/png;base64,${Buffer.from(
      png({ width: 1, height: 1, bitDepth: 8, colorType: 2, rows: [[9, 9, 9]] }),
    ).toString("base64")}`;
    expect(readImageDataUrl(url).width).toBe(1);
    expect(() => readImageDataUrl("data:image/gif;base64,AAAA")).toThrow(PdfImageError);
  });
});

describe("PdfDocument images", () => {
  it("writes the image and its mask once and references them from every page", () => {
    const doc = new PdfDocument({ title: "t" });
    const name = doc.addImage(
      readPng(png({ width: 1, height: 1, bitDepth: 8, colorType: 6, rows: [[1, 2, 3, 4]] })),
    );
    doc.addPage().image(name, 10, 10, 20, 20);
    doc.addPage();
    const text = Buffer.from(doc.toBytes(new Date(0))).toString("latin1");
    expect(text.match(/\/Subtype \/Image/g)).toHaveLength(2);
    expect(text).toContain("/SMask");
    expect(text.match(/\/XObject << \/Im1 6 0 R >>/g)).toHaveLength(2);
  });
});

function invoice(overrides: Partial<ManagedInvoice> = {}): ManagedInvoice {
  return {
    id: "inv-1",
    managedAccountId: "cust-1",
    managedAccountName: "Northwind Trading",
    number: "NW-2026-0100",
    status: "approved",
    periodFrom: "2026-01-01",
    periodTo: "2026-01-31",
    currency: "GBP",
    notes: "Thank you for your business.",
    lines: [
      {
        kind: "cost_centre",
        refId: "cc",
        label: "Platform",
        currency: "USD",
        collected: 1000,
        adjustment: 150,
        adjusted: 1150,
        rate: 0.8,
        billed: 920,
      },
      {
        kind: "tax",
        refId: null,
        label: "VAT (20%)",
        currency: "GBP",
        collected: 0,
        adjustment: 184,
        adjusted: 184,
        rate: 1,
        billed: 184,
      },
    ],
    totals: {
      collected: { USD: 1000, GBP: 0 },
      adjustment: { USD: 150, GBP: 184 },
      adjusted: { USD: 1150, GBP: 184 },
      billed: { GBP: 1104 },
    },
    derivation: {
      costBasis: "amortized",
      applyBillingRules: true,
      rateDate: "2026-01-31",
      rates: [{ currency: "USD", rate: 0.8, effectiveFrom: "2026-01-01" }],
      unconverted: [],
      rules: [],
      scope: { costCentres: [], accounts: [] },
      missingScope: [],
    },
    billing: {
      profileId: "bp-1",
      profileName: "EU",
      legalName: "Northwind Trading GmbH",
      attention: "Ada",
      address: "Hauptstrasse 1\n10115 Berlin",
      taxId: "DE123456789",
      poNumber: "PO-778",
      to: ["ap@northwind.example"],
      cc: [],
      paymentTermsDays: 30,
      issueDate: "2026-02-02",
      dueDate: "2026-03-04",
      taxRates: [{ name: "VAT", rate: 20 }],
      bank: {
        accountName: "Fabrikam Ltd",
        bankName: null,
        iban: "GB82 WEST 1234 5698 7654 32",
        bic: "WESTGB2L",
        accountNumber: null,
        routingNumber: null,
        instructions: null,
      },
      footer: "Registered in Berlin.",
      logoId: null,
      numberPrefix: "NW",
      numberIncludesYear: true,
    },
    live: false,
    computedAt: "2026-02-02T10:00:00.000Z",
    issuedAt: "2026-02-02T10:00:00.000Z",
    approvedByUserId: "u",
    sentAt: null,
    sentByUserId: null,
    delivery: null,
    voidedAt: null,
    voidedByUserId: null,
    voidReason: null,
    supersedesInvoiceId: null,
    supersededByInvoiceId: null,
    createdByUserId: "u",
    createdAt: "2026-02-01T09:00:00.000Z",
    updatedAt: "2026-02-02T10:00:00.000Z",
    ...overrides,
  };
}

/** Every string drawn, in order, decoded from the hex the writer emits. */
function drawnText(bytes: Uint8Array): string[] {
  const pdf = Buffer.from(bytes).toString("latin1");
  const out: string[] = [];
  for (const m of pdf.matchAll(/stream\n([\s\S]*?)\nendstream/g)) {
    let body: string;
    try {
      body = inflateSync(Buffer.from(m[1]!, "latin1")).toString("latin1");
    } catch {
      continue;
    }
    for (const t of body.matchAll(/<([0-9a-f]+)> Tj/g)) {
      out.push(Buffer.from(t[1]!, "hex").toString("latin1"));
    }
  }
  return out;
}

describe("renderInvoicePdf", () => {
  it("prints the addressee, terms, tax and bank details from the frozen billing block", () => {
    const text = drawnText(
      renderInvoicePdf(invoice(), { issuerName: "Fabrikam Cloud", logo: null }),
    );
    for (const expected of [
      "INVOICE",
      "NW-2026-0100",
      "Northwind Trading GmbH",
      "Attn: Ada",
      "Hauptstrasse 1",
      "Tax ID: DE123456789",
      "PO-778",
      "2026-03-04 (Net 30)",
      "VAT (20%)",
      "IBAN: GB82 WEST 1234 5698 7654 32",
      "SWIFT/BIC: WESTGB2L",
      "Registered in Berlin.",
      "Page 1 of 1",
    ]) {
      expect(text.some((t) => t.includes(expected))).toBe(true);
    }
    // A customer is billed a price: the provider's collected cost stays in the CSV.
    expect(text.some((t) => t.includes("1,000"))).toBe(false);
  });

  it("watermarks a draft and spills long invoices onto more pages", () => {
    const many = Array.from({ length: 60 }, (_, i) => ({
      ...invoice().lines[0]!,
      label: `Centre ${i}`,
    }));
    const text = drawnText(
      renderInvoicePdf(invoice({ status: "draft", number: null, lines: many }), {
        issuerName: null,
        logo: null,
      }),
    );
    expect(text).toContain("DRAFT INVOICE");
    expect(text.some((t) => /^Page 1 of [2-9]$/.test(t))).toBe(true);
  });

  it("draws a logo and survives one that will not decode", () => {
    const logo = `data:image/png;base64,${Buffer.from(
      png({ width: 1, height: 1, bitDepth: 8, colorType: 2, rows: [[9, 9, 9]] }),
    ).toString("base64")}`;
    const withLogo = Buffer.from(renderInvoicePdf(invoice(), { issuerName: "F", logo })).toString(
      "latin1",
    );
    expect(withLogo).toContain("/Subtype /Image");
    const broken = renderInvoicePdf(invoice(), {
      issuerName: "F",
      logo: "data:image/png;base64,AAAA",
    });
    expect(Buffer.from(broken).subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });
});
