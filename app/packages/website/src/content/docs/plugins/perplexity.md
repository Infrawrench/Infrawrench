---
title: Perplexity
description: Chat with Sonar, Agent API and Router models in the Playground, compare Router prices, run asynchronous deep-research requests, and review your Agent API skills on Perplexity.
sidebar_order: 44
---

## What you can manage

- **Sonar Models**: `sonar`, `sonar-pro`, `sonar-reasoning-pro` and `sonar-deep-research`, each with a **Playground** that streams search-grounded answers.
- **Agent API Models**: every model the Agent API accepts, from Perplexity and other providers, with a **Playground**.
- **Router Models**: the open-weight and third-party models on the OpenAI-compatible Router API, with input, output and cache prices per million tokens and a streaming **Playground**.
- **Async Sonar Requests**: create a request (usually a `sonar-deep-research` report) from a question and an optional recency filter, then read the answer, its citations and its cost when it's done.
- **Skills**: the Agent API skills in your project, with each skill's revision history. You can delete a skill.

## Connect your account

1. Open the [Perplexity API console](https://console.perplexity.ai/project/keys) and pick the project.
2. Create an API key and paste the `pplx-…` value into **API Key**. Keys have no scopes.
3. Make sure the project has credits or a payment method. Without them, every call fails with an out-of-credits error.

<insert [Perplexity Add-account form with the API Key field and the Create an API key help link] here>

## Try a model in the Playground

<insert [Perplexity sonar-pro model detail page with the Playground tab showing a streamed, search-grounded answer] here>

Sonar and Router models stream token by token. Agent API replies appear once they're complete.

## Run a deep-research request

1. Click **New Async Sonar Request**.
2. Pick the model, type the question, and optionally set a search recency (past day, week, month or year).
3. Deep-research reports take minutes. Refresh the request to watch its status go from `CREATED` to `IN_PROGRESS` to `COMPLETED`.
4. Read the answer and citations on the detail page.

## Status

Perplexity incidents that affect the API show as provider-wide. Website, app and Computer incidents are left out.

## Tips & limits

- **There's no usage or billing data.** Check spend, credits, usage tiers and keys in the API console.
- API keys aren't listed, since Perplexity doesn't expose them.
- The async request list shows one page, so very old requests may not appear.
- Skill bundles are zip uploads. Create and update them with Perplexity's SDK or CLI.
