---
title: "Kubernetes LoadBalancer stuck on EXTERNAL-IP pending: how to fix it"
description: "Fix a Kubernetes Service of type LoadBalancer whose EXTERNAL-IP stays pending by checking for a load balancer provider, loadBalancerClass, events, protocols and the deprecated loadBalancerIP field in order."
date: "2026-11-04"
kind: guide
---

You create a Service with `type: LoadBalancer`, run `kubectl get svc`, and the EXTERNAL-IP column says `<pending>`. A minute later it still does. Kubernetes itself never creates a load balancer: it asks something else to, and pending means that something has not answered yet, has refused, or does not exist. This guide works through the causes in order, from "nothing is listening" to "the provider rejected the request".

Prerequisites: kubectl installed, access to the cluster, and permission to read Services, events and pods. Everything here follows the official [Service](https://kubernetes.io/docs/concepts/services-networking/service/#loadbalancer) and [Create an External Load Balancer](https://kubernetes.io/docs/tasks/access-application-cluster/create-external-load-balancer/) documentation. Placeholders used throughout: CONTEXT_NAME, NAMESPACE and SERVICE_NAME. Replace them before running a command. If you are new to the overall routine, start with the [Kubernetes troubleshooting guide for pods, logs and events](/blog/kubernetes-troubleshooting-pods-logs-and-events).

## How a LoadBalancer Service gets its address

The official documentation describes the sequence like this:

1. **Kubernetes allocates a node port**, as if you had asked for `type: NodePort`, unless node port allocation is turned off.
2. **A load balancer controller notices the Service.** On a cloud cluster this is usually the service controller in the cloud-controller-manager.
3. **The controller creates the load balancer** at the provider. This happens asynchronously.
4. **The controller writes the address back** to the Service's `.status.loadBalancer` field. That field is what the EXTERNAL-IP column shows.

Pending means step 4 has not happened. The question is which earlier step stopped.

## Step 1: Read the Service and its events

Start with the Service itself:

```
kubectl --context CONTEXT_NAME describe service SERVICE_NAME -n NAMESPACE
```

When the address arrives, it appears next to `LoadBalancer Ingress`. While it is pending, that line is missing. Look at the Events section at the bottom:

- **No events at all** usually means no controller is handling the Service. Go to Step 2.
- **Events from a load balancer controller that report an error** mean a controller is trying and failing. The message names the reason, often a quota, a permission, an unsupported setting or an annotation the provider does not accept. Go to Step 4.
- **Events that show provisioning is under way** mean you may only need to wait. Cloud load balancers can take a few minutes to create.

Events expire after a while, so an old Service that shows nothing may simply have outlived them. Recreating it in a test namespace is a quick way to see fresh events.

## Step 2: Is there anything that provides load balancers?

The official task is blunt about this: your cluster must be running in a cloud or other environment that already supports configuring external load balancers, with the correct load balancer provider configured. If it is not, nothing ever fills in the address and the Service stays pending forever.

This is the most common cause on:

- **Local clusters** such as kind, minikube or k3d on a laptop.
- **Bare metal and self-managed VMs** without a load balancer implementation installed.
- **Self-managed clusters on a cloud** where the cloud-controller-manager was never deployed or was deployed without credentials.

Check whether a cloud-controller-manager or another load balancer controller is running. Where it runs depends on the distribution, but it is commonly in `kube-system`:

```
kubectl --context CONTEXT_NAME get pods -n kube-system
```

On a managed cluster from a cloud provider, the controller is part of the managed control plane and you will not see it as a pod. There, skip to Step 3.

If there is no provider at all, you have three choices: install a load balancer implementation that suits your environment, expose the Service as `type: NodePort` and reach it on a node's IP and port, or put an Ingress or Gateway in front of a ClusterIP Service if your environment already has one that works. On minikube, `minikube service SERVICE_NAME --url` gives you an address without a cloud load balancer.

## Step 3: Is the Service asking for a controller that is not there?

The `.spec.loadBalancerClass` field picks a load balancer implementation other than the cloud provider default. The official documentation is precise about what happens when it is set: the default implementation ignores the Service, and Kubernetes assumes a controller matching that class is watching. If no such controller exists, nobody handles the Service and it stays pending.

```
kubectl --context CONTEXT_NAME get service SERVICE_NAME -n NAMESPACE -o jsonpath='{.spec.loadBalancerClass}{"\n"}'
```

If this prints a class, confirm that a controller for exactly that class is installed and running. The field cannot be changed once set, so if the class is wrong, delete and recreate the Service without it, or with the right one.

## Step 4: Is the request one the provider accepts?

When a controller is handling the Service but failing, the event message is your best clue. A few causes come straight from the Kubernetes documentation:

**Mixed protocols.** By default, when a LoadBalancer Service defines more than one port, all ports must use the same protocol, and the protocol must be one the cloud provider supports. Newer Kubernetes versions allow mixed protocols such as TCP and UDP on one Service, but the official note is clear that your provider may still restrict which protocols work. If you mix protocols, try splitting them into two Services.

**A fixed IP with `loadBalancerIP`.** Some providers let you request a specific address with `.spec.loadBalancerIP`; others ignore the field. It was deprecated in Kubernetes v1.24 because its meaning varies across implementations. If you rely on it, check your provider's documentation for the annotation that replaces it, and check that the address you asked for is actually available to you.

**Disabled node ports.** Setting `spec.allocateLoadBalancerNodePorts: false` is only meant for load balancer implementations that route traffic directly to pods. If yours sends traffic through node ports, turn allocation back on.

**Annotations.** Internal load balancers, subnets, certificates and many other options are set with provider-specific annotations. A typo or an unsupported value is a common reason a controller refuses to create the load balancer. Compare each annotation with the provider's documentation.

Outside Kubernetes itself, check the provider account: quotas on load balancers or public IPs, and the permissions of the identity the controller uses. These show up in the controller's error message or logs, not in the Service spec.

## Step 5: The address arrived but traffic does not

Once EXTERNAL-IP shows an address, a different set of problems takes over. The load balancer forwards to your nodes or pods, and from there the request follows the normal Service path. If the address answers with errors or times out:

- Check that the Service has ready endpoints. The [Service not working guide](/blog/kubernetes-service-no-endpoints) walks through selectors, EndpointSlices and readiness.
- With `externalTrafficPolicy: Local`, the load balancer's health check only passes on nodes that run a ready pod for the Service. That is expected: it preserves the client source IP and avoids a second hop, at the cost of possibly uneven traffic spreading.
- If a NetworkPolicy selects the pods, make sure it allows the traffic. The [NetworkPolicy guide](/blog/kubernetes-networkpolicy-blocking-traffic) covers that.

## Step 6: Fix and verify

Apply the fix where it belongs: install or repair the load balancer provider, correct or remove `loadBalancerClass`, split mixed protocols, fix annotations, or raise the quota at the provider. Then watch the Service:

```
kubectl --context CONTEXT_NAME get service SERVICE_NAME -n NAMESPACE --watch
```

The EXTERNAL-IP column should change from `<pending>` to an address or hostname. Confirm it answers from outside the cluster, and keep `kubectl describe` open in case new events explain a further failure.

A note for cleanup: Kubernetes attaches a finalizer named `service.kubernetes.io/load-balancer-cleanup` to LoadBalancer Services, so a Service is not fully deleted until its cloud load balancer is cleaned up. If deleting the Service hangs, that is usually why, and the controller's errors say what is blocking it.

## Conclusion

A LoadBalancer Service stuck on pending is waiting for a controller. Read the events, then check, in order: that a load balancer provider exists, that `loadBalancerClass` does not point at a missing controller, and that the provider accepts what the Service asks for. Once the address arrives, troubleshoot traffic the same way you would for any Service.

If you work across clusters and cloud accounts to chase problems like this, Infrawrench brings Kubernetes exec and logs, SSH and the rest of your infrastructure into one workspace. [Download the free desktop app](/) for macOS, Windows or Linux, no account required.

## References

- [Service: type LoadBalancer](https://kubernetes.io/docs/concepts/services-networking/service/#loadbalancer)
- [Create an External Load Balancer](https://kubernetes.io/docs/tasks/access-application-cluster/create-external-load-balancer/)
- [Cloud Controller Manager](https://kubernetes.io/docs/concepts/architecture/cloud-controller/)
- [Debug Services](https://kubernetes.io/docs/tasks/debug/debug-application/debug-service/)
- [Using Source IP](https://kubernetes.io/docs/tutorials/services/source-ip/)
