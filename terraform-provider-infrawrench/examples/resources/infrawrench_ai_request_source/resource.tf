# Bedrock invocation logs that Bedrock already delivers to S3, read through
# the connected AWS account.
data "infrawrench_accounts" "aws" {
  plugin_id = "aws"
}

resource "infrawrench_ai_request_source" "bedrock" {
  name           = "Bedrock invocation logs"
  kind           = "plugin"
  account_id     = data.infrawrench_accounts.aws.accounts[0].id
  source_kind_id = "bedrock-s3"

  location = {
    bucket = "acme-bedrock-invocation-logs"
    prefix = "AWSLogs/"
    region = "us-east-1"
  }

  lookback_days = 30
}

# A LiteLLM proxy you run. The key is write-only and lands in the state file,
# so feed it from a secret manager rather than a literal.
resource "infrawrench_ai_request_source" "litellm" {
  name           = "LiteLLM proxy"
  kind           = "litellm"
  source_kind_id = "litellm-spend-logs"
  base_url       = "https://litellm.example.com"
  api_key        = var.litellm_master_key
}
