---
title: Perplexity
description: Chat with Sonar, Agent API and Router models in the Playground, compare Router prices, run asynchronous deep-research requests, and review your Agent API skills on Perplexity.
sidebar_order: 44
---

## What you can manage

- **Sonar Models**: `sonar`, `sonar-pro`, `sonar-reasoning-pro` and `sonar-deep-research`, each with a **Playground** that streams search-grounded answers from `POST /v1/sonar`.
- **Agent API Models**: every model the Agent API (`POST /v1/agent`) accepts, from Perplexity and other providers, with a **Playground**.
- **Router Models**: the open-weight and third-party models on the OpenAI-compatible Router API, with input, output and cache prices per million tokens and a streaming **Playground**.
- **Async Sonar Requests**: create a request (typically a `sonar-deep-research` report) from a question and an optional recency filter, then read the answer, its citations and its cost when it completes.
- **Skills**: the Agent API skills in your project, with each skill's revision history. Delete a skill (the delete is guarded by its current revision, so it never races an update).

## Credentials

1. Open the [Perplexity API console](https://console.perplexity.ai/project/keys) and pick the project.
2. Create an API key and paste the `pplx-…` value into **API Key**. Keys have no scopes.
3. Make sure the project has credits or a payment method; without them every call answers with an out-of-credits error.

<insert [Perplexity Add-account form with the API Key field and the Create an API key help link] here>

## Playground

<insert [Perplexity sonar-pro model detail page with the Playground tab showing a streamed, search-grounded answer] here>

Sonar and Router models stream token by token. The Agent API streams typed events rather than chat deltas, so its Playground shows each reply when it is complete.

## Async requests

**New Async Sonar Request** asks for the model, the question and an optional search recency (past day, week, month or year). Deep-research reports take minutes; refresh the request to see its status move from `CREATED` through `IN_PROGRESS` to `COMPLETED`, then read the answer and citations on the detail page.

## Status

Incidents on status.perplexity.com that affect the API are shown as provider-wide. Website, app and Computer incidents are ignored.

## Tips & limits

- **There is no API usage or billing endpoint.** Spend, credits, usage tiers and keys are in the API console. (Perplexity's Analytics API covers the Enterprise web app, not API spend, and needs a separate org analytics key, so it is not used.)
- API keys cannot be listed through the API, so keys are not shown as resources.
- The async request listing returns one page; very old requests may not appear.
- Skill bundles are zip uploads, so create and update them with Perplexity's SDK or CLI.
