declare namespace Cloudflare {
  interface Env {
    /** AWS bulk pricing data, written by .github/workflows/aws-bulk-pricing-sync.yml. */
    AWS_BULK_PRICING: KVNamespace;
  }
}
