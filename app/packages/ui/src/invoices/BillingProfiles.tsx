import { useMemo, useRef, useState } from "react";
import { useGT } from "gt-react";
import {
  BILLING_PROFILE_LIMITS,
  billingProfileLogoError,
  describeTaxRate,
  formatInvoiceNumber,
  normalizeBillingProfileInput,
  type BillingProfile,
  type BillingProfileBank,
  type BillingProfileInput,
  type BillingProfileTaxRate,
  type ManagedAccount,
} from "@infrawrench/client-core";
import { Modal } from "../components/Modal.js";
import { BTN, FIELD } from "./shared.js";

/* ------------------------------------------------------------------ *
 * List
 * ------------------------------------------------------------------ */

/**
 * Billing profiles: the reusable invoice settings customers are assigned to.
 *
 * Each row says what the profile actually changes on an invoice (terms, tax,
 * numbering) and who it reaches, because "which of my customers does this
 * edit touch" is the question to answer before saving one.
 */
export function BillingProfileList({
  profiles,
  customers,
  canWrite,
  onNew,
  onEdit,
  onDelete,
}: {
  profiles: BillingProfile[] | null;
  customers: ManagedAccount[];
  canWrite: boolean;
  onNew: () => void;
  onEdit: (profile: BillingProfile) => void;
  onDelete: (profile: BillingProfile) => void;
}) {
  const gt = useGT();
  const customerName = useMemo(() => new Map(customers.map((c) => [c.id, c.name])), [customers]);
  const year = new Date().getUTCFullYear();

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-on-surface">{gt("Billing profiles")}</h2>
          <p className="text-xs text-on-surface-faint">
            {gt(
              "Who invoices are addressed to, who receives them, tax, payment terms, bank details and numbering, shared by every customer assigned to the profile. Approved invoices keep the settings they were issued with.",
            )}
          </p>
        </div>
        {canWrite && (
          <button type="button" className={BTN} onClick={onNew}>
            {gt("New profile")}
          </button>
        )}
      </div>

      {profiles === null ? (
        <p className="text-sm text-on-surface-faint">{gt("Loading…")}</p>
      ) : profiles.length === 0 ? (
        <p className="text-sm text-on-surface-faint">
          {gt(
            "No billing profiles yet. Create one to add tax lines, payment terms and remittance details to your invoices.",
          )}
        </p>
      ) : (
        <div className="flex flex-col divide-y divide-border rounded-lg border border-border">
          {profiles.map((profile) => {
            const facts = [
              formatInvoiceNumber(
                { prefix: profile.numberPrefix, includeYear: profile.numberIncludesYear },
                year,
                profile.numberStart,
              ),
              profile.currency,
              profile.paymentTermsDays === null
                ? null
                : profile.paymentTermsDays === 0
                  ? gt("Due on receipt")
                  : gt("Net {days}", { days: profile.paymentTermsDays }),
              ...profile.taxRates.map(describeTaxRate),
            ].filter((f): f is string => Boolean(f));
            const assigned = profile.managedAccountIds.map((id) => customerName.get(id) ?? id);
            return (
              <div key={profile.id} className="flex items-center gap-3 px-3 py-2.5">
                {profile.logo && (
                  <img
                    src={profile.logo}
                    alt={gt("{name} logo", { name: profile.name })}
                    className="h-8 w-16 shrink-0 object-contain"
                  />
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm text-on-surface">{profile.name}</span>
                    {profile.legalName && (
                      <span className="truncate text-xs text-on-surface-faint">
                        {profile.legalName}
                      </span>
                    )}
                  </div>
                  <div className="truncate text-xs text-on-surface-faint">{facts.join(" · ")}</div>
                  <div className="truncate text-xs text-on-surface-faint">
                    {assigned.length === 0
                      ? gt("Not assigned to any customer")
                      : assigned.length === 1
                        ? gt("Used by {names}", { names: assigned[0]! })
                        : gt("Used by {count} customers: {names}", {
                            count: assigned.length,
                            names: assigned.join(", "),
                          })}
                  </div>
                </div>
                {canWrite && (
                  <>
                    <button type="button" className={BTN} onClick={() => onEdit(profile)}>
                      {gt("Edit")}
                    </button>
                    <button
                      type="button"
                      className={BTN}
                      disabled={profile.managedAccountIds.length > 0}
                      title={
                        profile.managedAccountIds.length > 0
                          ? gt("Assign its customers another profile before deleting it")
                          : gt("Delete this profile")
                      }
                      onClick={() => onDelete(profile)}
                    >
                      {gt("Delete")}
                    </button>
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ *
 * Editor
 * ------------------------------------------------------------------ */

const EMPTY_BANK: BillingProfileBank = {
  accountName: null,
  bankName: null,
  iban: null,
  bic: null,
  accountNumber: null,
  routingNumber: null,
  instructions: null,
};

function splitEmails(text: string): string[] {
  return text
    .split(/[\s,;]+/)
    .map((e) => e.trim())
    .filter(Boolean);
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("Could not read the file"));
    reader.readAsDataURL(file);
  });
}

export function BillingProfileModal({
  profile,
  onSave,
  onClose,
}: {
  profile: BillingProfile | null;
  onSave: (input: BillingProfileInput) => Promise<void>;
  onClose: () => void;
}) {
  const gt = useGT();
  const [name, setName] = useState(profile?.name ?? "");
  const [legalName, setLegalName] = useState(profile?.legalName ?? "");
  const [address, setAddress] = useState(profile?.address ?? "");
  const [taxId, setTaxId] = useState(profile?.taxId ?? "");
  const [poNumber, setPoNumber] = useState(profile?.poNumber ?? "");
  const [toEmails, setToEmails] = useState((profile?.toEmails ?? []).join(", "));
  const [ccEmails, setCcEmails] = useState((profile?.ccEmails ?? []).join(", "));
  const [currency, setCurrency] = useState(profile?.currency ?? "");
  const [terms, setTerms] = useState(
    profile?.paymentTermsDays === null || profile?.paymentTermsDays === undefined
      ? ""
      : String(profile.paymentTermsDays),
  );
  const [prefix, setPrefix] = useState(profile?.numberPrefix ?? "INV");
  const [includeYear, setIncludeYear] = useState(profile?.numberIncludesYear ?? true);
  const [start, setStart] = useState(String(profile?.numberStart ?? 1));
  const nextTaxId = useRef(0);
  const [taxRates, setTaxRates] = useState<Array<{ id: number; name: string; rate: string }>>(() =>
    (profile?.taxRates ?? []).map((t) => ({
      id: nextTaxId.current++,
      name: t.name,
      rate: String(t.rate),
    })),
  );
  const [bank, setBank] = useState<BillingProfileBank>(profile?.bank ?? EMPTY_BANK);
  const [footer, setFooter] = useState(profile?.footer ?? "");
  const [logo, setLogo] = useState<string | null>(profile?.logo ?? null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const input: BillingProfileInput = {
    name,
    legalName: legalName || null,
    address: address || null,
    taxId: taxId || null,
    poNumber: poNumber || null,
    toEmails: splitEmails(toEmails),
    ccEmails: splitEmails(ccEmails),
    currency: currency.trim() ? currency.trim().toUpperCase() : null,
    paymentTermsDays: terms.trim() === "" ? null : Number(terms),
    numberPrefix: prefix.trim(),
    numberIncludesYear: includeYear,
    numberStart: Number(start),
    taxRates: taxRates.map((t): BillingProfileTaxRate => ({
      name: t.name,
      rate: t.rate.trim() === "" ? NaN : Number(t.rate),
    })),
    bank,
    footer: footer || null,
    logo,
  };
  // The same check the server runs, so Save is disabled with the sentence the
  // API would have refused with.
  const problem = normalizeBillingProfileInput(input).error ?? null;
  const preview = problem
    ? null
    : formatInvoiceNumber(
        { prefix: prefix.trim(), includeYear },
        new Date().getUTCFullYear(),
        Math.max(1, Number(start) || 1),
      );

  const setBankField = (field: keyof BillingProfileBank, value: string) =>
    setBank((b) => ({ ...b, [field]: value || null }));

  async function pickLogo(file: File | undefined) {
    if (!file) return;
    setError(null);
    try {
      const dataUrl = await readAsDataUrl(file);
      const logoError = billingProfileLogoError(dataUrl);
      if (logoError) {
        setError(logoError);
        return;
      }
      setLogo(dataUrl);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function submit() {
    setSaving(true);
    setError(null);
    try {
      // Unchanged logo: leave it out, so a save never re-sends the image.
      const body =
        logo === (profile?.logo ?? null) && profile ? { ...input, logo: undefined } : input;
      await onSave(body);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  const label = "flex flex-col gap-1 text-xs text-on-surface-faint";
  const heading = "text-xs font-semibold uppercase tracking-wide text-on-surface-secondary";

  return (
    <Modal
      ariaLabel={profile ? gt("Edit {name}", { name: profile.name }) : gt("New billing profile")}
      onClose={onClose}
    >
      <div className="bg-surface-raised border border-border-strong rounded-xl shadow-2xl w-[680px] max-w-[92vw] max-h-[85vh] overflow-y-auto p-6">
        <div className="flex flex-col gap-4">
          <label className={label}>
            {gt("Profile name (only shown to you)")}
            <input className={FIELD} value={name} onChange={(e) => setName(e.target.value)} />
          </label>

          <div className="flex flex-col gap-2">
            <span className={heading}>{gt("Bill to")}</span>
            <p className="text-xs text-on-surface-faint">
              {gt("Leave a field blank to use each customer's own details instead.")}
            </p>
            <div className="grid grid-cols-2 gap-3">
              <label className={label}>
                {gt("Legal entity name")}
                <input
                  className={FIELD}
                  value={legalName}
                  onChange={(e) => setLegalName(e.target.value)}
                />
              </label>
              <label className={label}>
                {gt("Tax ID / VAT number")}
                <input className={FIELD} value={taxId} onChange={(e) => setTaxId(e.target.value)} />
              </label>
            </div>
            <label className={label}>
              {gt("Address")}
              <textarea
                className={FIELD}
                rows={3}
                value={address}
                onChange={(e) => setAddress(e.target.value)}
              />
            </label>
            <label className={label}>
              {gt("PO number")}
              <input
                className={FIELD}
                value={poNumber}
                onChange={(e) => setPoNumber(e.target.value)}
              />
            </label>
          </div>

          <div className="flex flex-col gap-2">
            <span className={heading}>{gt("Recipients")}</span>
            <p className="text-xs text-on-surface-faint">
              {gt(
                "Sent in addition to each customer's contact email. Separate addresses with commas.",
              )}
            </p>
            <div className="grid grid-cols-2 gap-3">
              <label className={label}>
                {gt("To")}
                <textarea
                  className={FIELD}
                  rows={2}
                  value={toEmails}
                  onChange={(e) => setToEmails(e.target.value)}
                />
              </label>
              <label className={label}>
                {gt("Cc")}
                <textarea
                  className={FIELD}
                  rows={2}
                  value={ccEmails}
                  onChange={(e) => setCcEmails(e.target.value)}
                />
              </label>
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <span className={heading}>{gt("Currency, terms and tax")}</span>
            <div className="grid grid-cols-2 gap-3">
              <label className={label}>
                {gt("Invoice currency (blank: each customer's own)")}
                <input
                  className={FIELD}
                  value={currency}
                  maxLength={3}
                  onChange={(e) => setCurrency(e.target.value)}
                />
              </label>
              <label className={label}>
                {gt("Payment terms, days (blank: no due date, 0: due on receipt)")}
                <input
                  className={FIELD}
                  type="number"
                  min={0}
                  max={BILLING_PROFILE_LIMITS.maxPaymentTermsDays}
                  value={terms}
                  onChange={(e) => setTerms(e.target.value)}
                />
              </label>
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-xs text-on-surface-faint">
                {gt("Taxes, each charged on the subtotal as its own line")}
              </span>
              {taxRates.map((tax) => (
                <div key={tax.id} className="flex items-center gap-2">
                  <input
                    className={FIELD + " flex-1"}
                    aria-label={gt("Tax name")}
                    placeholder={gt("Tax name, such as VAT")}
                    value={tax.name}
                    onChange={(e) =>
                      setTaxRates((rows) =>
                        rows.map((r) => (r.id === tax.id ? { ...r, name: e.target.value } : r)),
                      )
                    }
                  />
                  <input
                    className={FIELD + " w-24"}
                    aria-label={gt("Rate in percent")}
                    type="number"
                    min={0}
                    max={100}
                    step="0.01"
                    value={tax.rate}
                    onChange={(e) =>
                      setTaxRates((rows) =>
                        rows.map((r) => (r.id === tax.id ? { ...r, rate: e.target.value } : r)),
                      )
                    }
                  />
                  <span className="text-xs text-on-surface-faint">%</span>
                  <button
                    type="button"
                    className={BTN}
                    onClick={() => setTaxRates((rows) => rows.filter((r) => r.id !== tax.id))}
                  >
                    {gt("Remove")}
                  </button>
                </div>
              ))}
              {taxRates.length < BILLING_PROFILE_LIMITS.maxTaxRates && (
                <button
                  type="button"
                  className={BTN + " self-start"}
                  onClick={() =>
                    setTaxRates((rows) => [
                      ...rows,
                      { id: nextTaxId.current++, name: "", rate: "" },
                    ])
                  }
                >
                  {gt("Add tax")}
                </button>
              )}
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <span className={heading}>{gt("Bank details")}</span>
            <div className="grid grid-cols-2 gap-3">
              <label className={label}>
                {gt("Account name")}
                <input
                  className={FIELD}
                  value={bank.accountName ?? ""}
                  onChange={(e) => setBankField("accountName", e.target.value)}
                />
              </label>
              <label className={label}>
                {gt("Bank name")}
                <input
                  className={FIELD}
                  value={bank.bankName ?? ""}
                  onChange={(e) => setBankField("bankName", e.target.value)}
                />
              </label>
              <label className={label}>
                {gt("IBAN")}
                <input
                  className={FIELD}
                  value={bank.iban ?? ""}
                  onChange={(e) => setBankField("iban", e.target.value)}
                />
              </label>
              <label className={label}>
                {gt("SWIFT / BIC")}
                <input
                  className={FIELD}
                  value={bank.bic ?? ""}
                  onChange={(e) => setBankField("bic", e.target.value)}
                />
              </label>
              <label className={label}>
                {gt("Account number (where there is no IBAN)")}
                <input
                  className={FIELD}
                  value={bank.accountNumber ?? ""}
                  onChange={(e) => setBankField("accountNumber", e.target.value)}
                />
              </label>
              <label className={label}>
                {gt("Sort code or routing number")}
                <input
                  className={FIELD}
                  value={bank.routingNumber ?? ""}
                  onChange={(e) => setBankField("routingNumber", e.target.value)}
                />
              </label>
            </div>
            <label className={label}>
              {gt("Remittance instructions")}
              <textarea
                className={FIELD}
                rows={2}
                value={bank.instructions ?? ""}
                onChange={(e) => setBankField("instructions", e.target.value)}
              />
            </label>
          </div>

          <div className="flex flex-col gap-2">
            <span className={heading}>{gt("Numbering and layout")}</span>
            <div className="grid grid-cols-3 gap-3">
              <label className={label}>
                {gt("Number prefix")}
                <input
                  className={FIELD}
                  value={prefix}
                  maxLength={BILLING_PROFILE_LIMITS.maxPrefixLength}
                  onChange={(e) => setPrefix(e.target.value)}
                />
              </label>
              <label className={label}>
                {gt("First number")}
                <input
                  className={FIELD}
                  type="number"
                  min={1}
                  value={start}
                  onChange={(e) => setStart(e.target.value)}
                />
              </label>
              <label className="flex items-center gap-2 self-end pb-2 text-xs text-on-surface-faint">
                <input
                  type="checkbox"
                  checked={includeYear}
                  onChange={(e) => setIncludeYear(e.target.checked)}
                />
                {gt("Include the year")}
              </label>
            </div>
            {preview && (
              <p className="text-xs text-on-surface-faint">
                {gt(
                  "Numbers look like {example}. Profiles with the same prefix share a sequence.",
                  {
                    example: preview,
                  },
                )}
              </p>
            )}
            <label className={label}>
              {gt("Footer, printed on every page")}
              <textarea
                className={FIELD}
                rows={2}
                value={footer}
                onChange={(e) => setFooter(e.target.value)}
              />
            </label>
            <div className="flex items-center gap-3">
              {logo ? (
                <img
                  src={logo}
                  alt={gt("Logo preview")}
                  className="h-12 w-28 rounded border border-border object-contain"
                />
              ) : (
                <span className="text-xs text-on-surface-faint">{gt("No logo")}</span>
              )}
              <label className={BTN + " cursor-pointer"}>
                {logo ? gt("Replace logo") : gt("Upload logo")}
                <input
                  type="file"
                  accept="image/png,image/jpeg"
                  className="hidden"
                  onChange={(e) => {
                    void pickLogo(e.target.files?.[0]);
                    e.target.value = "";
                  }}
                />
              </label>
              {logo && (
                <button type="button" className={BTN} onClick={() => setLogo(null)}>
                  {gt("Remove logo")}
                </button>
              )}
              <span className="text-xs text-on-surface-faint">
                {gt("PNG or JPEG, up to {size} KB", {
                  size: Math.round(BILLING_PROFILE_LIMITS.maxLogoBytes / 1024),
                })}
              </span>
            </div>
          </div>

          {/* A blank new form is not an error yet: Save is disabled until it has a name. */}
          {(error ?? (name.trim() ? problem : null)) !== null && (
            <p role="alert" className="text-sm text-danger">
              {error ?? problem}
            </p>
          )}

          <div className="flex justify-end gap-2">
            <button type="button" className={BTN} onClick={onClose}>
              {gt("Cancel")}
            </button>
            <button
              type="button"
              className={BTN}
              disabled={saving || problem !== null}
              onClick={() => void submit()}
            >
              {saving ? gt("Saving…") : gt("Save")}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
