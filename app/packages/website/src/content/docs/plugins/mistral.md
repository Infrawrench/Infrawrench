---
title: Mistral AI
description: Manage Mistral models, agents, libraries, voices, files, fine-tuning and batch jobs, plus Voxtral transcription and speech synthesis from the Speech tab.
sidebar_order: 41
---

Connect Mistral AI to manage your models, agents, libraries and jobs, test transcription and speech synthesis, and track your monthly spend.

## What you can manage

- **Models**: base and fine-tuned checkpoints, with the full `capabilities` flag table and max context length. Fine-tuned models also get **Archive** / **Unarchive** and **Delete model**. Base models belong to Mistral and offer neither.
- **Agents**: each agent's model, instructions, tools, attached libraries, handoffs, completion arguments and version history. Create one with a model picked from the live list, edit its name, description or instructions (every edit becomes a new agent version), or delete it.
- **Libraries**: document libraries agents search through a `document_library` tool, with document count and total size. Create, rename, change the description, or delete. Documents themselves are uploaded through Mistral's Libraries API.
- **Voices**: TTS presets and workspace clones. Rename, retag or delete clones.
- **Fine-tuning jobs**: status, datasets, trained tokens, and the resulting model id.
- **Batch jobs**: progress counters and output and error files. Create, cancel and delete. The create form lets you pick the input file (only files uploaded with purpose `batch` are offered), the target endpoint and the model, with an optional timeout.
- **Files**: fine-tuning datasets, batch JSONL and OCR inputs. Delete them.
- **API keys**: Enterprise plans only, with an Admin API key.

## Connect your account

1. In the Mistral console, open **API Keys** and copy your workspace key.
2. Paste it into the **API key** field.
3. Optionally add an **Admin API key**. Mistral's Admin API is **Enterprise plan only**. Without it, the API key list is empty and cost tracking is turned off, with a message explaining why.

Everything else (models, agents, libraries, voices, files, jobs, transcription and synthesis) works with the workspace key alone.

![Mistral Add-account form showing the required API key field and the optional Admin API key field with its Enterprise-only description](https://agent-assets.infrawrench.com/docs-screenshots/plugins/mistral/add-account.png)

## Test speech in the Speech tab

Open a voice (or any model) to get a **Speech** tab:

- **Synthesize** turns text into mp3 audio. The voice picker lists your workspace clones alongside the presets, with their gender, languages and description.
- **Transcribe** runs with **speaker diarisation on**, so the word table under the transcript shows speaker labels and the summary tells you how many speakers were detected.

![Mistral Speech tab on a voice, showing the transcript with a per-speaker word table below](https://agent-assets.infrawrench.com/docs-screenshots/plugins/mistral/speech-tab-voxtral.png)

## Costs

With an Admin API key attached, your Mistral usage feeds the cost dashboards. Mistral reports usage **monthly**, broken down by service (chat, completion, OCR, audio, fine-tuning, connectors), so charts show it as monthly figures.

Each month's spend appears **on the first day of that month**, as one total, the way an invoice is one line. The current month updates every day until it closes, so what you see is month to date. Two things follow:

- **A short date range can look empty.** "Last 7 days" in the middle of a month contains no 1st, so it shows no Mistral spend even when the month has plenty. Pick a range that includes the 1st, or use the month view.
- **The current and previous months keep updating daily**, so late usage and credits land in the right month without you doing anything.

## Metrics and logs

Models and agents have **Metrics** and **Logs** tabs fed by [Mistral Studio Observability](https://docs.mistral.ai/studio/observability), the trace store behind the Studio Trace Explorer. Observability is in Private Preview for Enterprise organizations, and reading traces needs the Org Admin, Workspace Admin or Observability Viewer role. Without it both tabs stay empty and the Logs tab says why. Traces only exist for calls made through instrumented code (Mistral SDK telemetry, Workflows, Vibe, or your own OpenTelemetry exporter), and they are kept for 30 days.

- **Models** chart their own LLM calls: calls, errored calls, p50 and p95 latency, and input, output and cached input tokens. The Logs tab lists recent calls, one line each with status, duration, token counts, finish reason and trace id.
- **Agents** chart their runs: runs, errored runs, p50 and p95 run duration, input and output tokens, and LLM and tool calls per run. The Logs tab lists recent runs with the same figures and the models each one used.

These tabs only need the workspace key, not the Admin API key.

## Tips and limits

- **Preset voices belong to Mistral.** You can use them but not rename or delete them. Only workspace clones can be edited.
- **API keys are listed, not created.** New keys are made in the Mistral backoffice, the only place the plaintext value is ever shown. You can revoke a key here, but not create one.
- **Speech tab uploads are capped at 25 MB.** The transcription API accepts much longer recordings. For those, send a file id or URL to the API directly.
- **OCR** is a one-shot action in Mistral's API (`POST /v1/ocr`), not something that can be listed, so it does not appear here.
- **Fine-tuning is legacy.** Mistral has deprecated its fine-tuning API. Existing jobs and fine-tuned models stay visible and manageable here, but you cannot start new jobs.
- **You only see agents your key is allowed to see**, based on each agent's sharing settings.
