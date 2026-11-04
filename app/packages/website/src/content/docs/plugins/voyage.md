---
title: Voyage AI
description: Browse Voyage AI embedding, contextualized, multimodal and rerank models with list prices and limits, test any model from a built-in bench, and run and track discounted batches and their files.
sidebar_order: 46
---

## What you can manage

- **Models**: the current and previous-generation Voyage embedding models (general, code, finance, law, multilingual), contextualized chunk embeddings, multimodal embeddings and rerankers, with context length, output dimensions and price per million tokens. Each model has a **Test** tab.
- **Batches**: create a batch from an uploaded file for text embeddings, contextualized embeddings or reranking, follow its progress and request counts, and cancel it while it's validating or in progress. Batches finish within 12 hours at a 33% discount.
- **Files**: batch input, output and error files with size and expiry (30 days after upload). Delete them when you're done.

## Connect your account

1. Sign in to the [Voyage dashboard](https://dashboard.voyageai.com/organization/api-keys) and open **API keys**.
2. Click **Create new secret key** and paste it into **API Key**. Keys have no scopes.

Checking the key when you add the account uses no tokens.

<insert [Voyage AI Add-account form with the API Key field and the Create an API key help link] here>

## Test a model

Every model page has a **Test** tab that runs the model on what you type:

- **Embedding and multimodal models** embed the text and show the vector's dimension, norm and first values, plus the tokens used.
- **Contextualized models** treat paragraphs separated by blank lines as chunks of one document and embed each in context.
- **Rerankers** take the query on the first line and one document per line after it, and return the documents ranked by relevance score.

<insert [Voyage rerank-3 model page with the Test tab showing a query, three documents and the ranked result] here>

## Create a batch

Click **New Batch** and pick:

1. The input file (only files uploaded with purpose `batch` are offered).
2. The endpoint.
3. The model. Only models that endpoint accepts are listed, with their prices.

You can add optional `key=value` metadata lines, which are stored on the batch.

## Status

Voyage incidents that affect the API show as provider-wide. Dashboard-only incidents are left out.

## Tips & limits

- **New models appear after an Infrawrench update.** Voyage has no model list to read, so a brand-new model shows up after an update rather than on the next refresh. Deprecated models are left out.
- **There's no usage, billing or key data.** Check token usage, the free-token allowance and spend on the dashboard's Usage and Billing pages. The model page links there.
- Upload batch input files with Voyage's SDK, CLI or dashboard. You can list and delete them here.
