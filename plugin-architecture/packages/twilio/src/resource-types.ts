import type { ResourceTypeDefinition } from "@infrawrench/plugin-base";
import { f, o, rt } from "@infrawrench/plugin-base";

/**
 * Twilio resource types. Field names follow Twilio's published OpenAPI
 * documents (`twilio/twilio-oai`, 2026-10); each type names the endpoint it
 * lists from.
 */

const METHODS = ["POST", "GET"];

/**
 * The main account the credential belongs to: `GET /2010-04-01/Accounts/{Sid}.json`,
 * its `Balance.json`, and this month's and last month's `totalprice` usage
 * record. Exactly one per credential, so it is the account root.
 */
export const AccountResourceType = rt({
  name: "Account",
  id: "account",
  description:
    "The Twilio account the credentials belong to: balance, spend this month and last by product and usage category, and daily message, call and spend volume.",
  fields: [
    f("friendlyName", "Name", { editable: false }),
    f("accountSid", "Account SID", { editable: false }),
    f("type", "Type", { required: false, editable: false }),
    f("status", "Status", { required: false, editable: false }),
    f("balance", "Balance", { kind: "number", required: false, editable: false }),
    f("currency", "Balance Currency", { required: false, editable: false }),
    f("monthToDate", "Spend This Month", { kind: "number", required: false, editable: false }),
    f("lastMonth", "Spend Last Month", { kind: "number", required: false, editable: false }),
    f("priceUnit", "Spend Currency", { required: false, editable: false }),
    f("subaccountCount", "Subaccounts", { kind: "number", required: false, editable: false }),
    f("authMode", "Signed In With", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  outputs: [o("accountSid", "Account SID")],
  accountRoot: true,
  supportsDelete: false,
  supportsMetrics: true,
  iconKey: "account",
});

/** `GET /2010-04-01/Accounts.json`, minus the main account and closed subaccounts. */
export const SubaccountResourceType = rt({
  name: "Subaccount",
  id: "subaccount",
  description:
    "A Twilio subaccount. Rename it, suspend or reactivate it, see its spend and volume, or close it for good. Managing subaccounts needs the auth token or a Main API key.",
  fields: [
    f("friendlyName", "Name", { description: "Up to 64 characters." }),
    f("status", "Status", {
      kind: "enum",
      enumValues: ["active", "suspended"],
      description:
        "Suspended subaccounts cannot make calls or send messages but keep their phone numbers, which are still billed. To close a subaccount for good, delete it.",
    }),
    f("accountSid", "Account SID", { required: false, editable: false }),
    f("type", "Type", { required: false, editable: false }),
    f("ownerAccountSid", "Parent Account", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
    f("updatedAt", "Updated", { required: false, editable: false }),
  ],
  outputs: [o("accountSid", "Account SID")],
  supportsCreate: true,
  supportsUpdate: true,
  supportsMetrics: true,
  iconKey: "users",
});

/**
 * `GET /2010-04-01/Accounts/{Sid}/IncomingPhoneNumbers.json`, for the main
 * account and (with the auth token) every subaccount. Messaging-service
 * membership comes from `GET messaging.twilio.com/v1/Services/{Sid}/PhoneNumbers`
 * and the monthly price from the Pricing API.
 */
export const PhoneNumberResourceType = rt({
  name: "Phone Number",
  id: "phone-number",
  description:
    "A phone number the account rents, with its capabilities, monthly price and where its calls and messages go. Edit its webhooks, or release it to stop paying for it.",
  fields: [
    f("phoneNumber", "Phone Number", { editable: false }),
    f("friendlyName", "Friendly Name", { required: false, description: "Up to 64 characters." }),
    f("type", "Number Type", { required: false, editable: false }),
    f("capabilities", "Capabilities", { required: false, editable: false }),
    f("voice", "Voice", { kind: "boolean", required: false, editable: false }),
    f("sms", "SMS", { kind: "boolean", required: false, editable: false }),
    f("mms", "MMS", { kind: "boolean", required: false, editable: false }),
    f("isoCountry", "Country", { required: false, editable: false }),
    f("monthlyPrice", "Monthly Price", {
      kind: "number",
      required: false,
      editable: false,
      description: "Twilio's current monthly price for this country and number type.",
    }),
    f("priceUnit", "Price Currency", { required: false, editable: false }),
    f("voiceUrl", "Voice Webhook URL", {
      required: false,
      description:
        "Called when the number receives a call. Ignored while a TwiML app or trunk handles voice.",
    }),
    f("voiceMethod", "Voice Webhook Method", {
      kind: "enum",
      enumValues: METHODS,
      required: false,
    }),
    f("voiceFallbackUrl", "Voice Fallback URL", { required: false }),
    f("smsUrl", "Messaging Webhook URL", {
      required: false,
      description:
        "Called when the number receives a message. Ignored while the number belongs to a messaging service that handles inbound itself.",
    }),
    f("smsMethod", "Messaging Webhook Method", {
      kind: "enum",
      enumValues: METHODS,
      required: false,
    }),
    f("smsFallbackUrl", "Messaging Fallback URL", { required: false }),
    f("statusCallback", "Status Callback URL", { required: false }),
    f("voiceApplicationSid", "Voice TwiML App", { required: false, editable: false }),
    f("smsApplicationSid", "Messaging TwiML App", { required: false, editable: false }),
    f("trunkSid", "SIP Trunk", { required: false, editable: false }),
    f("messagingServiceSid", "Messaging Service", { required: false, editable: false }),
    f("messagingServiceName", "Messaging Service Name", { required: false, editable: false }),
    f("subaccountSid", "Subaccount", { required: false, editable: false }),
    f("subaccountName", "Subaccount Name", { required: false, editable: false }),
    f("ownerAccountSid", "Owner Account SID", { required: false, editable: false }),
    f("origin", "Origin", { required: false, editable: false }),
    f("status", "Status", { required: false, editable: false }),
    f("emergencyStatus", "Emergency Calling", { required: false, editable: false }),
    f("addressRequirements", "Address Requirement", { required: false, editable: false }),
    f("createdAt", "Purchased", { required: false, editable: false }),
  ],
  outputs: [o("phoneNumber", "Phone Number"), o("phoneNumberSid", "Phone Number SID")],
  dependsOn: [
    { fieldKey: "messagingServiceSid", targetTypeId: "messaging-service", label: "sends through" },
    { fieldKey: "voiceApplicationSid", targetTypeId: "twiml-app", label: "voice handled by" },
    { fieldKey: "smsApplicationSid", targetTypeId: "twiml-app", label: "messages handled by" },
    { fieldKey: "subaccountSid", targetTypeId: "subaccount", label: "owned by" },
  ],
  orphanRule: {
    conditions: [
      { fieldKey: "voiceUrl", when: "empty" },
      { fieldKey: "smsUrl", when: "empty" },
      { fieldKey: "voiceApplicationSid", when: "empty" },
      { fieldKey: "smsApplicationSid", when: "empty" },
      { fieldKey: "trunkSid", when: "empty" },
      { fieldKey: "messagingServiceSid", when: "empty" },
    ],
    reason:
      "Phone number has no voice or messaging webhook, TwiML app, SIP trunk or messaging service, so nothing answers it, but it is still billed every month",
  },
  supportsUpdate: true,
  iconKey: "phone",
});

/** `GET messaging.twilio.com/v1/Services`. */
export const MessagingServiceResourceType = rt({
  name: "Messaging Service",
  id: "messaging-service",
  description:
    "A messaging service: a pool of senders with shared inbound handling, delivery callbacks and sending features. Create, edit and delete them here.",
  fields: [
    f("friendlyName", "Name", { description: "Up to 64 characters." }),
    f("serviceSid", "Service SID", { required: false, editable: false }),
    f("usecase", "Use Case", { required: false, editable: false }),
    f("senderCount", "Phone Number Senders", { kind: "number", required: false, editable: false }),
    f("inboundRequestUrl", "Inbound Webhook URL", {
      required: false,
      description: "Called when a sender in the service receives a message.",
    }),
    f("fallbackUrl", "Inbound Fallback URL", { required: false }),
    f("statusCallback", "Delivery Status Callback URL", { required: false }),
    f("stickySender", "Sticky Sender", {
      kind: "boolean",
      required: false,
      description: "Keep sending to a recipient from the same number.",
    }),
    f("smartEncoding", "Smart Encoding", {
      kind: "boolean",
      required: false,
      description: "Replace Unicode look-alikes so messages stay in cheaper GSM-7 segments.",
    }),
    f("mmsConverter", "MMS Converter", {
      kind: "boolean",
      required: false,
      description: "Send MMS as SMS with a link where the recipient cannot receive MMS.",
    }),
    f("fallbackToLongCode", "Fallback to Long Code", { kind: "boolean", required: false }),
    f("areaCodeGeomatch", "Area Code Geomatch", {
      kind: "boolean",
      required: false,
      description: "Prefer a sender with the recipient's area code.",
    }),
    f("validityPeriod", "Validity Period (seconds)", {
      kind: "number",
      required: false,
      description:
        "How long a queued message may wait before Twilio drops it, 1 to 36000. Blank uses Twilio's default.",
    }),
    f("useInboundWebhookOnNumber", "Use Each Number's Own Webhook", {
      kind: "boolean",
      required: false,
    }),
    f("usA2pRegistered", "US A2P 10DLC Registered", {
      kind: "boolean",
      required: false,
      editable: false,
    }),
    f("createdAt", "Created", { required: false, editable: false }),
    f("updatedAt", "Updated", { required: false, editable: false }),
  ],
  outputs: [o("messagingServiceSid", "Messaging Service SID")],
  supportsCreate: true,
  supportsUpdate: true,
  iconKey: "message",
});

/** `GET verify.twilio.com/v2/Services`. */
export const VerifyServiceResourceType = rt({
  name: "Verify Service",
  id: "verify-service",
  description:
    "A Verify service that sends one-time codes by SMS, voice, email or WhatsApp. Shows the last 30 days of verification attempts and conversion rate; create, edit and delete them here.",
  fields: [
    f("friendlyName", "Name", {
      description:
        "Shown in the verification message, so use your product's name. Up to 30 characters.",
    }),
    f("serviceSid", "Service SID", { required: false, editable: false }),
    f("codeLength", "Code Length", {
      kind: "number",
      required: false,
      description: "Digits in the code, 4 to 10.",
    }),
    f("lookupEnabled", "Look Up Numbers First", {
      kind: "boolean",
      required: false,
      description: "Run a Lookup on the number before sending (billed as a Lookup).",
    }),
    f("skipSmsToLandlines", "Skip SMS to Landlines", { kind: "boolean", required: false }),
    f("dtmfInputRequired", "Require Keypress on Voice", { kind: "boolean", required: false }),
    f("doNotShareWarningEnabled", "Do-Not-Share Warning", { kind: "boolean", required: false }),
    f("customCodeEnabled", "Allow Custom Codes", { kind: "boolean", required: false }),
    f("psd2Enabled", "PSD2 Payment Details", { kind: "boolean", required: false }),
    f("defaultTemplateSid", "Default Template", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
    f("updatedAt", "Updated", { required: false, editable: false }),
  ],
  outputs: [o("verifyServiceSid", "Verify Service SID")],
  supportsCreate: true,
  supportsUpdate: true,
  iconKey: "shield",
});

/** `GET /2010-04-01/Accounts/{Sid}/Applications.json`. */
export const TwimlAppResourceType = rt({
  name: "TwiML App",
  id: "twiml-app",
  description:
    "A TwiML application: a reusable set of voice and messaging webhooks that phone numbers and Voice SDK clients point at.",
  fields: [
    f("friendlyName", "Name", { description: "Up to 64 characters." }),
    f("appSid", "Application SID", { required: false, editable: false }),
    f("voiceUrl", "Voice URL", { required: false }),
    f("voiceMethod", "Voice Method", { kind: "enum", enumValues: METHODS, required: false }),
    f("voiceFallbackUrl", "Voice Fallback URL", { required: false }),
    f("smsUrl", "Messaging URL", { required: false }),
    f("smsMethod", "Messaging Method", { kind: "enum", enumValues: METHODS, required: false }),
    f("smsFallbackUrl", "Messaging Fallback URL", { required: false }),
    f("statusCallback", "Call Status Callback URL", { required: false }),
    f("smsStatusCallback", "Message Status Callback URL", { required: false }),
    f("createdAt", "Created", { required: false, editable: false }),
  ],
  outputs: [o("applicationSid", "Application SID")],
  supportsCreate: true,
  supportsUpdate: true,
  iconKey: "code",
});

/** `GET /2010-04-01/Accounts/{Sid}/Usage/Triggers.json`. */
export const UsageTriggerResourceType = rt({
  name: "Usage Trigger",
  id: "usage-trigger",
  description:
    "A Twilio usage trigger: Twilio calls a webhook when a usage category crosses a threshold, once per day, month or year. With Total spend, Price and Monthly it is a budget alert that Twilio itself enforces.",
  fields: [
    f("friendlyName", "Name", { required: false, description: "Up to 64 characters." }),
    f("usageCategory", "Usage Category", { editable: false }),
    f("triggerBy", "Measure", {
      kind: "enum",
      enumValues: ["price", "count", "usage"],
      editable: false,
    }),
    f("triggerValue", "Threshold", { kind: "number", editable: false }),
    f("currentValue", "Current Value", { kind: "number", required: false, editable: false }),
    f("recurring", "Repeats", {
      kind: "enum",
      enumValues: ["none", "daily", "monthly", "yearly", "alltime"],
      required: false,
      editable: false,
    }),
    f("callbackUrl", "Webhook URL", {
      description:
        "Twilio calls this when the trigger fires. An Infrawrench workflow's webhook URL works, and lets the workflow alert through Slack, Teams or paging.",
    }),
    f("callbackMethod", "Webhook Method", { kind: "enum", enumValues: METHODS, required: false }),
    f("dateFired", "Last Fired", { required: false, editable: false }),
    f("triggerSid", "Trigger SID", { required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
    f("updatedAt", "Updated", { required: false, editable: false }),
  ],
  outputs: [o("triggerSid", "Trigger SID")],
  supportsCreate: true,
  supportsUpdate: true,
  iconKey: "bell",
});

/** `GET /2010-04-01/Accounts/{Sid}/Keys.json` (needs the auth token or a Main key). */
export const ApiKeyResourceType = rt({
  name: "API Key",
  id: "api-key",
  description:
    "A Twilio API key on the main account. Listing and managing keys needs the auth token or a Main API key; deleting one revokes it immediately.",
  fields: [
    f("friendlyName", "Name", { required: false, description: "Up to 64 characters." }),
    f("keySid", "Key SID", { required: false, editable: false }),
    f("inUse", "Used by This Connection", { kind: "boolean", required: false, editable: false }),
    f("createdAt", "Created", { required: false, editable: false }),
    f("updatedAt", "Updated", { required: false, editable: false }),
  ],
  outputs: [
    o("keySid", "Key SID"),
    o("secret", "Secret", {
      sensitive: true,
      description: "Only ever returned when the key is created.",
    }),
  ],
  expiryFields: [
    { fieldKey: "createdAt", from: "created", kind: "access-key", label: "Key due for rotation" },
  ],
  principalRole: { role: "key", createdKey: "createdAt" },
  supportsCreate: true,
  supportsUpdate: true,
  iconKey: "key",
});

export const RESOURCE_TYPES: ResourceTypeDefinition[] = [
  AccountResourceType,
  SubaccountResourceType,
  PhoneNumberResourceType,
  MessagingServiceResourceType,
  VerifyServiceResourceType,
  TwimlAppResourceType,
  UsageTriggerResourceType,
  ApiKeyResourceType,
];
