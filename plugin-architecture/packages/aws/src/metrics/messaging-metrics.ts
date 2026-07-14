import type { MetricSeries, ResourceInstance } from "@infrawrench/plugin-base";
import type { MetricsContext } from "./cw-helpers.js";

/**
 * Messaging / streaming metric handlers — SQS, SNS, Kinesis, MSK, MQ,
 * Step Functions, EventBridge.
 */

export async function sqsQueueMetrics(
  ctx: MetricsContext,
  resource: ResourceInstance,
): Promise<MetricSeries[]> {
  // Verified against
  // https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-available-cloudwatch-metrics.html
  // SQS dimension is the queue NAME (last segment of the queue URL), not ARN.
  // For DLQs `ApproximateNumberOfMessagesVisible` is the canonical "backlog"
  // signal — `NumberOfMessagesSent` doesn't count auto-redriven messages.
  const f = resource.fields;
  const queueUrl = String(f.queueUrl ?? "");
  const queueName = String(f.queueName ?? queueUrl.split("/").pop() ?? "");
  if (!queueName) return [];
  const dims = [{ Name: "QueueName", Value: queueName }];
  const [visible, notVisible, delayed, age, sent, received, deleted, emptyReceives, msgSize] =
    await Promise.all([
      ctx.fetchCw("AWS/SQS", "ApproximateNumberOfMessagesVisible", dims).catch(() => null),
      ctx.fetchCw("AWS/SQS", "ApproximateNumberOfMessagesNotVisible", dims).catch(() => null),
      ctx.fetchCw("AWS/SQS", "ApproximateNumberOfMessagesDelayed", dims).catch(() => null),
      ctx.fetchCw("AWS/SQS", "ApproximateAgeOfOldestMessage", dims).catch(() => null),
      ctx.fetchCw("AWS/SQS", "NumberOfMessagesSent", dims, "Sum").catch(() => null),
      ctx.fetchCw("AWS/SQS", "NumberOfMessagesReceived", dims, "Sum").catch(() => null),
      ctx.fetchCw("AWS/SQS", "NumberOfMessagesDeleted", dims, "Sum").catch(() => null),
      ctx.fetchCw("AWS/SQS", "NumberOfEmptyReceives", dims, "Sum").catch(() => null),
      ctx.fetchCw("AWS/SQS", "SentMessageSize", dims).catch(() => null),
    ]);
  const results: MetricSeries[] = [];
  if (visible && visible.points.length > 0) results.push({ ...visible, label: "Messages Visible" });
  if (notVisible && notVisible.points.length > 0)
    results.push({ ...notVisible, label: "In-flight Messages" });
  if (delayed && delayed.points.length > 0) results.push({ ...delayed, label: "Delayed Messages" });
  if (age && age.points.length > 0)
    results.push({ ...age, label: "Age of Oldest Message", unit: "s" });
  if (sent && sent.points.length > 0) results.push({ ...sent, label: "Messages Sent" });
  if (received && received.points.length > 0)
    results.push({ ...received, label: "Messages Received" });
  if (deleted && deleted.points.length > 0) results.push({ ...deleted, label: "Messages Deleted" });
  if (emptyReceives && emptyReceives.points.length > 0)
    results.push({ ...emptyReceives, label: "Empty Receives" });
  if (msgSize && msgSize.points.length > 0)
    results.push({ ...msgSize, label: "Sent Message Size", unit: "bytes" });
  return results;
}

