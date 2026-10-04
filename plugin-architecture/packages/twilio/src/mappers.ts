/**
 * Twilio response shapes (the fields this plugin reads, verified against
 * `twilio/twilio-oai` 2026-10) and their mapping to `ResourceInstance`s.
 */
import type { ResourceInstance } from "@infrawrench/plugin-base";

export const PLUGIN_ID = "twilio";

export interface TwAccount {
  sid?: string;
  friendly_name?: string | null;
  owner_account_sid?: string | null;
  status?: string | null;
  type?: string | null;
  date_created?: string | null;
  date_updated?: string | null;
}

export interface TwBalance {
  account_sid?: string;
  balance?: string | null;
  currency?: string | null;
}

export interface TwUsageRecord {
  account_sid?: string;
  category?: string | null;
  description?: string | null;
  start_date?: string | null;
  end_date?: string | null;
  count?: string | null;
  count_unit?: string | null;
  usage?: string | null;
  usage_unit?: string | null;
  price?: number | string | null;
  price_unit?: string | null;
}

export interface TwPhoneNumber {
  sid?: string;
  account_sid?: string;
  phone_number?: string | null;
  friendly_name?: string | null;
  capabilities?: { voice?: boolean; sms?: boolean; mms?: boolean; fax?: boolean } | null;
  type?: string | null;
  origin?: string | null;
  status?: string | null;
  voice_url?: string | null;
  voice_method?: string | null;
  voice_fallback_url?: string | null;
  voice_application_sid?: string | null;
  sms_url?: string | null;
  sms_method?: string | null;
  sms_fallback_url?: string | null;
  sms_application_sid?: string | null;
  status_callback?: string | null;
  trunk_sid?: string | null;
  emergency_status?: string | null;
  address_requirements?: string | null;
  date_created?: string | null;
}

export interface TwMessagingService {
  sid?: string;
  account_sid?: string;
  friendly_name?: string | null;
  inbound_request_url?: string | null;
  inbound_method?: string | null;
  fallback_url?: string | null;
  status_callback?: string | null;
  sticky_sender?: boolean | null;
  mms_converter?: boolean | null;
  smart_encoding?: boolean | null;
  fallback_to_long_code?: boolean | null;
  area_code_geomatch?: boolean | null;
  validity_period?: number | null;
  usecase?: string | null;
  us_app_to_person_registered?: boolean | null;
  use_inbound_webhook_on_number?: boolean | null;
  date_created?: string | null;
  date_updated?: string | null;
}

export interface TwVerifyService {
  sid?: string;
  friendly_name?: string | null;
  code_length?: number | null;
  lookup_enabled?: boolean | null;
  psd2_enabled?: boolean | null;
  skip_sms_to_landlines?: boolean | null;
  dtmf_input_required?: boolean | null;
  do_not_share_warning_enabled?: boolean | null;
  custom_code_enabled?: boolean | null;
  default_template_sid?: string | null;
  date_created?: string | null;
  date_updated?: string | null;
}

export interface TwApplication {
  sid?: string;
  account_sid?: string;
  friendly_name?: string | null;
  voice_url?: string | null;
  voice_method?: string | null;
  voice_fallback_url?: string | null;
  sms_url?: string | null;
  sms_method?: string | null;
  sms_fallback_url?: string | null;
  status_callback?: string | null;
  sms_status_callback?: string | null;
  date_created?: string | null;
}

export interface TwUsageTrigger {
  sid?: string;
  account_sid?: string;
  friendly_name?: string | null;
  usage_category?: string | null;
  trigger_by?: string | null;
  trigger_value?: string | null;
  current_value?: string | null;
  recurring?: string | null;
  callback_url?: string | null;
  callback_method?: string | null;
  date_fired?: string | null;
  date_created?: string | null;
  date_updated?: string | null;
}

export interface TwKey {
  sid?: string;
  friendly_name?: string | null;
  date_created?: string | null;
  date_updated?: string | null;
  secret?: string;
}

type FieldValue = string | number | boolean | null | undefined;

export function instance(
  accountId: string,
  typeId: string,
  externalId: string,
  displayName: string,
  fields: Record<string, FieldValue>,
  outputs: Record<string, string | undefined> = {},
): ResourceInstance {
  const now = new Date().toISOString();
  const clean: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined && v !== null && v !== "") clean[k] = v;
  }
  const resolved: Record<string, string> = {};
  for (const [k, v] of Object.entries(outputs)) if (v) resolved[k] = v;
  return {
    id: `${accountId}:${typeId}:${externalId}`,
    pluginId: PLUGIN_ID,
    resourceTypeId: typeId,
    accountId,
    displayName: displayName || externalId,
    fields: clean,
    resolvedOutputs: resolved,
    secretStates: [],
    externalId,
    createdAt: now,
    updatedAt: now,
  };
}

