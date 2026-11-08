---
title: "kubectl Unable to connect to the server: fix connection refused, timeouts and x509 errors"
description: "Fix kubectl when it cannot reach the cluster: read which server and context it is using, then match the error to its cause, from a missing kubeconfig (localhost:8080 refused) to an unreachable API server (i/o timeout) or a certificate problem (x509)."
date: "2026-11-08"
kind: guide
---

You run `kubectl get pods` and get no pods, only an error before kubectl ever reaches Kubernetes:

```
The connection to the server localhost:8080 was refused - did you specify the right host or port?
```

or one of its relatives:

```
Unable to connect to the server: dial tcp 203.0.113.10:443: i/o timeout
Unable to connect to the server: x509: certificate signed by unknown authority
Unable to connect to the server: x509: certificate has expired or is not yet valid
```

Every one of these means the same thing: kubectl could not hold a working HTTPS conversation with the API server. Nothing inside the cluster has been checked yet. This guide shows how to see exactly which server kubectl is trying, then fix the cause behind each message.

Prerequisites: kubectl installed and the kubeconfig file or credentials you were given for the cluster. Everything here follows the official [Kubernetes documentation](https://kubernetes.io/docs/concepts/configuration/organize-cluster-access-kubeconfig/). Placeholders used throughout: CONTEXT_NAME, CLUSTER_NAME, SERVER_ADDRESS and PATH_TO_KUBECONFIG. Replace them before running a command. Once kubectl connects and the problem is inside the cluster, continue with the [Kubernetes troubleshooting guide for pods, logs and events](/blog/kubernetes-troubleshooting-pods-logs-and-events).

## How kubectl decides where to connect

kubectl reads its connection details from kubeconfig files. It picks them in this order:

1. The `--kubeconfig` flag, if you pass it. Only that file is used.
2. The `KUBECONFIG` environment variable, if it is set. It can list several files, separated by `:` on Linux and macOS and `;` on Windows, and kubectl merges them.
3. Otherwise, `$HOME/.kube/config`.

Inside the merged configuration, the current context names a cluster (its `server` address and the certificate authority to trust) and a user (the credentials). If kubectl finds no configuration at all, it falls back to `localhost:8080`, which is where the first error above comes from.

## Step 1: See which server kubectl is using

Print the context and only the configuration it uses:

```
kubectl config current-context
kubectl config view --minify
```

Read the `server:` line under `clusters` and the `KUBECONFIG` variable:

```
echo "$KUBECONFIG"
kubectl config get-contexts
```

The `*` in `get-contexts` marks the current context. Most connection problems are visible here: an empty configuration, the wrong context, or a server address that belongs to a cluster that no longer exists.

To see the requests kubectl makes, raise the log verbosity. At `--v=6` kubectl prints each request URL and the response it got, which shows the exact address it dialled:

```
kubectl get pods --v=6
```

## Step 2: Match the error to its cause

### The connection to the server localhost:8080 was refused

kubectl found no kubeconfig, so it tried its default address. `kubectl config view` prints an empty configuration. Common causes:

- No kubeconfig has been written yet on this machine.
- `KUBECONFIG` points at a path that does not exist, or is set in one shell and not another.
- kubectl runs as a different user, for example with `sudo`, whose home directory has no `.kube/config`.

Point kubectl at the file you were given, or copy it into place:

```
export KUBECONFIG=PATH_TO_KUBECONFIG
kubectl config get-contexts
```

On a control-plane node you created with kubeadm, the Kubernetes docs copy the admin kubeconfig into your home directory:

```
mkdir -p $HOME/.kube
sudo cp -i /etc/kubernetes/admin.conf $HOME/.kube/config
sudo chown $(id -u):$(id -g) $HOME/.kube/config
```

Clusters run by a cloud provider usually come with a CLI command that writes a context into your kubeconfig. Run it again if the file was lost or replaced.

### Wrong cluster or wrong context

If kubectl connects, or fails, against a server you did not expect, switch to the right context:

```
kubectl config use-context CONTEXT_NAME
```

Or pass `--context CONTEXT_NAME` on each command so a context switch in another terminal cannot surprise you. When several kubeconfig files are merged through `KUBECONFIG`, two files can define a context or cluster with the same name. The first file that sets a value wins, so a stale entry in an earlier file can hide the one you just added. Check with `kubectl config view` and rename or remove the duplicate.

### Unable to connect to the server: dial tcp ... i/o timeout

kubectl sent packets towards the server address and nothing answered. The API server is either not running or not reachable from where you are. Test the address directly. The API server's health endpoints are normally readable without credentials:

```
curl -k https://SERVER_ADDRESS/livez
```

`-k` skips certificate checks and is only for this reachability test. If `ok` comes back, the network path works and the problem is in kubectl's configuration. If `curl` also times out, check:

- The cluster itself is running. A stopped or deleted cluster, or a control-plane node that is down, gives exactly this error.
- The endpoint is reachable from your network. Private API endpoints need the VPN, bastion or network they were set up for. A firewall or an allow-list of source addresses on the endpoint can drop your traffic.
- The address is current. If the control plane was recreated or its IP changed, update the `server:` line or regenerate the kubeconfig.

### Connection refused on the right address

`connect: connection refused` means something answered and turned the connection away: the host is up but nothing listens on that port. The API server process may be down, or the port in the `server:` line may be wrong. On a kubeadm cluster the API server runs as a static pod on each control-plane node, so check it there with the container runtime's tools and read its logs.

### A proxy sits between you and the cluster

kubectl honours the `HTTPS_PROXY` and `NO_PROXY` environment variables. A corporate proxy that cannot reach a private cluster, or a `NO_PROXY` list that leaves out the API server, turns into timeouts or proxy errors. To send one cluster through a specific proxy, set `proxy-url` on the cluster entry in the kubeconfig:

```
clusters:
- cluster:
    server: https://SERVER_ADDRESS
    proxy-url: http://proxy.example.org:3128
  name: CLUSTER_NAME
```

### x509: certificate signed by unknown authority

kubectl reached a server but did not trust its certificate. kubectl checks the API server's certificate against the cluster's `certificate-authority-data` (or the `certificate-authority` file path) in your kubeconfig. This error means the CA in your kubeconfig did not sign the certificate the server presented. Common causes:

- The kubeconfig belongs to an older instance of the cluster, and the cluster was rebuilt with a new CA. On kubeadm clusters, the docs point to exactly this case and fix it by copying a fresh `/etc/kubernetes/admin.conf`.
- The `server:` address points at the wrong machine, such as a load balancer or another cluster.
- A proxy that intercepts TLS replaces the server's certificate with its own.

Get a current kubeconfig from whoever runs the cluster, or regenerate it with the provider's CLI. Avoid `insecure-skip-tls-verify: true`: it turns off the check that you are talking to your real API server.

### x509: certificate is valid for ..., not SERVER_ADDRESS

The server's certificate does not list the name or IP you connect with. This happens when you reach the API server through an address that was not added to the certificate, for example a new load balancer or a public IP. Connect with one of the names the error lists, or, on a kubeadm cluster, add the address to the API server certificate's extra SANs and regenerate the certificate.

### x509: certificate has expired or is not yet valid

Either a certificate has expired or a clock is wrong. Check the date on your machine first: a clock far in the past or future makes valid certificates look invalid. If the clock is right, on kubeadm clusters check the expiry of the control-plane certificates and of the certificate embedded in admin.conf:

```
sudo kubeadm certs check-expiration
```

Renew them with `kubeadm certs renew`, as described in [Certificate Management with kubeadm](https://kubernetes.io/docs/tasks/administer-cluster/kubeadm/kubeadm-certs/), then restart the control-plane components and use the renewed admin kubeconfig. Managed clusters rotate their control-plane certificates themselves, so on those this error usually means an old kubeconfig or a wrong clock.

### error: You must be logged in to the server (Unauthorized)

This one is progress: kubectl reached the API server and the TLS check passed, but the server rejected your credentials. A client certificate may have expired, or a token or credential plugin may be returning stale credentials. Many cloud kubeconfigs use an `exec` entry under `users` that runs a command to fetch a token, so that command must be installed, on your PATH and logged in. Refresh the credentials or regenerate the kubeconfig. If the error is `Forbidden` instead, you are authenticated but lack permission: see [RBAC permissions](/blog/kubernetes-rbac-forbidden).

## Step 3: Verify

Once the error is gone, confirm kubectl talks to the cluster you meant:

```
kubectl config current-context
kubectl cluster-info
kubectl version
```

`kubectl cluster-info` prints the address of the control plane it reached, and `kubectl version` shows both the client and the server version. If the server version is missing, kubectl still cannot reach the API server. The API server's own readiness check confirms it is serving:

```
kubectl get --raw='/readyz?verbose'
```

## Conclusion

"Unable to connect to the server" is about the path from kubectl to the API server, never about your workloads. Start with `kubectl config view --minify` to see which server and context kubectl uses, then read the error: `localhost:8080` means no kubeconfig, a timeout means the server is down or out of reach, connection refused means nothing listens on that port, and x509 means kubectl does not trust the certificate it got. Fix the kubeconfig, the network path or the certificate, and verify with `kubectl cluster-info`.

If you keep a different kubeconfig for every cluster across several clouds, Infrawrench connects your cloud accounts and gives you Kubernetes exec and logs, SSH and SQL in one workspace. [Download the free desktop app](/) for macOS, Windows or Linux, no account required.

## References

- [Organizing Cluster Access Using kubeconfig Files](https://kubernetes.io/docs/concepts/configuration/organize-cluster-access-kubeconfig/)
- [Configure Access to Multiple Clusters](https://kubernetes.io/docs/tasks/access-application-cluster/configure-access-multiple-clusters/)
- [Install and Set Up kubectl on Linux](https://kubernetes.io/docs/tasks/tools/install-kubectl-linux/)
- [Kubernetes API health endpoints](https://kubernetes.io/docs/reference/using-api/health-checks/)
- [Troubleshooting kubeadm](https://kubernetes.io/docs/setup/production-environment/tools/kubeadm/troubleshooting-kubeadm/)
- [Certificate Management with kubeadm](https://kubernetes.io/docs/tasks/administer-cluster/kubeadm/kubeadm-certs/)
- [Authenticating](https://kubernetes.io/docs/reference/access-authn-authz/authentication/)
- [kubectl Quick Reference](https://kubernetes.io/docs/reference/kubectl/quick-reference/)