export async function snsTopicMetrics(
  ctx: MetricsContext,
  resource: ResourceInstance,
): Promise<MetricSeries[]> {
  // Verified against
  // https://docs.aws.amazon.com/sns/latest/dg/sns-monitoring-using-cloudwatch.html
  // SNS dimension is TopicName (last segment of ARN).
  const arn = String(resource.resolvedOutputs?.["topicArn"] ?? resource.externalId ?? "");
  const topicName = arn.split(":").pop() ?? "";
  if (!topicName) return [];
  const dims = [{ Name: "TopicName", Value: topicName }];
  const [published, delivered, failed, filteredOut, redrivenDlq, publishSize] = await Promise.all([
    ctx.fetchCw("AWS/SNS", "NumberOfMessagesPublished", dims, "Sum").catch(() => null),
    ctx.fetchCw("AWS/SNS", "NumberOfNotificationsDelivered", dims, "Sum").catch(() => null),
    ctx.fetchCw("AWS/SNS", "NumberOfNotificationsFailed", dims, "Sum").catch(() => null),
    ctx.fetchCw("AWS/SNS", "NumberOfNotificationsFilteredOut", dims, "Sum").catch(() => null),
    ctx.fetchCw("AWS/SNS", "NumberOfNotificationsRedrivenToDlq", dims, "Sum").catch(() => null),
    ctx.fetchCw("AWS/SNS", "PublishSize", dims).catch(() => null),
  ]);
  const results: MetricSeries[] = [];
  if (published && published.points.length > 0)
    results.push({ ...published, label: "Messages Published" });
  if (delivered && delivered.points.length > 0)
    results.push({ ...delivered, label: "Notifications Delivered" });
  if (failed && failed.points.length > 0)
    results.push({ ...failed, label: "Notifications Failed" });
  if (filteredOut && filteredOut.points.length > 0)
    results.push({ ...filteredOut, label: "Filtered Out" });
  if (redrivenDlq && redrivenDlq.points.length > 0)
    results.push({ ...redrivenDlq, label: "Redriven to DLQ" });
  if (publishSize && publishSize.points.length > 0)
    results.push({ ...publishSize, label: "Publish Size", unit: "bytes" });
  return results;
}

export async function kinesisStreamMetrics(
  ctx: MetricsContext,
  resource: ResourceInstance,
): Promise<MetricSeries[]> {
  // Verified against
  // https://docs.aws.amazon.com/streams/latest/dev/monitoring-with-cloudwatch.html
  // IteratorAgeMilliseconds is the docs-recommended #1 metric to watch
  // for stream consumer health — alert above 50% of retention period.
  const f = resource.fields;
  const streamName = String(f.streamName ?? resource.externalId ?? "");
  if (!streamName) return [];
  const dims = [{ Name: "StreamName", Value: streamName }];
  const [
    incomingBytes,
    incomingRecords,
    getBytes,
    getRecords,
    putBytes,
    putSuccess,
    putRecordsSucc,
    putRecordsFail,
    iteratorAge,
    writeThrottle,
    readThrottle,
  ] = await Promise.all([
    ctx.fetchCw("AWS/Kinesis", "IncomingBytes", dims, "Sum").catch(() => null),
    ctx.fetchCw("AWS/Kinesis", "IncomingRecords", dims, "Sum").catch(() => null),
    ctx.fetchCw("AWS/Kinesis", "GetRecords.Bytes", dims, "Sum").catch(() => null),
    ctx.fetchCw("AWS/Kinesis", "GetRecords.Records", dims, "Sum").catch(() => null),
    ctx.fetchCw("AWS/Kinesis", "PutRecord.Bytes", dims, "Sum").catch(() => null),
    ctx.fetchCw("AWS/Kinesis", "PutRecord.Success", dims).catch(() => null),
    ctx.fetchCw("AWS/Kinesis", "PutRecords.SuccessfulRecords", dims, "Sum").catch(() => null),
    ctx.fetchCw("AWS/Kinesis", "PutRecords.FailedRecords", dims, "Sum").catch(() => null),
    ctx
      .fetchCw("AWS/Kinesis", "GetRecords.IteratorAgeMilliseconds", dims, "Maximum")
      .catch(() => null),
    ctx.fetchCw("AWS/Kinesis", "WriteProvisionedThroughputExceeded", dims, "Sum").catch(() => null),
    ctx.fetchCw("AWS/Kinesis", "ReadProvisionedThroughputExceeded", dims, "Sum").catch(() => null),
  ]);
  const results: MetricSeries[] = [];
  if (incomingBytes && incomingBytes.points.length > 0)
    results.push({ ...incomingBytes, label: "Incoming Bytes", unit: "bytes" });
  if (incomingRecords && incomingRecords.points.length > 0)
    results.push({ ...incomingRecords, label: "Incoming Records" });
  if (getBytes && getBytes.points.length > 0)
    results.push({ ...getBytes, label: "GetRecords Bytes", unit: "bytes" });
  if (getRecords && getRecords.points.length > 0)
    results.push({ ...getRecords, label: "GetRecords (count)" });
  if (putBytes && putBytes.points.length > 0)
    results.push({ ...putBytes, label: "PutRecord Bytes", unit: "bytes" });
  if (putSuccess && putSuccess.points.length > 0)
    results.push({ ...putSuccess, label: "PutRecord Success Rate" });
  if (putRecordsSucc && putRecordsSucc.points.length > 0)
    results.push({ ...putRecordsSucc, label: "PutRecords Successful" });
  if (putRecordsFail && putRecordsFail.points.length > 0)
    results.push({ ...putRecordsFail, label: "PutRecords Failed" });
  if (iteratorAge && iteratorAge.points.length > 0)
    results.push({ ...iteratorAge, label: "Iterator Age", unit: "ms" });
  if (writeThrottle && writeThrottle.points.length > 0)
    results.push({ ...writeThrottle, label: "Write Throttles" });
  if (readThrottle && readThrottle.points.length > 0)
    results.push({ ...readThrottle, label: "Read Throttles" });
  return results;
}