/** RFC 2822 (`Thu, 30 Jul 2015 23:19:04 +0000`) → ISO 8601; passes ISO through. */
export function isoDate(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

export function num(value: string | number | null | undefined): number | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : undefined;
}

export interface AccountSummary {
  balance?: number;
  currency?: string;
  monthToDate?: number;
  lastMonth?: number;
  priceUnit?: string;
  subaccountCount?: number;
}

export function mapAccount(
  accountId: string,
  a: TwAccount,
  summary: AccountSummary,
  authMode: string,
): ResourceInstance {
  const sid = a.sid ?? "";
  return instance(
    accountId,
    "account",
    sid,
    a.friendly_name || sid,
    {
      friendlyName: a.friendly_name,
      accountSid: sid,
      type: a.type,
      status: a.status,
      balance: summary.balance,
      currency: summary.currency,
      monthToDate: summary.monthToDate,
      lastMonth: summary.lastMonth,
      priceUnit: summary.priceUnit,
      subaccountCount: summary.subaccountCount,
      authMode: authMode === "api-key" ? "API key" : "Auth token",
      createdAt: isoDate(a.date_created),
    },
    { accountSid: sid },
  );
}

export function mapSubaccount(accountId: string, a: TwAccount): ResourceInstance {
  const sid = a.sid ?? "";
  return instance(
    accountId,
    "subaccount",
    sid,
    a.friendly_name || sid,
    {
      friendlyName: a.friendly_name,
      status: a.status,
      accountSid: sid,
      type: a.type,
      ownerAccountSid: a.owner_account_sid,
      createdAt: isoDate(a.date_created),
      updatedAt: isoDate(a.date_updated),
    },
    { accountSid: sid },
  );
}

export interface PhoneNumberContext {
  /** Main account SID: numbers owned elsewhere name their subaccount. */
  mainAccountSid: string;
  subaccountNames: Map<string, string>;
  /** Phone number SID → messaging service it is a sender in. */
  messagingServiceOf: Map<string, { sid: string; name: string }>;
  isoCountry?: string;
  monthlyPrice?: number;
  priceUnit?: string;
}

export function capabilityList(c: TwPhoneNumber["capabilities"]): string {
  if (!c) return "";
  const out: string[] = [];
  if (c.voice) out.push("Voice");
  if (c.sms) out.push("SMS");
  if (c.mms) out.push("MMS");
  if (c.fax) out.push("Fax");
  return out.join(", ");
}

export function mapPhoneNumber(
  accountId: string,
  p: TwPhoneNumber,
  ctx: PhoneNumberContext,
): ResourceInstance {
  const sid = p.sid ?? "";
  const owner = p.account_sid ?? "";
  const service = ctx.messagingServiceOf.get(sid);
  const display =
    p.friendly_name && p.friendly_name !== p.phone_number
      ? `${p.phone_number ?? sid} (${p.friendly_name})`
      : (p.phone_number ?? sid);
  return instance(
    accountId,
    "phone-number",
    sid,
    display,
    {
      phoneNumber: p.phone_number,
      friendlyName: p.friendly_name,
      type: p.type,
      capabilities: capabilityList(p.capabilities),
      voice: p.capabilities?.voice ?? undefined,
      sms: p.capabilities?.sms ?? undefined,
      mms: p.capabilities?.mms ?? undefined,
      isoCountry: ctx.isoCountry,
      monthlyPrice: ctx.monthlyPrice,
      priceUnit: ctx.monthlyPrice !== undefined ? ctx.priceUnit : undefined,
      voiceUrl: p.voice_url ?? "",
      voiceMethod: p.voice_method,
      voiceFallbackUrl: p.voice_fallback_url ?? "",
      smsUrl: p.sms_url ?? "",
      smsMethod: p.sms_method,
      smsFallbackUrl: p.sms_fallback_url ?? "",
      statusCallback: p.status_callback ?? "",
      voiceApplicationSid: p.voice_application_sid ?? "",
      smsApplicationSid: p.sms_application_sid ?? "",
      trunkSid: p.trunk_sid ?? "",
      messagingServiceSid: service?.sid ?? "",
      messagingServiceName: service?.name,
      ownerAccountSid: owner,
      subaccountSid: owner && owner !== ctx.mainAccountSid ? owner : "",
      subaccountName: owner !== ctx.mainAccountSid ? ctx.subaccountNames.get(owner) : undefined,
      origin: p.origin,
      status: p.status,
      emergencyStatus: p.emergency_status,
      addressRequirements: p.address_requirements,
      createdAt: isoDate(p.date_created),
    },
    { phoneNumber: p.phone_number ?? undefined, phoneNumberSid: sid },
  );
}

