---
title: ElevenLabs
description: Manage ElevenLabs voices, ElevenAgents agents, phone numbers, knowledge base documents, pronunciation dictionaries and generation history, and run text-to-speech and Scribe transcription from the Speech tab.
sidebar_order: 42
---

## What you can manage

- **Voices**: premade, cloned, professional and generated voices, with accent, gender, age, use case and a preview clip. Rename a voice or change its description, or delete it.
- **Models**: the speech models this workspace can call, each with its real `maximum_text_length_per_request`, language count, and whether it supports voice conversion, style and speaker boost. Read-only.
- **Agents**: your ElevenAgents conversational agents, with their system prompt, first message, language, voice, voice model and LLM, the phone numbers they answer, and a table of their most recent conversations. Create, edit and delete them (see [Agents](#agents)).
- **Phone numbers**: the Twilio, SIP trunk and Exotel numbers imported into ElevenAgents, with the agent each one is assigned to. Edit the label, or delete the number.
- **Knowledge base documents**: the files, URLs, text snippets and folders your agents draw on, with their size and how many agents depend on each (delete).
- **Pronunciation dictionaries**: the phoneme and alias rules applied at synthesis time, with their latest version id. Create one from a list of rules, rename it, or delete it.
- **History items**: previously generated clips, with the text, the voice, the model and the exact character count you were billed (delete).

Every resource's dashboard card leads with your subscription's **character quota gauge**, read from `GET /v1/user/subscription`.

## Credentials

One field. ElevenLabs dashboard → profile menu (bottom-left avatar) → **API Keys** → **Create API Key**, or [elevenlabs.io/app/settings/api-keys](https://elevenlabs.io/app/settings/api-keys). The key is sent as the `xi-api-key` header.

Scope it with read access to **Voices**, **Models**, **History** and **User** (the last one drives the quota gauge and reports your billing currency), plus **Text to Speech** and **Speech to Text** if you want the Speech tab, **ElevenAgents** read (and write, to create or edit agents and phone numbers), **Pronunciation Dictionaries** write to create or rename dictionaries, and **Workspace / usage** read if you want cost graphs. Workspace keys and personal keys both work.

![ElevenLabs Add-account form with the API key field and its scope guidance](https://agent-assets.infrawrench.com/docs-screenshots/plugins/elevenlabs/add-account.png)

## The Speech tab

Open a voice for a **Speech** tab with both halves. See [Speech testing](../features/speech-testing.md) for the panel in general.

- **Synthesize** posts to the text-to-speech endpoint and returns mp3. The voice picker carries your whole workspace roster, and opening a voice preselects it. The character cap tracks the **selected model's own** `maximum_text_length_per_request` rather than a hardcoded number — `eleven_multilingual_v2` allows 10,000, others differ — so the counter under the box is the real limit for what you picked.
- **Transcribe** runs ElevenLabs **Scribe**: `scribe_v2` (current), `scribe_v2_medical` (fine-tuned for clinical audio) or `scribe_v1` (deprecated, and labelled as such).

One shared model picker drives both halves. Leave a Scribe model selected and press Synthesize and the plugin falls back to the TTS default rather than sending a transcription model to the synthesis endpoint.

![ElevenLabs Speech tab on a voice, showing the character quota in the subtitle and a synthesized clip in the player](https://agent-assets.infrawrench.com/docs-screenshots/plugins/elevenlabs/speech-tab-voice.png)

## Agents

**Create** an agent from the account's create menu. Every choice is a picker filled from your workspace: the **voice** from your voice roster, the **voice model** from the text-to-speech models you can call, and the **LLM** from the models ElevenAgents offers your workspace (already filtered for your data residency and compliance settings, with deprecated models left out). Leave any of those unset to take the ElevenAgents default. Language, first message, system prompt and tags round it out.

**Edit** changes the name, language, first message, system prompt and tags. Only the settings you change are sent, so anything you have configured in the ElevenLabs dashboard (tools, knowledge base, evaluation criteria, widget settings) is left alone. The voice, voice model and LLM are chosen at create time; to change them on an existing agent, use the ElevenLabs dashboard.

Each agent has a **Metrics** tab built from its conversation history: conversations per day, how many of those were judged successful, average call duration and total talk time. The dashboard card shows the last seven days at a glance, including the success rate. Charts read at most 2,000 conversations per range, newest first, so a very busy agent over a long range shows its most recent days in full.

<insert [ElevenLabs agent detail page showing the voice and model section, the system prompt and the recent conversations table] here>

## Cost graphs

ElevenLabs accounts feed [cost graphs & budgets](../features/cloud-costs.md) with real money — not an estimate off the credit meter. Spend is collected daily from the workspace analytics API in daily buckets, broken down by **product type** (which becomes the service dimension — text to speech, speech to text, and so on) and by **region**. A year of history is available, and the trailing three days are re-fetched on each sync because usage-based charges settle a day or two late.

The credits behind each charge ride along on the row, so a service's cost and the consumption that produced it sit side by side.

![Cost graph for an ElevenLabs account broken down by product type, with text to speech as the largest series](https://agent-assets.infrawrench.com/docs-screenshots/plugins/elevenlabs/cost-graph.png)

- **Your billing currency is read, never assumed.** ElevenLabs bills workspaces in USD, EUR, INR or PLN, and the plugin takes the currency from the usage response itself, falling back to the one on `GET /v1/user/subscription`. USD is only ever used when the account refuses to state a currency at all.
- **The endpoint this uses is the replacement for a deprecated one.** ElevenLabs has deprecated the old character-stats usage endpoint in favour of the workspace analytics query, so the plugin asks the new one first and only drops back to the old one if the new one is unavailable to your key.
- **On that fallback path there is no region breakdown.** The deprecated endpoint can only break usage down one way at a time, and the service and region views are each a complete decomposition of the same total — adding them together would report every charge twice. Service is kept and region is left empty, so the totals stay honest.
- **A narrowly scoped personal key still works,** but reports only its own usage rather than the whole workspace's. Use a workspace key, or grant the key workspace usage access, for account-wide numbers.

## Tips & limits

- **This spends real quota.** Synthesis bills against your character allowance and transcription bills per minute of audio — the tab's subtitle shows characters used against your limit for the current period so you can watch it move.
- **Transcription uploads are capped at 25 MB** here. The API itself accepts up to 5 GB, but the Speech tab base64-encodes the clip through an ordinary JSON request, so the limit is set low enough that oversized files are rejected before they are encoded rather than after.
- **ElevenLabs returns synthesis audio as `application/octet-stream`** even though the bytes are mp3. The plugin relabels it so the browser's player will accept it.
- **Preset and premade voices belong to ElevenLabs.** Deleting works on voices your workspace owns.
- **Pronunciation dictionaries are created from rules, one per line.** Write each as `text = replacement`; pick **Alias** to swap in another spelling or **Phoneme** to give an exact pronunciation in IPA or CMU Arpabet. Editing the rules of an existing dictionary happens in the ElevenLabs dashboard; here you can rename it. The dictionary id plus latest version id are surfaced as outputs so you can reference them in your own calls.
- **Deleting a pronunciation dictionary archives it.** ElevenLabs has no hard delete for dictionaries, so the plugin archives it and hides archived dictionaries from the list.
- **A knowledge base document an agent still uses cannot be deleted.** ElevenLabs refuses the delete until no agent depends on it, so detach it from those agents first. The dependent-agent count is on the document's card.
- **History is where the character accounting lives.** Each item records exactly what it was billed, which is usually a faster answer than reconciling against the quota gauge.