export async function mskClusterMetrics(
  ctx: MetricsContext,
  resource: ResourceInstance,
): Promise<MetricSeries[]> {
  // Kafka dimension is "Cluster Name" (with the space).
  const f = resource.fields;
  const clusterName = String(f.clusterName ?? "");
  if (!clusterName) return [];
  const dims = [{ Name: "Cluster Name", Value: clusterName }];
  const [cpuUser, memUsed, diskUsed, activeConns] = await Promise.all([
    ctx.fetchCw("AWS/Kafka", "CpuUser", dims).catch(() => null),
    ctx.fetchCw("AWS/Kafka", "MemoryUsed", dims).catch(() => null),
    ctx.fetchCw("AWS/Kafka", "KafkaDataLogsDiskUsed", dims).catch(() => null),
    ctx.fetchCw("AWS/Kafka", "ActiveControllerCount", dims, "Sum").catch(() => null),
  ]);
  const results: MetricSeries[] = [];
  if (cpuUser && cpuUser.points.length > 0)
    results.push({ ...cpuUser, label: "CPU (User)", unit: "%" });
  if (memUsed && memUsed.points.length > 0)
    results.push({ ...memUsed, label: "Memory Used", unit: "bytes" });
  if (diskUsed && diskUsed.points.length > 0)
    results.push({ ...diskUsed, label: "Data Log Disk Used", unit: "%" });
  if (activeConns && activeConns.points.length > 0)
    results.push({ ...activeConns, label: "Active Controllers" });
  return results;
}

export async function mqBrokerMetrics(
  ctx: MetricsContext,
  resource: ResourceInstance,
): Promise<MetricSeries[]> {
  // MQ dimension is the broker name; the externalId is the broker id, so prefer field.
  const f = resource.fields;
  const brokerName = String(f.brokerName ?? "");
  if (!brokerName) return [];
  const dims = [{ Name: "Broker", Value: brokerName }];
  const [cpu, conns, heap] = await Promise.all([
    ctx.fetchCw("AWS/AmazonMQ", "CpuUtilization", dims).catch(() => null),
    ctx.fetchCw("AWS/AmazonMQ", "CurrentConnectionsCount", dims).catch(() => null),
    ctx.fetchCw("AWS/AmazonMQ", "HeapUsage", dims).catch(() => null),
  ]);
  const results: MetricSeries[] = [];
  if (cpu && cpu.points.length > 0) results.push({ ...cpu, label: "CPU Utilization", unit: "%" });
  if (conns && conns.points.length > 0) results.push({ ...conns, label: "Connections" });
  if (heap && heap.points.length > 0) results.push({ ...heap, label: "Heap Usage", unit: "%" });
  return results;
}

