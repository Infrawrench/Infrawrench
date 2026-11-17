/**
 * The one way server code reaches Claude: AI chat, the chat's web search,
 * `infra.ai()` in workflows and the weekly digest's narrative all build their
 * Anthropic client here.
 *
 * Every call goes through Cloudflare AI Gateway on Unified Billing, the same
 * gateway arrangement instances.infrawrench.com uses. That site runs in a
 * Worker and calls the gateway through the `AI` binding; this code runs on the
 * Node gateway (chat is a session route) as well as in Workers, where there is
 * no binding, so it calls the gateway's provider-native Anthropic endpoint
 * (`gateway.ai.cloudflare.com/v1/<account>/<gateway>/anthropic`) instead. The
 * request and the response, event stream included, stay in Anthropic's own
 * format, so the SDK's streaming and tool handling are unchanged, and model
 * ids are Anthropic's (`claude-sonnet-5-5`), not the catalog's dotted form.
 *
 * Authentication is the gateway token in `cf-aig-authorization`. The request
 * carries no `x-api-key` at all: with no provider credential on the request,
 * the gateway bills Cloudflare credits rather than forwarding a key, so the
 * deployment holds no Anthropic key. There is deliberately no direct-key
 * path: local development uses a gateway too (the `default` gateway id is
 * created on first use).
 */
import Anthropic from "@anthropic-ai/sdk";

interface GatewayConfig {
  accountId: string;
  gatewayId: string;
  token: string;
}

function gatewayConfig(): GatewayConfig | null {
  const accountId = process.env["CLOUDFLARE_ACCOUNT_ID"];
  const gatewayId = process.env["AI_GATEWAY_ID"];
  const token = process.env["AI_GATEWAY_TOKEN"];
  if (!accountId || !gatewayId || !token) return null;
  return { accountId, gatewayId, token };
}

/** Whether this deployment can call Claude at all. */
export function isAnthropicConfigured(): boolean {
  return gatewayConfig() !== null;
}

/** What to tell an operator when {@link isAnthropicConfigured} is false. */
export const ANTHROPIC_NOT_CONFIGURED =
  "Claude is not configured for this deployment (set CLOUDFLARE_ACCOUNT_ID, AI_GATEWAY_ID and AI_GATEWAY_TOKEN).";

export interface AnthropicClientOptions {
  /** Per-request timeout in milliseconds; the SDK's default when omitted. */
  timeout?: number;
  maxRetries?: number;
}

/** An Anthropic client for this deployment. Throws when none is configured. */
export function anthropicClient(options: AnthropicClientOptions = {}): Anthropic {
  const tuning = {
    ...(options.timeout !== undefined ? { timeout: options.timeout } : {}),
    ...(options.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {}),
  };
  const gateway = gatewayConfig();
  if (!gateway) throw new Error(ANTHROPIC_NOT_CONFIGURED);
  return new Anthropic({
    ...tuning,
    // Explicit nulls so the SDK neither reads ANTHROPIC_API_KEY from the
    // environment nor sends a credential header: a provider key on the
    // request would be forwarded to Anthropic instead of billing the
    // gateway's credits.
    apiKey: null,
    authToken: null,
    baseURL: `https://gateway.ai.cloudflare.com/v1/${encodeURIComponent(gateway.accountId)}/${encodeURIComponent(gateway.gatewayId)}/anthropic`,
    defaultHeaders: {
      "cf-aig-authorization": `Bearer ${gateway.token}`,
      "x-api-key": null,
      authorization: null,
    },
  });
}
