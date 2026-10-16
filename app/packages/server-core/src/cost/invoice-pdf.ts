/**
 * An invoice as a PDF: the document a customer files, beside the CSV that
 * carries the derivation.
 *
 * The two answer different readers. The CSV is for whoever checks the
 * arithmetic, so it shows what was collected, what the rules added and the
 * rate. The PDF is for whoever pays it, so it shows what a bill shows: who it
 * is to, what for, how much, by when, and where the money goes. It prints the
 * same lines and the same totals as the CSV, so the two always agree, but it
 * does not print the collected-versus-adjusted split: a customer is billed a
 * price, and the provider's own cost is not part of that document.
 *
 * Every field comes from the invoice itself: the figures and the billing
 * snapshot frozen at approval (live on a draft, which is watermarked as such).
 * Nothing here reads a profile, so a profile edited after approval cannot
 * change what a reprinted PDF says.
 */
import {
  describePaymentTerms,
  type ManagedInvoice,
  type ManagedInvoiceBilling,
} from "@infrawrench/client-core";
import { textWidth, truncateText, wrapText } from "../pdf/fonts";
import { PdfImageError, readImageDataUrl } from "../pdf/image";
import { A4, PdfDocument, type PdfPage } from "../pdf/writer";

const MARGIN = 48;
const WIDTH = A4.width - MARGIN * 2;
const INK = "#111827";
const MUTED = "#6b7280";
const RULE = "#e5e7eb";
const DANGER = "#b91c1c";
const ROW = 18;
/** Below this, a new page starts. Leaves room for the footer. */
const BOTTOM = A4.height - 120;