export async function stepFunctionMetrics(
  ctx: MetricsContext,
  resource: ResourceInstance,
): Promise<MetricSeries[]> {
  // States dimension is the full state machine ARN; externalId is the ARN.
  // AWS Step Functions docs (https://docs.aws.amazon.com/step-functions/latest/dg/procedure-cw-metrics.html)
  // recommend `ExecutionsStarted` + `ExecutionsTimedOut` as the baseline.
  const smArn = String(resource.resolvedOutputs?.["stateMachineArn"] ?? resource.externalId ?? "");
  if (!smArn) return [];
  const dims = [{ Name: "StateMachineArn", Value: smArn }];
  const [started, succeeded, failed, timedOut, throttled, aborted, time] = await Promise.all([
    ctx.fetchCw("AWS/States", "ExecutionsStarted", dims, "Sum").catch(() => null),
    ctx.fetchCw("AWS/States", "ExecutionsSucceeded", dims, "Sum").catch(() => null),
    ctx.fetchCw("AWS/States", "ExecutionsFailed", dims, "Sum").catch(() => null),
    ctx.fetchCw("AWS/States", "ExecutionsTimedOut", dims, "Sum").catch(() => null),
    ctx.fetchCw("AWS/States", "ExecutionThrottled", dims, "Sum").catch(() => null),
    ctx.fetchCw("AWS/States", "ExecutionsAborted", dims, "Sum").catch(() => null),
    ctx.fetchCw("AWS/States", "ExecutionTime", dims).catch(() => null),
  ]);
  const results: MetricSeries[] = [];
  if (started && started.points.length > 0)
    results.push({ ...started, label: "Executions Started" });
  if (succeeded && succeeded.points.length > 0)
    results.push({ ...succeeded, label: "Executions Succeeded" });
  if (failed && failed.points.length > 0) results.push({ ...failed, label: "Executions Failed" });
  if (timedOut && timedOut.points.length > 0)
    results.push({ ...timedOut, label: "Executions Timed Out" });
  if (aborted && aborted.points.length > 0)
    results.push({ ...aborted, label: "Executions Aborted" });
  if (throttled && throttled.points.length > 0) results.push({ ...throttled, label: "Throttled" });
  if (time && time.points.length > 0)
    results.push({ ...time, label: "Execution Time", unit: "ms" });
  return results;
}

export async function eventBridgeRuleMetrics(
  ctx: MetricsContext,
  resource: ResourceInstance,
): Promise<MetricSeries[]> {
  // Verified against
  // https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-monitoring.html
  // AWS/Events dimension is RuleName; rules on a custom bus publish with an
  // additional EventBusName dimension, and CloudWatch matches dimension sets
  // exactly, so include it only for non-default buses.
  const f = resource.fields;
  const ruleName = String(f.name ?? resource.externalId ?? "");
  if (!ruleName) return [];
  const eventBusName = String(f.eventBusName ?? "");
  const dims = [{ Name: "RuleName", Value: ruleName }];
  if (eventBusName && eventBusName !== "default") {
    dims.push({ Name: "EventBusName", Value: eventBusName });
  }
  const [triggered, invocations, failed, throttled, sentToDlq, dlqFailed] = await Promise.all([
    ctx.fetchCw("AWS/Events", "TriggeredRules", dims, "Sum").catch(() => null),
    ctx.fetchCw("AWS/Events", "Invocations", dims, "Sum").catch(() => null),
    ctx.fetchCw("AWS/Events", "FailedInvocations", dims, "Sum").catch(() => null),
    ctx.fetchCw("AWS/Events", "ThrottledRules", dims, "Sum").catch(() => null),
    ctx.fetchCw("AWS/Events", "InvocationsSentToDlq", dims, "Sum").catch(() => null),
    ctx.fetchCw("AWS/Events", "InvocationsFailedToBeSentToDlq", dims, "Sum").catch(() => null),
  ]);
  const results: MetricSeries[] = [];
  if (triggered && triggered.points.length > 0)
    results.push({ ...triggered, label: "Rule Triggered" });
  if (invocations && invocations.points.length > 0)
    results.push({ ...invocations, label: "Target Invocations" });
  if (failed && failed.points.length > 0) results.push({ ...failed, label: "Failed Invocations" });
  if (throttled && throttled.points.length > 0) results.push({ ...throttled, label: "Throttled" });
  if (sentToDlq && sentToDlq.points.length > 0)
    results.push({ ...sentToDlq, label: "Sent to DLQ" });
  if (dlqFailed && dlqFailed.points.length > 0)
    results.push({ ...dlqFailed, label: "DLQ Delivery Failed" });
  return results;
}
