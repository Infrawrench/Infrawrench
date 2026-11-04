---
title: AI spend by caller
description: Split billed AI spend by team, user, feature or customer by matching per-request logs (Bedrock, Cloudflare AI Gateway, LiteLLM, JSONL) to your provider bills.
sidebar_order: 5
---

Your AI providers bill you per model and, at best, per token type. They don't know which team, feature or customer sent the requests. **AI attribution** fills that gap. It reads the per-request logs you already have, works out how much of each billed line each caller accounts for, and splits the bill that way.

Two things are always true:

- **Billed totals never change.** Attribution only decides who an already billed dollar belongs to. Every split adds up to the line it came from, and your cost reports, budgets and exports still total exactly what the provider billed.
- **Spend the logs don't explain stays visible.** Spend that no request log accounts for is labelled `(unattributed)`. It's never spread across the callers that were seen.

> **Cloud only.** Request logs are collected by Infrawrench Cloud. In the desktop app, you can set up and read attribution while signed into a cloud org.

<insert [Settings → AI Attribution with two sources (Bedrock S3 and a Cloudflare AI Gateway), a Team dimension, and the match-rate table] here>

## What you get

1. **Group AI costs by model and token type, with no setup.** Your AI provider accounts already tag their cost lines with `ai:provider`, `ai:model` and `ai:token_type`, so you can group any cost report by them. OpenAI and Anthropic name the model and token type. Cursor names the model. Bedrock (through your AWS account) names the model for Marketplace editions and the provider otherwise. Vertex AI and the Gemini API (GCP), Azure OpenAI (Azure), OpenRouter, Mistral, xAI, Fireworks, Together and Devin tag at least the provider.
2. **Add a source of request logs.** Each UTC day is read once, a few hours after it ends. Raw requests are never stored.
3. **Each day's bill is split by caller.** If the logs explain $40 of a $100 line, $40 is attributed and $60 stays `(unattributed)`. If list prices add up to more than you were billed (discounts, batch pricing), every caller is scaled down by the same proportion.
4. **Each caller dimension becomes a tag key.** A dimension called `team` shows up in every cost report, budget filter and allocation rule as the tag key `caller:team`.

If a provider restates last week's bill, it's re-split the same day.

## Add a source

Open **Settings > AI Attribution** and choose **Add source**. You pick every location from a list the provider supplies, so you never type a bucket name or a gateway id.

| Source                                    | Reads                                                       | Needs                                                                                           |
| ----------------------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Bedrock invocation logs (S3)              | The gzipped invocation-log objects Bedrock delivers to S3   | Model invocation logging enabled to S3; `s3:ListBucket` and `s3:GetObject` on the bucket        |
| Bedrock invocation logs (CloudWatch Logs) | A Logs Insights `stats` query over the invocation-log group | Logging enabled to CloudWatch Logs; `logs:StartQuery`, `logs:GetQueryResults`, `logs:StopQuery` |
| Custom request logs (JSONL in S3)         | One JSON object per request, in the format below            | `s3:ListBucket` and `s3:GetObject`                                                              |
| Cloudflare AI Gateway request logs        | A gateway's request log through the AI Gateway API          | Log collection on for the gateway; the token needs **Account · AI Gateway:Read**                |
| LiteLLM proxy spend logs                  | `/spend/logs/v2` on a LiteLLM proxy you run                 | The proxy's https URL and an admin (master) key                                                 |

The Bedrock source preselects the bucket or log group named in Bedrock's own logging settings, which needs `bedrock:GetModelInvocationLoggingConfiguration`.

How your callers attach metadata depends on the source:

- **Bedrock**: the Converse `requestMetadata` field or the `X-Amzn-Bedrock-Request-Metadata` header.
- **Cloudflare AI Gateway**: the `cf-aig-metadata` header (at most five entries).
- **LiteLLM**: team, user, end user, key alias, request tags and any `metadata` your callers send.

> **CloudWatch queries cost money.** Logs Insights bills your AWS account per GB scanned, and the source warns you when you add it. If your logs also land in S3, the S3 source reads them with no query charge.

A LiteLLM proxy must be reachable over public https. Private and reserved addresses are refused, the same rule as cost exports.

### Custom JSONL format

