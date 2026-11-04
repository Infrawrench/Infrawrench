---
title: ElevenLabs
description: Manage ElevenLabs voices, ElevenAgents agents, phone numbers, knowledge base documents, pronunciation dictionaries and generation history, and run text-to-speech and Scribe transcription from the Speech tab.
sidebar_order: 42
---

Connect ElevenLabs to manage your voices, agents and dictionaries, test speech in both directions, and see what you spend.

## What you can manage

- **Voices**: premade, cloned, professional and generated voices, with accent, gender, age, use case and a preview clip. Rename a voice, change its description, or delete it.
- **Models**: the speech models your workspace can use, each with its maximum text length per request, language count, and whether it supports voice conversion, style and speaker boost. Read-only.
- **Agents**: your ElevenAgents conversational agents, with their system prompt, first message, language, voice, voice model and LLM, the phone numbers they answer, and a table of their most recent conversations. Create, edit and delete them (see [Build agents](#build-agents)).
- **Phone numbers**: the Twilio, SIP trunk and Exotel numbers imported into ElevenAgents, with the agent each one is assigned to. Edit the label, or delete the number.
- **Knowledge base documents**: the files, URLs, text snippets and folders your agents draw on, with their size and how many agents use each one. You can delete them.
- **Pronunciation dictionaries**: the phoneme and alias rules applied during synthesis, with their latest version id. Create one from a list of rules, rename it, or delete it.
- **History items**: clips you've generated, with the text, the voice, the model and the exact character count you were billed. You can delete them.

Every resource's dashboard card leads with your subscription's **character quota gauge**.

## Connect your account

There's one field. In the ElevenLabs dashboard, open the profile menu (bottom-left avatar) > **API Keys** > **Create API Key**, or go to [elevenlabs.io/app/settings/api-keys](https://elevenlabs.io/app/settings/api-keys).

Give the key these permissions:

- Read access to **Voices**, **Models**, **History** and **User** (User powers the quota gauge and your billing currency).
- **Text to Speech** and **Speech to Text** if you want the Speech tab.
- **ElevenAgents** read (and write, to create or edit agents and phone numbers).
- **Pronunciation Dictionaries** write to create or rename dictionaries.
- **Workspace / usage** read if you want cost graphs.

Workspace keys and personal keys both work.

![ElevenLabs Add-account form with the API key field and its scope guidance](https://agent-assets.infrawrench.com/docs-screenshots/plugins/elevenlabs/add-account.png)

## Test speech

Open a voice and go to the **Speech** tab. It lets you synthesize speech and transcribe audio. See [Speech testing](../features/speech-testing.md) for how the panel works in general.

- **Synthesize** returns mp3. The voice picker lists your whole workspace, and the voice you opened is already selected. The character limit follows the **selected model's own** limit (`eleven_multilingual_v2` allows 10,000, others differ), so the counter under the box is the real limit for what you picked.
- **Transcribe** uses ElevenLabs **Scribe**: `scribe_v2` (current), `scribe_v2_medical` (tuned for clinical audio) or `scribe_v1` (deprecated, and labelled that way).

One model picker covers both. If a Scribe model is selected when you press Synthesize, the default text-to-speech model is used instead.

![ElevenLabs Speech tab on a voice, showing the character quota in the subtitle and a synthesized clip in the player](https://agent-assets.infrawrench.com/docs-screenshots/plugins/elevenlabs/speech-tab-voice.png)

## Build agents

**Create** an agent from the account's create menu. Every choice is a picker filled from your workspace: the **voice** from your voices, the **voice model** from the text-to-speech models you can use, and the **LLM** from the models ElevenAgents offers your workspace (already filtered for your data residency and compliance settings, without deprecated models). Leave any of these unset to use the ElevenAgents default. Then add the language, first message, system prompt and tags.

**Edit** changes the name, language, first message, system prompt and tags. Only what you change is sent, so anything you set up in the ElevenLabs dashboard (tools, knowledge base, evaluation criteria, widget settings) is left alone. The voice, voice model and LLM are set when you create the agent. To change them later, use the ElevenLabs dashboard.

Each agent has a **Metrics** tab built from its conversation history: conversations per day, how many were judged successful, average call duration and total talk time. The dashboard card shows the last seven days at a glance, including the success rate and how many conversations are live right now. Charts read up to 2,000 conversations per range, newest first, so a very busy agent over a long range shows its most recent days in full.

<insert [ElevenLabs agent detail page showing the voice and model section, the system prompt and the recent conversations table] here>

## Voice and model usage

Voices and models each have a **Metrics** tab charting their daily usage over the last 30 days. Every number ElevenLabs reports (credits and spend among them) gets its own chart. This needs the same **Workspace / usage** read access as cost graphs. If the tab is empty on a voice you've used, the key probably doesn't have it.

## Cost graphs

ElevenLabs accounts feed [cost graphs and budgets](../features/cloud-costs.md) with real money, not an estimate from the credit meter. Spend is shown daily, broken down by **product type** (text to speech, speech to text and so on) and by **region**. A year of history is available, and recent days keep updating because usage charges settle a day or two late.

Each charge shows the credits behind it, so you see a service's cost next to the usage that produced it.

![Cost graph for an ElevenLabs account broken down by product type, with text to speech as the largest series](https://agent-assets.infrawrench.com/docs-screenshots/plugins/elevenlabs/cost-graph.png)

- **Your billing currency is read from ElevenLabs.** Workspaces are billed in USD, EUR, INR or PLN, and Infrawrench uses whichever your account reports. USD is only used when the account doesn't state a currency at all.
- **The region breakdown can be missing.** If your key can't use ElevenLabs' newer usage reporting, costs are still broken down by product type, but not by region.
- **A narrowly scoped personal key still works,** but only shows its own usage, not the whole workspace's. Use a workspace key, or give the key workspace usage access, for account-wide numbers.

## Tips and limits

- **This spends real quota.** Synthesis counts against your character allowance and transcription is billed per minute of audio. The tab's subtitle shows characters used against your limit for the current period, so you can watch it move.
- **Transcription uploads are capped at 25 MB** here, even though ElevenLabs accepts up to 5 GB. Larger files are rejected before upload.
- **Preset and premade voices belong to ElevenLabs.** You can only delete voices your workspace owns.
- **Pronunciation dictionaries are created from rules, one per line.** Write each as `text = replacement`. Pick **Alias** to swap in another spelling, or **Phoneme** to give an exact pronunciation in IPA or CMU Arpabet. Edit the rules of an existing dictionary in the ElevenLabs dashboard. Here you can rename it. The dictionary id and latest version id are outputs, so you can use them in your own calls.
- **Deleting a pronunciation dictionary archives it.** ElevenLabs has no hard delete for dictionaries, so it's archived and hidden from the list.
- **A knowledge base document an agent still uses can't be deleted.** Detach it from those agents first. The count of agents using it is on the document's card.
- **History is where you'll find character usage.** Each item records exactly what it was billed, which is usually quicker than checking against the quota gauge.
