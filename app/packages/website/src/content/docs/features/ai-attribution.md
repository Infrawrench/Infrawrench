---
title: AI spend by caller
description: Split billed AI spend by team, user, feature or customer by joining per-request logs (Bedrock, Cloudflare AI Gateway, LiteLLM, JSONL) to your provider bills.
sidebar_order: 5
---

Your AI providers bill you per model and, at best, per token type. They do not know which team, feature or customer sent the requests. **AI attribution** fills that gap: it reads the per-request logs you already have, works out how much of each billed line each caller's requests account for, and splits the bill accordingly.

Two rules hold everywhere:

- **Billed totals never change.** Attribution only decides who a dollar that was already billed belongs to. Every split adds up to the line it came from, and your cost reports, budgets and exports still total exactly what the provider billed.
- **What the logs do not explain stays visible.** Spend that no request log accounts for is labelled `(unattributed)`. It is never spread across the callers that were seen.

> **Cloud only.** Request logs are collected by Infrawrench Cloud's background pollers. The desktop app configures and reads attribution while signed into a cloud org.

<insert [Settings → AI Attribution with two sources (Bedrock S3 and a Cloudflare AI Gateway), a Team dimension, and the match-rate table] here>

## How it works

1. **Your AI provider plugins tag their bills.** OpenAI and Anthropic name the model and token type on each cost line; Cursor names the model; Bedrock (through the AWS account) names the model for Marketplace editions and the provider otherwise; Vertex AI and the Gemini API (GCP), Azure OpenAI (Azure), OpenRouter, Mistral, xAI, Fireworks, Together and Devin tag at least the provider. These appear on every cost line as the tags `ai:provider`, `ai:model` and `ai:token_type`, so you can already group any cost report by model or token type.
2. **Sources supply per-request logs.** Each closed UTC day is read once, a few hours after it ends, and folded into daily totals per provider, model and the metadata keys you mapped. Raw requests are never stored.
3. **Each day is split.** Requests are matched to the billed line for their model (falling back to the provider-level line when the bill does not name models), priced at list rates, and scaled so the split adds up to the billed amount. If the logs explain $40 of a $100 line, $40 is attributed and $60 stays `(unattributed)`; if list prices come to more than the bill (discounts, batch pricing), every caller is scaled down proportionally.
4. **Caller dimensions become tag keys.** A dimension called `team` appears in every cost report, budget filter and allocation rule as the tag key `caller:team`.

The split is recomputed whenever a source collects a day and after every cost collection, so a provider restating last week's bill re-splits it the same day.

## Sources

Open **Settings → AI Attribution** and choose **Add source**. Every location is picked from a list the provider supplies; you never type a bucket name or a gateway id.

| Source                                    | Reads                                                       | Needs                                                                                           |
| ----------------------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Bedrock invocation logs (S3)              | The gzipped invocation-log objects Bedrock delivers to S3   | Model invocation logging enabled to S3; `s3:ListBucket` and `s3:GetObject` on the bucket        |
| Bedrock invocation logs (CloudWatch Logs) | A Logs Insights `stats` query over the invocation-log group | Logging enabled to CloudWatch Logs; `logs:StartQuery`, `logs:GetQueryResults`, `logs:StopQuery` |
| Custom request logs (JSONL in S3)         | One JSON object per request, in the format below            | `s3:ListBucket` and `s3:GetObject`                                                              |
| Cloudflare AI Gateway request logs        | A gateway's request log through the AI Gateway API          | Log collection on for the gateway; the token needs **Account · AI Gateway:Read**                |
| LiteLLM proxy spend logs                  | `/spend/logs/v2` on a LiteLLM proxy you run                 | The proxy's https URL and an admin (master) key                                                 |

The Bedrock source preselects the bucket or log group named in Bedrock's own logging configuration (`bedrock:GetModelInvocationLoggingConfiguration`). Callers attach metadata through the Converse `requestMetadata` field or the `X-Amzn-Bedrock-Request-Metadata` header; the AI Gateway source reads the `cf-aig-metadata` header (at most five entries); the LiteLLM source reads team, user, end user, key alias, request tags and any `metadata` your callers send.

> **CloudWatch queries cost money.** Logs Insights bills your AWS account per GB scanned. The source says so where you add it. If your logs also land in S3, the S3 source reads them without a query charge.

A LiteLLM proxy must be reachable over public https: private and reserved addresses are refused, the same rule as cost exports.

### Custom JSONL format

Write one JSON object per request, one per line, optionally gzipped, under a prefix with the day in the object key (`requests/2026/10/03/part-0001.jsonl.gz`, `requests/dt=2026-10-03/…` or `requests/2026-10-03.jsonl`):