Write one JSON object per request, one per line, optionally gzipped. Put the files under a prefix with the day in the object key (`requests/2026/10/03/part-0001.jsonl.gz`, `requests/dt=2026-10-03/…` or `requests/2026-10-03.jsonl`):

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
| `model`                                                       | yes      | The model id as you called it. Dates and version suffixes are fine.                                                                                  |
| `input_tokens`, `output_tokens`                               | no       | Token counts.                                                                                                                                        |
| `cache_read_tokens`, `cache_write_tokens`, `reasoning_tokens` | no       | Token counts, when your SDK reports them.                                                                                                            |
| `cost`, `currency`                                            | no       | Your own per-request cost estimate. Used to weight bill lines without a token type and to estimate the unattributed remainder.                       |
| `metadata`                                                    | no       | A flat object of strings, numbers or booleans: the keys you map to dimensions.                                                                       |

camelCase spellings (`inputTokens`, `cacheReadTokens`) work too.

## Set up caller dimensions

A dimension is one way to slice spend. It lists the metadata keys that feed it, and the first one present wins. For example, `team` might read `team`, then `team_id`, then LiteLLM's `user_api_key_team_alias`. Presets for Team, User, Feature and Customer are one click away, and the key picker suggests metadata keys seen in your logs.

- A matched request with none of the dimension's keys is labelled `(not set)`.
- An organization can map up to six dimensions. Pick stable keys with few distinct values. A per-request id as a dimension folds into `(other)` past the daily limit.
- Only mapped keys are kept. A new mapping applies from the next collection. To apply it to past data, choose **Re-collect** on a source to re-read its history (as far back as the source allows).

## Check match rate and coverage

The bottom of the page shows, per source:

- **Matched**: requests that landed on a billed line.
- **Ambiguous**: requests whose model matched more than one billed model (two dated snapshots of the same model, say). They're split between them by billed amount.
- **Unmatched**: requests with nowhere to land, because the provider isn't connected to Infrawrench or its bill doesn't include that model. They're counted, never forced onto another line.
- **Bill covered**: the share of the billed lines this source touched that its requests explain.

Per provider, it shows billed, attributed and unattributed spend. A source marked **partial** hit a read limit on some days: a gateway with more than 200,000 requests in a day, or more than 2,000 distinct metadata combinations, with the rest folded into `(other)`.

## Use it in reports, budgets and allocation rules

Pick `caller:team` (or any dimension) wherever you can choose a tag key:

- **Cost reports and dashboard graphs**: group by tag `caller:team` for a daily series of AI spend per team, with `(unattributed)` as its own series.
- **Budgets**: filter on `caller:team = search` to budget one team's AI spend.
- **Allocation rules and showback**: a rule matching tag `caller:team = search` assigns that team's share of every AI bill to its cost centre.
- **Model and token type**: group by `ai:model` or `ai:token_type` (no request logs needed).

Reports that don't use a `caller:` tag show the bill exactly as before.

## Retention and privacy

- Daily request totals are kept for 400 days, so a bill restated months later can still be re-split.
- The split by caller is kept for three years, like the cost history it describes.
- Raw request records are never stored, and only the metadata keys you map are kept. A user id or email never reaches Infrawrench unless you map that key.
- Each source reads at most 90 days back (30 for CloudWatch and AI Gateway, which usually keep logs for less time).

## Permissions

- Reading attribution needs `costs:read`.
- Adding or editing a source needs `org:settings:write`, since a source allows daily reads of your logs and, for CloudWatch, a query billed to your AWS account. Every change is audit-logged.
- Mapping dimensions needs `costs:write`, like cost centres.

## CLI, MCP and Terraform

- `infrawrench ai-spend [dimension]` prints per-provider coverage, per-source match rates and spend by caller. `infrawrench ai-spend sources` lists sources and their collection state. Both take `--json` and `--last 30d`. See [CLI](./cli.md).
- MCP tools `query_ai_spend_by_caller` and `list_ai_request_sources`. See [MCP](./mcp.md).
- Terraform resources `infrawrench_ai_request_source` and `infrawrench_ai_attribution_dimension`. See [Terraform provider](./terraform-provider.md).
- The HTTP API lives under `/api/org/{orgId}/ai-attribution`.