export function mapMessagingService(
  accountId: string,
  s: TwMessagingService,
  senderCount: number | undefined,
): ResourceInstance {
  const sid = s.sid ?? "";
  return instance(
    accountId,
    "messaging-service",
    sid,
    s.friendly_name || sid,
    {
      friendlyName: s.friendly_name,
      serviceSid: sid,
      usecase: s.usecase,
      senderCount,
      inboundRequestUrl: s.inbound_request_url ?? "",
      fallbackUrl: s.fallback_url ?? "",
      statusCallback: s.status_callback ?? "",
      stickySender: s.sticky_sender ?? undefined,
      smartEncoding: s.smart_encoding ?? undefined,
      mmsConverter: s.mms_converter ?? undefined,
      fallbackToLongCode: s.fallback_to_long_code ?? undefined,
      areaCodeGeomatch: s.area_code_geomatch ?? undefined,
      validityPeriod: s.validity_period ?? undefined,
      useInboundWebhookOnNumber: s.use_inbound_webhook_on_number ?? undefined,
      usA2pRegistered: s.us_app_to_person_registered ?? undefined,
      createdAt: isoDate(s.date_created),
      updatedAt: isoDate(s.date_updated),
    },
    { messagingServiceSid: sid },
  );
}

export function mapVerifyService(accountId: string, s: TwVerifyService): ResourceInstance {
  const sid = s.sid ?? "";
  return instance(
    accountId,
    "verify-service",
    sid,
    s.friendly_name || sid,
    {
      friendlyName: s.friendly_name,
      serviceSid: sid,
      codeLength: s.code_length ?? undefined,
      lookupEnabled: s.lookup_enabled ?? undefined,
      skipSmsToLandlines: s.skip_sms_to_landlines ?? undefined,
      dtmfInputRequired: s.dtmf_input_required ?? undefined,
      doNotShareWarningEnabled: s.do_not_share_warning_enabled ?? undefined,
      customCodeEnabled: s.custom_code_enabled ?? undefined,
      psd2Enabled: s.psd2_enabled ?? undefined,
      defaultTemplateSid: s.default_template_sid,
      createdAt: isoDate(s.date_created),
      updatedAt: isoDate(s.date_updated),
    },
    { verifyServiceSid: sid },
  );
}

export function mapApplication(accountId: string, a: TwApplication): ResourceInstance {
  const sid = a.sid ?? "";
  return instance(
    accountId,
    "twiml-app",
    sid,
    a.friendly_name || sid,
    {
      friendlyName: a.friendly_name,
      appSid: sid,
      voiceUrl: a.voice_url ?? "",
      voiceMethod: a.voice_method,
      voiceFallbackUrl: a.voice_fallback_url ?? "",
      smsUrl: a.sms_url ?? "",
      smsMethod: a.sms_method,
      smsFallbackUrl: a.sms_fallback_url ?? "",
      statusCallback: a.status_callback ?? "",
      smsStatusCallback: a.sms_status_callback ?? "",
      createdAt: isoDate(a.date_created),
    },
    { applicationSid: sid },
  );
}

export function mapUsageTrigger(accountId: string, t: TwUsageTrigger): ResourceInstance {
  const sid = t.sid ?? "";
  return instance(
    accountId,
    "usage-trigger",
    sid,
    t.friendly_name ||
      `${t.usage_category ?? "usage"} ${t.trigger_by ?? ""} ${t.trigger_value ?? ""}`.trim(),
    {
      friendlyName: t.friendly_name ?? "",
      usageCategory: t.usage_category,
      triggerBy: t.trigger_by,
      triggerValue: num(t.trigger_value),
      currentValue: num(t.current_value),
      recurring: t.recurring || "none",
      callbackUrl: t.callback_url,
      callbackMethod: t.callback_method,
      dateFired: isoDate(t.date_fired),
      triggerSid: sid,
      createdAt: isoDate(t.date_created),
      updatedAt: isoDate(t.date_updated),
    },
    { triggerSid: sid },
  );
}

export function mapKey(accountId: string, k: TwKey, inUseSid: string): ResourceInstance {
  const sid = k.sid ?? "";
  return instance(
    accountId,
    "api-key",
    sid,
    k.friendly_name || sid,
    {
      friendlyName: k.friendly_name ?? "",
      keySid: sid,
      inUse: sid === inUseSid,
      createdAt: isoDate(k.date_created),
      updatedAt: isoDate(k.date_updated),
    },
    { keySid: sid, ...(k.secret ? { secret: k.secret } : {}) },
  );
}
