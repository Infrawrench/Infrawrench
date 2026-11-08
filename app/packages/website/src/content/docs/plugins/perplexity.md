---
title: Perplexity
description: Chat with Sonar, Agent API and Router models in the Playground, compare Router prices, and review your Agent API skills on Perplexity.
sidebar_order: 44
---

## What you can manage

- **Sonar Models**: `sonar`, `sonar-pro`, `sonar-reasoning-pro` and `sonar-deep-research`, each with a **Playground** that streams search-grounded answers.
- **Agent API Models**: every model the Agent API accepts, from Perplexity and other providers, with a **Playground**.
- **Router Models**: the open-weight and third-party models on the OpenAI-compatible Router API, with input, output and cache prices per million tokens and a streaming **Playground**.
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

Ask the question from the **Playground** on `sonar-deep-research` or an Agent API model. Infrawrench doesn't list asynchronous requests: Perplexity retired asynchronous Sonar requests on September 27, 2026, and the Agent API's background responses that replace them can only be read one at a time by id, with no way to list them.

## Status

Perplexity incidents that affect the API show as provider-wide. Website, app and Computer incidents are left out.

## Tips & limits

- **There's no usage or billing data.** Check spend, credits, usage tiers and keys in the API console.
- API keys aren't listed, since Perplexity doesn't expose them.
- Skill bundles are zip uploads. Create and update them with Perplexity's SDK or CLI.