```json
{
  "timestamp": "2026-10-03T14:02:11Z",
  "provider": "anthropic",
  "model": "claude-sonnet-4-5",
  "input_tokens": 1840,
  "output_tokens": 312,
  "cache_read_tokens": 12000,
  "cache_write_tokens": 0,
  "reasoning_tokens": 0,
  "cost": 0.0123,
  "currency": "USD",
  "metadata": { "team": "search", "feature": "summaries" }
}
```

| Field                                                         | Required | Meaning                                                                                                                                              |
| ------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `timestamp`                                                   | yes      | ISO 8601 instant (or Unix seconds). Records outside the day being read are skipped.                                                                  |
| `provider`                                                    | yes      | `openai`, `anthropic`, `bedrock`, `vertex`, `azure-openai`, `gemini`, `mistral`… Common gateway spellings (`aws-bedrock`, `vertex_ai`) are accepted. |
| `model`                                                       | yes      | The model id as you called it. Dates and version suffixes are normalized before matching.                                                            |
| `input_tokens`, `output_tokens`                               | no       | Token counts.                                                                                                                                        |
| `cache_read_tokens`, `cache_write_tokens`, `reasoning_tokens` | no       | Token counts, when your SDK reports them.                                                                                                            |
| `cost`, `currency`                                            | no       | Your own per-request cost estimate. Used to weight untyped bill lines and to estimate the unattributed remainder.                                    |
| `metadata`                                                    | no       | A flat object of strings, numbers or booleans: the keys you map to dimensions.                                                                       |

camelCase spellings (`inputTokens`, `cacheReadTokens`) are accepted too.

## Caller dimensions

A dimension names one way to slice spend and lists the metadata keys that feed it, first present wins: `team` might read `team`, then `team_id`, then LiteLLM's `user_api_key_team_alias`. Presets for Team, User, Feature and Customer are one click away, and the key picker suggests the metadata keys seen in your logs.

- A matched request with none of the dimension's keys is labelled `(not set)`.
- An organization can map up to six dimensions. Each one multiplies the combinations stored per day, so pick stable, low-cardinality keys; a per-request id as a dimension folds into `(other)` past the daily cap.
- Sources keep only mapped keys. A new mapping applies from the next collection; choose **Re-collect** on a source to re-read its history (up to the source's retention) with the new key.

## Match rate and coverage

The bottom of the page reports, per source:

- **Matched**: requests that landed on a billed line.
- **Ambiguous**: requests whose model matched more than one billed model (two dated snapshots of the same model, say); they are split between them by billed amount.
- **Unmatched**: requests with nowhere to land, because the provider is not connected to Infrawrench or its bill does not include that model. They are counted, never forced onto another line.
- **Bill covered**: the share of the billed lines this source touched that its requests explain.

Per provider it shows billed, attributed and unattributed spend. A source marked **partial** hit a read cap on some days (a gateway with more than 200,000 requests in a day, or more than 2,000 distinct metadata combinations, whose tail folds into `(other)`).

## Using it in reports, budgets and allocation rules

Pick `caller:team` (or any dimension) as the tag key wherever a tag key is offered:

- **Cost reports and dashboard graphs**: group by tag `caller:team` for a daily series of AI spend per team, with `(unattributed)` as its own series.
- **Budgets**: filter on `caller:team = search` to budget one team's AI spend.
- **Allocation rules and showback**: a rule matching tag `caller:team = search` assigns that team's share of every AI bill to its cost centre.
- **Model and token type**: group by `ai:model` or `ai:token_type` (no request logs needed).

Queries that name a `caller:` tag read the attributed view of the bill; every other query reads the bill exactly as before.

## Retention and volume

- Daily request aggregates are kept for 400 days, so a bill restated months later can still be re-split.
- The attributed split is kept for three years, like the cost history it describes.
- Raw request records are never stored, and only mapped metadata keys are kept on aggregates, so a user id or email never lands in Infrawrench unless you map that key.
- Each source reads at most 90 days back (30 for CloudWatch and AI Gateway, whose own retention is usually shorter).

## Permissions

Reading attribution needs `costs:read`. Adding or editing a source needs `org:settings:write`, because a source authorizes daily reads of your logs and, for CloudWatch, a query billed to your own AWS account; every change is audit-logged. Mapping dimensions needs `costs:write`, like cost centres.

## CLI, MCP and Terraform

- `infrawrench ai-spend [dimension]` prints per-provider coverage, per-source match rates and spend by caller; `infrawrench ai-spend sources` lists sources and their collection state. Both take `--json` and `--last 30d`. See [CLI](./cli.md).
- MCP tools `query_ai_spend_by_caller` and `list_ai_request_sources`. See [MCP](./mcp.md).
- Terraform resources `infrawrench_ai_request_source` and `infrawrench_ai_attribution_dimension`. See [Terraform provider](./terraform-provider.md).
- The HTTP API lives under `/api/org/{orgId}/ai-attribution`.
