---
title: "Kubernetes Job failed: debug BackoffLimitExceeded, deadlines and CronJobs"
description: "Find out why a Kubernetes Job or CronJob failed, read the logs of the pods that died, and fix backoffLimit, activeDeadlineSeconds and schedule problems."
date: "2026-11-01"
kind: guide
---

A Job that fails does not crash loop forever like a Deployment. It retries a set number of times, gives up, and leaves a Failed condition behind. A CronJob adds another layer: the Job may never have been created at all. This guide walks through a read-only routine for both: read the Job's conditions, find and read the pods that failed, match the reason to the cause, and then check the CronJob settings that decide whether a run starts in the first place.

Prerequisites: kubectl installed, access to the cluster, and permission to read Jobs, CronJobs, pods, events and pod logs. Everything here follows the official [Kubernetes Jobs documentation](https://kubernetes.io/docs/concepts/workloads/controllers/job/). Placeholders used throughout: CONTEXT_NAME, NAMESPACE, JOB_NAME, CRONJOB_NAME and POD_NAME. Replace them before running a command. For the broader routine, see the [Kubernetes troubleshooting guide for pods, logs and events](/blog/kubernetes-troubleshooting-pods-logs-and-events).

## How a Job decides it has failed

A Job's pod template only allows `restartPolicy: Never` or `restartPolicy: OnFailure`. The two behave differently when something goes wrong:

- **Never**: when a container fails, the whole pod fails, and the Job controller creates a new pod. Failed pods stay around, so you can read their logs.
- **OnFailure**: the pod stays on the node and the kubelet re-runs the failing container inside it.

Either way, failures count towards `.spec.backoffLimit`, which defaults to 6. The Job controller recreates failed pods with an exponential back-off delay of 10 seconds, 20 seconds, 40 seconds and so on, capped at ten minutes. Once the count reaches the limit, the Job is marked Failed and any pods still running are terminated.

A Job can also fail on time. `.spec.activeDeadlineSeconds` caps how long the whole Job may run, no matter how many pods it creates. It takes precedence over `backoffLimit`: once the deadline passes, the Job stops creating pods even if it has retries left, and fails with reason `DeadlineExceeded`.

Neither failure is retried automatically. A Job with a Failed condition stays failed until someone fixes the cause and runs it again.

## Step 1: Read the Job's status and conditions

Check you are pointed at the right cluster and namespace, then list the Jobs:

```
kubectl config current-context
kubectl --context CONTEXT_NAME get jobs -n NAMESPACE
```

Look at the STATUS, COMPLETIONS and DURATION columns. Then describe the Job you care about:

```
kubectl --context CONTEXT_NAME describe job JOB_NAME -n NAMESPACE
```

Read Pods Statuses (how many are active, succeeded and failed), the limits in the spec, and the events at the bottom. To pull only the conditions:

```
kubectl --context CONTEXT_NAME get job JOB_NAME -n NAMESPACE -o jsonpath='{range .status.conditions[*]}{.type}{"\t"}{.reason}{"\t"}{.message}{"\n"}{end}'
```

The reason tells you which rule ended the Job:

- **BackoffLimitExceeded**: the pods failed more times than `backoffLimit` allows. The cause is inside the pods; go to Step 2.
- **DeadlineExceeded**: the Job ran past `activeDeadlineSeconds`. Go to Step 4.
- **PodFailurePolicy**: a failed pod matched a pod failure policy rule with the `FailJob` action. The message names the container and exit code that matched.
- **FailedIndexes** or **MaxFailedIndexesExceeded**: an Indexed Job using `backoffLimitPerIndex` has indexes that failed.

You may also see a FailureTarget condition before the Failed one. The controller adds it when it decides the Job has failed, then waits for the remaining pods to terminate before adding the final Failed condition.

## Step 2: Find the pods the Job created

Pods created by a Job carry the `batch.kubernetes.io/job-name` label, so you can list them all, including the failed ones:

```
kubectl --context CONTEXT_NAME get pods -n NAMESPACE --selector=batch.kubernetes.io/job-name=JOB_NAME
```

With `restartPolicy: Never`, expect several pods in Error status, one per attempt. With `restartPolicy: OnFailure`, expect one pod with a high RESTARTS count, or no pod at all.

That last case is the trap with OnFailure. When the Job hits its backoff limit, the pod running it is terminated, and the evidence goes with it. The Kubernetes documentation recommends `restartPolicy: Never` while debugging a Job, or a logging system that keeps output from failed runs.

If the pod list is empty for a Job that was supposed to run, check whether the pods ever got scheduled. A pod stuck in Pending counts against `activeDeadlineSeconds` but never runs your code; the [Pending pods guide](/blog/kubernetes-pod-pending) covers that case.

## Step 3: Read the logs of the failed attempts

Read the logs of each failed pod, starting with the most recent:

```
kubectl --context CONTEXT_NAME logs POD_NAME -n NAMESPACE
```

For an OnFailure pod that is still around, the failed attempt is the previous container instance:

```
kubectl --context CONTEXT_NAME logs POD_NAME -n NAMESPACE --previous
```

Then read how each attempt ended:

```
kubectl --context CONTEXT_NAME get pods -n NAMESPACE --selector=batch.kubernetes.io/job-name=JOB_NAME -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.status.containerStatuses[0].state.terminated.reason}{"\t"}{.status.containerStatuses[0].state.terminated.exitCode}{"\n"}{end}'
```

Compare the attempts. The same exit code and the same last log line every time means a deterministic bug or bad configuration, and retrying will never help. Different errors across attempts point at something outside the pod: a flaky dependency, a node problem or resource pressure.

Exit codes read the same way as for any container. A small non-zero code is the application reporting an error. 126 and 127 point at the command or entrypoint. 137 with reason OOMKilled means the container hit its memory limit; the [OOMKilled guide](/blog/kubernetes-oomkilled) covers that. The [CrashLoopBackOff guide](/blog/kubernetes-crashloopbackoff) has the full exit code walkthrough.

Treat log output as sensitive. Batch jobs often print connection strings, tokens and customer records. Redact before pasting into a ticket, a chat thread or an AI assistant.

## Step 4: Fix the cause, not just the limits

Match what you found to the cause:

**The task fails every time.** Same error on every attempt. Fix the command, image, configuration or data, then run the Job again. Raising `backoffLimit` only makes it fail more slowly.

**The task fails sometimes.** A dependency that times out, a network blip, a node going away. Retries are what `backoffLimit` is for; raise it if the default of 6 is not enough, and make the task safe to run more than once. The Job documentation warns that the same program may be started twice even with one completion and `restartPolicy: Never`, and that a new pod has to cope with temporary files, locks and partial output left by earlier attempts.

**DeadlineExceeded.** Compare DURATION with `activeDeadlineSeconds`. If the task legitimately needs longer, raise the deadline. If it is slower than it used to be, look at the input size, the pod's resource requests and limits, and whether pods spent time in Pending. Note that both the Job spec and the pod template have an `activeDeadlineSeconds` field; make sure you change the one you meant.

**Disruptions eating your retries.** A preemption or node drain counts as a pod failure by default. A [pod failure policy](https://kubernetes.io/docs/concepts/workloads/controllers/job/#pod-failure-policy) can ignore failures with the `DisruptionTarget` condition, so they do not count towards `backoffLimit`, and can fail the Job immediately on an exit code you know means "do not retry". Pod failure policies require `restartPolicy: Never`.

A failed Job does not restart itself, and you cannot simply edit it back to life. Delete it and create it again from the corrected manifest:

```
kubectl --context CONTEXT_NAME delete job JOB_NAME -n NAMESPACE
kubectl --context CONTEXT_NAME apply -f job.yaml
```

Deleting a Job with kubectl deletes the pods it created, and their logs with them. Save what you need first.

## Step 5: When a CronJob does not run, or runs too often

A CronJob only creates Jobs; the Jobs manage the pods. So first decide which layer failed. List the CronJob and the Jobs it created:

```
kubectl --context CONTEXT_NAME get cronjob CRONJOB_NAME -n NAMESPACE
kubectl --context CONTEXT_NAME get jobs -n NAMESPACE
kubectl --context CONTEXT_NAME describe cronjob CRONJOB_NAME -n NAMESPACE
```

LAST SCHEDULE tells you when it last created a Job. If a Job was created and failed, go back to Step 1 with that Job's name. If no Job was created, check these settings:

**The schedule and time zone.** `.spec.schedule` uses five-field cron syntax: minute, hour, day of month, month, day of week. `0 3 * * 1` is 3 AM every Monday. Without `.spec.timeZone`, the schedule is read in the local time zone of the kube-controller-manager, which may not be yours. Set `timeZone`, for example `Etc/UTC`. `CRON_TZ` or `TZ` inside the schedule is not supported and is rejected by validation.

**Suspended.** If `.spec.suspend` is true, the CronJob creates no new Jobs. Runs skipped while suspended count as missed. When you unsuspend a CronJob that has no starting deadline, the missed Jobs are scheduled immediately, which can surprise you.

**Starting deadline.** `.spec.startingDeadlineSeconds` is how late a run may start. Past it, that run is skipped and counted as failed. Values under 10 seconds can stop the CronJob from scheduling at all, because the controller checks every 10 seconds.

**Too many missed schedules.** If the controller finds more than 100 missed schedules since the last run, it does not start the Job and logs "too many missed start times. Set or decrease .spec.startingDeadlineSeconds or check clock skew". This happens after a long controller outage with a frequent schedule. Setting `startingDeadlineSeconds` limits how far back the controller counts.

**Concurrency policy.** With the default `Allow`, a slow run and the next run overlap. With `Forbid`, a new run is skipped while the previous one is still going, so a long-running Job silently eats schedules. With `Replace`, the running Job is replaced by the new one, so a task that always takes longer than its interval never finishes.

CronJob scheduling is approximate. The documentation says that in some circumstances two Jobs may be created for one schedule, or none. Make scheduled tasks idempotent.

To test the job template without waiting for the schedule, create a one-off Job from the CronJob:

```
kubectl --context CONTEXT_NAME create job CRONJOB_NAME-manual -n NAMESPACE --from=cronjob/CRONJOB_NAME
```

This creates a real Job that runs real work, so treat it as a change and follow your team's rules for that namespace.

## Step 6: Keep the evidence long enough to read it

Two settings can delete a failed Job before anyone looks at it:

- **`failedJobsHistoryLimit`** on a CronJob keeps only 1 failed Job by default, and `successfulJobsHistoryLimit` keeps 3. Older Jobs and their pods are removed.
- **`ttlSecondsAfterFinished`** on a Job deletes it, and its pods, that many seconds after it finishes. Set to 0, the Job is eligible for deletion as soon as it completes or fails.

If failed Jobs keep vanishing before you can debug them, raise `failedJobsHistoryLimit` or the TTL, or ship logs somewhere that outlives the pod. The documentation still recommends setting a TTL on Jobs you create directly, because pods from a deleted unmanaged Job can linger.

## Step 7: Verify the fix

Run the corrected Job, or trigger the CronJob manually as in Step 5, and wait for it:

```
kubectl --context CONTEXT_NAME wait --for=condition=complete job/JOB_NAME -n NAMESPACE --timeout=600s
kubectl --context CONTEXT_NAME get job JOB_NAME -n NAMESPACE
```

Confirm COMPLETIONS reaches the expected count, the failed pod count is zero or within what you expect for a flaky dependency, and the logs show the task actually did its work. For a CronJob, check LAST SCHEDULE again after the next scheduled time to confirm the schedule fires on its own.

Write down the reason, the exit code, the log line and the change that fixed it.

## Conclusion

A failed Job always leaves a reason: retries used up, time run out, or a policy rule matched. Read the condition, read the pods that failed before they are cleaned up, and fix the cause rather than raising the limits. For CronJobs, check whether the Job was ever created before debugging what it did.

If you switch between clusters, cloud consoles and terminals to chase problems like this, Infrawrench brings Kubernetes exec and logs, SSH and the rest of your infrastructure into one workspace. [Download the free desktop app](/) for macOS, Windows or Linux, no account required.

## References

- [Jobs](https://kubernetes.io/docs/concepts/workloads/controllers/job/)
- [CronJob](https://kubernetes.io/docs/concepts/workloads/controllers/cron-jobs/)
- [Automatic cleanup for finished Jobs](https://kubernetes.io/docs/concepts/workloads/controllers/ttlafterfinished/)
- [Running automated tasks with a CronJob](https://kubernetes.io/docs/tasks/job/automated-tasks-with-cron-jobs/)
- [Pod lifecycle: container restart policy](https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/)
- [kubectl create job reference](https://kubernetes.io/docs/reference/kubectl/generated/kubectl_create/kubectl_create_job/)