function money(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

/** Right-aligned text whose right edge is `right`. */
function textRight(
  page: PdfPage,
  right: number,
  top: number,
  text: string,
  opts: { size?: number; font?: "regular" | "bold"; color?: string } = {},
): void {
  const size = opts.size ?? 10;
  page.text(right - textWidth(text, size, opts.font ?? "regular"), top, text, opts);
}

export interface InvoicePdfOptions {
  /** The issuing organisation's display name. */
  issuerName: string | null;
  /** The logo as a data URL, already resolved from the snapshot's `logoId`. */
  logo: string | null;
  /** Billing for an invoice approved before profiles existed. */
  fallbackBilling?: ManagedInvoiceBilling | null | undefined;
}

/** Render one invoice. Pure: bytes out. */
export function renderInvoicePdf(invoice: ManagedInvoice, options: InvoicePdfOptions): Uint8Array {
  const billing = invoice.billing ?? options.fallbackBilling ?? null;
  const number = invoice.number ?? "Draft";
  const doc = new PdfDocument({
    title: `Invoice ${number}`,
    author: options.issuerName ?? undefined,
    subject: `${invoice.managedAccountName}, ${invoice.periodFrom} to ${invoice.periodTo}`,
  });

  let logoName: string | null = null;
  let logoSize = { width: 0, height: 0 };
  if (options.logo) {
    try {
      const image = readImageDataUrl(options.logo);
      logoName = doc.addImage(image);
      // Fit within 160 × 56 points, keeping the aspect ratio.
      const scale = Math.min(160 / image.width, 56 / image.height, 1);
      logoSize = { width: image.width * scale, height: image.height * scale };
    } catch (e) {
      // A logo that will not decode costs the logo, never the invoice.
      if (!(e instanceof PdfImageError)) throw e;
    }
  }

  let page = doc.addPage();
  let y = MARGIN;

  /* -- header -- */

  if (logoName) {
    page.image(logoName, MARGIN, y, logoSize.width, logoSize.height);
  } else if (options.issuerName) {
    page.text(MARGIN, y + 4, truncateText(options.issuerName, WIDTH / 2, 16, "bold"), {
      size: 16,
      font: "bold",
    });
  }
  const title = invoice.status === "draft" ? "DRAFT INVOICE" : "INVOICE";
  textRight(page, MARGIN + WIDTH, y, title, { size: 20, font: "bold" });
  textRight(page, MARGIN + WIDTH, y + 26, number, { size: 11, color: MUTED });
  y += Math.max(logoName ? logoSize.height : 24, 44) + 10;
  if (logoName && options.issuerName) {
    page.text(MARGIN, y, options.issuerName, { size: 10, font: "bold" });
    y += 16;
  }

  if (invoice.status === "draft") {
    page.text(
      MARGIN,
      y,
      "Draft: these figures follow live spend and are not final until the invoice is approved.",
      { size: 9, color: DANGER },
    );
    y += 16;
  } else if (invoice.status === "void") {
    for (const line of wrapText(
      `VOID${invoice.voidReason ? `: ${invoice.voidReason}` : ""}`,
      WIDTH,
      10,
      "bold",
    )) {
      page.text(MARGIN, y, line, { size: 10, font: "bold", color: DANGER });
      y += 14;
    }
    y += 2;
  }
  y += 8;

  /* -- bill to (left) and the facts (right) -- */

  const blockTop = y;
  const leftWidth = WIDTH * 0.55;
  page.text(MARGIN, y, "BILL TO", { size: 8, font: "bold", color: MUTED });
  y += 13;
  const legalName = billing?.legalName ?? invoice.managedAccountName;
  for (const line of wrapText(legalName, leftWidth, 11, "bold")) {
    page.text(MARGIN, y, line, { size: 11, font: "bold" });
    y += 15;
  }
  const leftLines: string[] = [];
  if (billing?.attention) leftLines.push(`Attn: ${billing.attention}`);
  if (billing?.address) leftLines.push(...billing.address.split(/\r?\n/));
  if (billing?.taxId) leftLines.push(`Tax ID: ${billing.taxId}`);
  for (const raw of leftLines) {
    for (const line of wrapText(raw, leftWidth, 10)) {
      page.text(MARGIN, y, line, { size: 10 });
      y += 13;
    }
  }
  const leftBottom = y;

  const facts: Array<[string, string]> = [];
  facts.push(["Invoice number", number]);
  if (billing?.issueDate || invoice.issuedAt) {
    facts.push(["Issue date", billing?.issueDate ?? invoice.issuedAt!.slice(0, 10)]);
  }
  if (billing?.dueDate) {
    const terms = describePaymentTerms(billing.paymentTermsDays);
    facts.push(["Due date", terms ? `${billing.dueDate} (${terms})` : billing.dueDate]);
  }
  facts.push(["Period", `${invoice.periodFrom} to ${invoice.periodTo}`]);
  if (billing?.poNumber) facts.push(["PO number", billing.poNumber]);
  facts.push(["Currency", invoice.currency]);
  let fy = blockTop;
  const labelX = MARGIN + leftWidth + 16;
  for (const [label, value] of facts) {
    page.text(labelX, fy, label, { size: 9, color: MUTED });
    textRight(page, MARGIN + WIDTH, fy, truncateText(value, 150, 10), { size: 10 });
    fy += 15;
  }
  y = Math.max(leftBottom, fy) + 18;

  /* -- the lines -- */

  const amountRight = MARGIN + WIDTH;
  const header = (p: PdfPage, top: number): number => {
    p.text(MARGIN, top, "DESCRIPTION", { size: 8, font: "bold", color: MUTED });
    textRight(p, amountRight, top, "AMOUNT", { size: 8, font: "bold", color: MUTED });
    p.line(MARGIN, top + 13, MARGIN + WIDTH, top + 13, { stroke: RULE, lineWidth: 1 });
    return top + 20;
  };
  y = header(page, y);
  const ensureRoom = (needed: number) => {
    if (y + needed <= BOTTOM) return;
    page = doc.addPage();
    y = header(page, MARGIN);
  };

  const kindLabel: Record<string, string> = {
    cost_centre: "Cost centre",
    account: "Cloud account",
    fixed: "Fixed charge",
  };
  const itemLines = invoice.lines.filter((l) => l.kind !== "tax");
  const taxLines = invoice.lines.filter((l) => l.kind === "tax");
  if (itemLines.length === 0) {
    page.text(MARGIN, y, "No charges in this period.", { size: 10, color: MUTED });
    y += ROW;
  }
  for (const line of itemLines) {
    ensureRoom(ROW);
    page.text(MARGIN, y, truncateText(line.label, WIDTH - 170, 10), { size: 10 });
    const kind = kindLabel[line.kind];
    if (kind) {
      const labelWidth = Math.min(textWidth(line.label, 10), WIDTH - 170);
      page.text(MARGIN + labelWidth + 8, y + 1, kind, { size: 8, color: MUTED });
    }
    const amount =
      line.billed === null
        ? `${money(line.adjusted, line.currency)} (no rate)`
        : money(line.billed, invoice.currency);
    textRight(page, amountRight, y, amount, {
      size: 10,
      ...(line.billed === null ? { color: DANGER } : {}),
    });
    y += ROW;
  }

  /* -- totals -- */

  ensureRoom(ROW * (taxLines.length + 3));
  page.line(MARGIN + WIDTH / 2, y, MARGIN + WIDTH, y, { stroke: RULE, lineWidth: 1 });
  y += 8;
  const subtotal = itemLines.reduce((sum, l) => sum + (l.billed ?? 0), 0);
  const totalsLabelX = MARGIN + WIDTH / 2;
  if (taxLines.length > 0) {
    page.text(totalsLabelX, y, "Subtotal", { size: 10, color: MUTED });
    textRight(page, amountRight, y, money(subtotal, invoice.currency), { size: 10 });
    y += ROW;
    for (const tax of taxLines) {
      page.text(totalsLabelX, y, truncateText(tax.label, WIDTH / 2 - 110, 10), {
        size: 10,
        color: MUTED,
      });
      textRight(page, amountRight, y, money(tax.billed ?? tax.adjusted, invoice.currency), {
        size: 10,
      });
      y += ROW;
    }
  }
  const billed = Object.entries(invoice.totals.billed).filter(
    ([currency, amount]) => amount !== 0 || currency === invoice.currency,
  );
  billed.sort(([a], [b]) => (a === invoice.currency ? -1 : b === invoice.currency ? 1 : 0));
  page.text(totalsLabelX, y, "Total due", { size: 12, font: "bold" });
  for (const [i, [currency, amount]] of billed.entries()) {
    textRight(page, amountRight, y + i * 16, money(amount, currency), {
      size: 12,
      font: "bold",
    });
  }
  y += Math.max(1, billed.length) * 16 + 18;

  if (invoice.derivation.rates.length > 0) {
    ensureRoom(26);
    const rates = invoice.derivation.rates
      .map((r) => `1 ${r.currency} = ${r.rate} ${invoice.currency}`)
      .join(", ");
    for (const line of wrapText(
      `Converted at the rates for ${invoice.derivation.rateDate}: ${rates}.`,
      WIDTH,
      8,
    )) {
      page.text(MARGIN, y, line, { size: 8, color: MUTED });
      y += 11;
    }
    y += 8;
  }

  /* -- payment -- */

  const bank = billing?.bank ?? null;
  const terms = billing ? describePaymentTerms(billing.paymentTermsDays) : null;
  const paymentLines: string[] = [];
  if (billing?.dueDate) {
    paymentLines.push(
      terms ? `${terms}: please pay by ${billing.dueDate}.` : `Please pay by ${billing.dueDate}.`,
    );
  }
  if (bank) {
    if (bank.accountName) paymentLines.push(`Account name: ${bank.accountName}`);
    if (bank.bankName) paymentLines.push(`Bank: ${bank.bankName}`);
    if (bank.iban) paymentLines.push(`IBAN: ${bank.iban}`);
    if (bank.bic) paymentLines.push(`SWIFT/BIC: ${bank.bic}`);
    if (bank.accountNumber) paymentLines.push(`Account number: ${bank.accountNumber}`);
    if (bank.routingNumber) paymentLines.push(`Routing number: ${bank.routingNumber}`);
  }
  if (number !== "Draft" && (bank || billing?.dueDate)) {
    paymentLines.push(`Please quote ${number} with your payment.`);
  }
  const instructions = bank?.instructions ? wrapText(bank.instructions, WIDTH, 9) : [];
  if (paymentLines.length > 0 || instructions.length > 0) {
    ensureRoom(30 + paymentLines.length * 13);
    page.text(MARGIN, y, "PAYMENT", { size: 8, font: "bold", color: MUTED });
    y += 14;
    for (const line of paymentLines) {
      ensureRoom(13);
      page.text(MARGIN, y, truncateText(line, WIDTH, 10), { size: 10 });
      y += 13;
    }
    for (const line of instructions) {
      ensureRoom(12);
      page.text(MARGIN, y, line, { size: 9, color: MUTED });
      y += 12;
    }
    y += 12;
  }

  /* -- notes -- */

  if (invoice.notes) {
    ensureRoom(30);
    page.text(MARGIN, y, "NOTES", { size: 8, font: "bold", color: MUTED });
    y += 14;
    for (const line of wrapText(invoice.notes, WIDTH, 9)) {
      ensureRoom(12);
      page.text(MARGIN, y, line, { size: 9 });
      y += 12;
    }
  }

  /* -- footer and page numbers, on every page -- */

  const footer = billing?.footer ? wrapText(billing.footer, WIDTH, 8).slice(0, 4) : [];
  const pages = doc.pages;
  pages.forEach((p, i) => {
    let fyy = A4.height - MARGIN - 10 - footer.length * 10;
    p.line(MARGIN, fyy - 6, MARGIN + WIDTH, fyy - 6, { stroke: RULE, lineWidth: 0.5 });
    for (const line of footer) {
      p.text(MARGIN, fyy, line, { size: 8, color: MUTED });
      fyy += 10;
    }
    textRight(p, MARGIN + WIDTH, A4.height - MARGIN - 10, `Page ${i + 1} of ${pages.length}`, {
      size: 8,
      color: MUTED,
    });
  });

  return doc.toBytes();
}

/** The filename a downloaded or attached PDF carries. */
export function invoicePdfFilename(invoice: Pick<ManagedInvoice, "number" | "id">): string {
  return `${invoice.number ?? `draft-${invoice.id.slice(0, 8)}`}.pdf`;
}
