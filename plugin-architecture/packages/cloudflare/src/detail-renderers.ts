// Barrel for Cloudflare detail-view renderers, split by resource domain.
// Re-exports keep the historical `./detail-renderers.js` import path stable.
export { tunnelStatus, sslStatus } from "./detail-renderers/status.js";
export {
  renderZoneDetail,
  renderSSLCertificateDetail,
  renderPageRuleDetail,
  renderLoadBalancerDetail,
  renderCustomHostnameDetail,
} from "./detail-renderers/dns.js";
export {
  renderWorkerDetail,
  renderWorkersAiModelDetail,
  renderWorkerRouteDetail,
  renderDurableObjectNamespaceDetail,
  renderAiGatewayDetail,
} from "./detail-renderers/compute.js";
export {
  renderR2BucketDetail,
  renderKVNamespaceDetail,
  renderD1DatabaseDetail,
  renderQueueDetail,
  renderHyperdriveDetail,
} from "./detail-renderers/storage.js";
export {
  renderTunnelDetail,
  renderFirewallRuleDetail,
  renderAccessApplicationDetail,
  renderEmailRoutingRuleDetail,
  renderWaitingRoomDetail,
  renderAccessPolicyDetail,
  renderSpectrumApplicationDetail,
  renderLogpushJobDetail,
  renderTurnstileWidgetDetail,
} from "./detail-renderers/security.js";
export {
  renderRateLimitRuleDetail,
  renderRedirectRuleDetail,
  renderCacheRuleDetail,
  renderIpAccessRuleDetail,
} from "./detail-renderers/rules.js";
export { renderGenericDetail } from "./detail-renderers/generic.js";
