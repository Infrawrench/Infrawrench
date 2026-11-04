---
title: Send test messages
description: Publish a one-off message into a queue, topic, stream, or event bus straight from the resource detail page.
sidebar_order: 13
---

Send a single test message into a queue, topic, stream or event bus from its detail page. It goes through the same call your producers use, which makes it handy for:

- Smoke-testing a new consumer before you've wired up a producer.
- Reproducing a bug by replaying a known-bad payload.
- Checking that IAM/RBAC really lets the account you're using publish.

Supported resources: Cloudflare Queues, AWS SQS/SNS/Kinesis/EventBridge, GCP Pub/Sub and Cloud Tasks, Azure Service Bus and Event Hub, and Kafka topics.

![Cloudflare Queue detail page with the Publish tab active, JSON body editor populated, and a "Recent sends" entry below showing a successful push](https://agent-assets.infrawrench.com/docs-screenshots/features/send-test-message/cloudflare-queue-publish.png)

## Send a message

1. Open the resource's detail page.
2. Go to the publish tab (its name depends on the provider, see the table below).
3. Write the message body and fill in any extra fields.
4. Click **Send**.

If the body should be JSON, the editor checks that it's valid JSON. Otherwise it's sent as plain text. Errors from the provider (auth, throttling, a malformed payload) show up right under the form.

## Fields by provider

| Provider                    | Tab label   | Inputs beyond the body                                     |
| --------------------------- | ----------- | ---------------------------------------------------------- |
| Cloudflare Queue            | Publish     | Body format (JSON / text), delay seconds                   |
| AWS SQS                     | Send        | Delay seconds, Message Group Id (FIFO), message attributes |
| AWS SNS                     | Publish     | Subject, message attributes                                |
| AWS Kinesis                 | Put record  | Partition key                                              |
| AWS EventBridge             | Put event   | Source, detail-type, event bus name                        |
| GCP Pub/Sub topic           | Publish     | Ordering key, attributes                                   |
| GCP Cloud Tasks queue       | Create task | Target URL, HTTP method, headers                           |
| Azure Service Bus namespace | Send        | Queue or topic name, BrokerProperties                      |
| Azure Event Hub namespace   | Send        | Hub name, partition key                                    |
| Kafka topic                 | Produce     | Key, headers                                               |

## Recent sends

Every send, successful or not, appears in the **Recent sends** list under the form. Each entry shows the body, the time, and what the provider returned (a message id, sequence number or error message). The list clears when you close the tab.

## Limits

- **One message per click.** There's no batch or load-test mode.
- **Desktop app with cloud-synced accounts.** Publishing from a cloud-synced account on desktop isn't supported yet, and you'll see a "not supported yet" message. Accounts you added locally on desktop work fine.
- **EventBridge rules.** A rule routes events rather than publishing them, so the event goes onto the bus the rule lives on (`default` unless you change it). The rule's filter then decides whether it matches.
- **Azure namespaces need a target name.** Service Bus and Event Hub work at the namespace level, so type the queue, topic or hub you want to send to.
