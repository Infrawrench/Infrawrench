---
title: Voyage AI
description: Browse Voyage AI embedding, contextualized, multimodal and rerank models with list prices and limits, test any model from a built-in bench, and run and track discounted batches and their files.
sidebar_order: 46
---

## What you can manage

- **Models**: the current and previous-generation Voyage embedding models (general, code, finance, law, multilingual), contextualized chunk embeddings, multimodal embeddings and rerankers, with context length, output dimensions and price per million tokens. Each model has a **Test** tab.
- **Batches**: create a batch from an uploaded file for text embeddings, contextualized embeddings or reranking, follow its progress and request counts, and cancel it while it is validating or in progress. Batches finish within 12 hours at a 33% discount.
- **Files**: batch input, output and error files with size and expiry (30 days after upload). Delete them when you are done.

## Credentials

1. Sign in to the [Voyage dashboard](https://dashboard.voyageai.com/organization/api-keys) and open **API keys**.
2. Click **Create new secret key** and paste it into **API Key**. Keys have no scopes.

The key is checked with a free file listing, so adding the account spends no tokens.

<insert [Voyage AI Add-account form with the API Key field and the Create an API key help link] here>

## The Test tab

Every model page has a **Test** tab that calls the model with what you type:

- **Embedding and multimodal models** embed the text and report the vector's dimension, norm and first values, plus the tokens used.
- **Contextualized models** treat blank-line-separated paragraphs as chunks of one document and embed each in context.
- **Rerankers** take the query on the first line and one document per following line, and return the documents ranked by relevance score.

<insert [Voyage rerank-3 model page with the Test tab showing a query, three documents and the ranked result] here>

## Creating a batch

**New Batch** asks for the input file (only files uploaded with purpose `batch` are offered), the endpoint, and the model, which is filtered to the models that endpoint accepts, with their prices. Optional `key=value` metadata lines are stored on the batch.

## Status

Incidents on Voyage's status page that affect the API are shown as provider-wide; dashboard-only incidents are ignored.

## Tips & limits

- **Voyage has no model-listing API.** The catalogue comes from Voyage's documentation and pricing pages, so a brand-new model shows up after a plugin update rather than on the next refresh. Deprecated models are left out.
- **There is no usage, billing or key-management API.** Token usage, the free-token allowance and spend are on the dashboard's Usage and Billing pages; the model page links there.
- Batch input files are uploaded with Voyage's SDK, CLI or dashboard; the plugin lists and deletes them.
