---
title: "Kubernetes RBAC forbidden errors: find the missing permission and grant only that"
description: "Fix Kubernetes 403 Forbidden errors by finding who is making the request, checking access with kubectl auth can-i, and granting the right Role or ClusterRole with a binding at the right scope."
date: "2026-11-01"
kind: guide
---

A forbidden error means the API server knows who you are and has decided you are not allowed to do what you asked. The request was authenticated, then rejected at authorization, and the server answered with HTTP 403 Forbidden. In a cluster that uses RBAC, it usually means no Role or ClusterRole bound to the caller grants that verb on that resource in that namespace. This guide shows how to find out exactly who is calling, which permission is missing and how to grant it at the narrowest scope that works.

Prerequisites: kubectl installed, access to the cluster, and permission to read Roles, ClusterRoles, RoleBindings and ClusterRoleBindings. Checking access for another user or a service account with `--as` also needs permission to impersonate them, and fixing the problem needs permission to create bindings. Everything here follows the official Kubernetes documentation on [RBAC authorization](https://kubernetes.io/docs/reference/access-authn-authz/rbac/) and [authorization](https://kubernetes.io/docs/reference/access-authn-authz/authorization/). Placeholders used throughout: CONTEXT_NAME, NAMESPACE, POD_NAME, CONFIGMAP_NAME, USER_NAME, GROUP_NAME, SA_NAMESPACE, SA_NAME, ROLE_NAME and BINDING_NAME. Replace them before running a command.

## How Kubernetes decides a request is forbidden

Every request to the API server is described by a small set of attributes: the user, the groups that user belongs to, the verb, the resource and any subresource, the namespace and, for some requests, the object name. The authorizers configured on the cluster are checked in order. If one approves or denies the request, that answer is final. If none of them has an opinion, the request is denied, and a denial comes back as 403 Forbidden.

RBAC permissions are purely additive. There are no deny rules. So a forbidden error under RBAC is never caused by a rule that blocks you: it means no rule granted what you asked for. The fix is always to find the missing grant, not to look for something to remove.

Before changing anything, write down the verb, resource and namespace of the request that failed. Those are exactly the attributes you need for the rest of this guide.

## Step 1: Confirm who the API server thinks you are

Authorization is decided for the identity the API server sees, which is not always the one you expect: you may be on a different context, or a pod may run as a service account you did not intend. Check the context and the identity first:

```
kubectl config current-context
kubectl --context CONTEXT_NAME auth whoami
```

`auth whoami` prints the username and groups the API server derived from your credentials. If that is not who you expected, fix the kubeconfig or login first. Nothing else in this guide will help until the identity is right.

For a workload, the identity is its service account. A pod that does not set `serviceAccountName` runs as the `default` service account in its namespace. Check what a pod uses:

```
kubectl --context CONTEXT_NAME -n NAMESPACE get pod POD_NAME -o jsonpath='{.spec.serviceAccountName}{"\n"}'
```

Service accounts have usernames of the form `system:serviceaccount:SA_NAMESPACE:SA_NAME`, singular, and belong to the groups `system:serviceaccounts`, plural, and `system:serviceaccounts:SA_NAMESPACE`. The singular prefix is for service account usernames and the plural one for service account groups, so mixing them up means a binding never matches.

## Step 2: Reproduce the denial with kubectl auth can-i

`kubectl auth can-i` asks the API server's authorization layer directly whether an action is allowed, and works whatever authorization mode the cluster uses. Run it with the verb, resource and namespace from the error:

```
kubectl --context CONTEXT_NAME auth can-i list pods --namespace NAMESPACE
```

It answers `yes` or `no`. A few forms cover most cases:

```
# A resource in a named API group
kubectl --context CONTEXT_NAME auth can-i create deployments.apps --namespace NAMESPACE

# A subresource, such as pod logs
kubectl --context CONTEXT_NAME auth can-i get pods --subresource=log --namespace NAMESPACE

# A specific object by name
kubectl --context CONTEXT_NAME auth can-i get configmaps/CONFIGMAP_NAME --namespace NAMESPACE

# Across all namespaces
kubectl --context CONTEXT_NAME auth can-i list pods --all-namespaces
```

To check someone else, add `--as`. This is how you test a service account without running its pod:

```
kubectl --context CONTEXT_NAME auth can-i list pods --namespace NAMESPACE --as system:serviceaccount:SA_NAMESPACE:SA_NAME
kubectl --context CONTEXT_NAME auth can-i list secrets --namespace NAMESPACE --as USER_NAME
```

`--as` uses impersonation, so you need the `impersonate` verb for the user, group or service account you name. You can add `--as-group GROUP_NAME` to impersonate group membership as well.

To see everything an identity can do in a namespace, use `--list`:

```
kubectl --context CONTEXT_NAME auth can-i --list --namespace NAMESPACE
kubectl --context CONTEXT_NAME auth can-i --list --namespace NAMESPACE --as system:serviceaccount:SA_NAMESPACE:SA_NAME
```

If `can-i` says `yes` but the real request is still forbidden, check that you tested the same identity, verb, resource, API group and namespace as the failing request, one by one.

## Step 3: Get the verb and resource exactly right

RBAC matches on the same resource names that appear in the API URL, and on request verbs derived from the HTTP method. A grant that is off by one detail grants nothing for the failing request:

- **The verb.** `get` is for a single named object, `list` for a collection and `watch` for watching. A tool that lists and watches pods needs both `list` and `watch`, not just `get`. Writes use `create`, `update`, `patch`, `delete` and `deletecollection`.
- **The API group.** Pods, Services, ConfigMaps and Secrets are in the core group, written `""` in a rule. Deployments are in `apps` and Jobs in `batch`. A rule for `deployments` under `apiGroups: [""]` grants nothing.
- **Subresources.** Pod logs are `pods/log`, exec is `pods/exec` and port forwarding is `pods/portforward`. Permission on `pods` does not include them. They must be listed separately, with a slash. If `kubectl exec` or `kubectl port-forward` fails for reasons other than permissions, see the [kubectl exec and port-forward errors guide](/blog/kubernetes-kubectl-exec-port-forward-errors).
- **Resource names.** A rule with `resourceNames` only applies to those objects. You cannot restrict `create` on a top level resource or `deletecollection` by name, and a `list` or `watch` restricted by name only works when the client asks for that name with a `metadata.name` field selector.

Note that `get`, `list` and `watch` all return full object contents. Granting `list` on Secrets is the same as granting read access to every Secret it covers.

## Step 4: Find which bindings apply, and at what scope

Now look at what is bound to the identity. Permissions come from two kinds of object working together:

- A **Role** holds rules inside one namespace. A **ClusterRole** is not namespaced. It can hold rules for namespaced resources, for cluster-scoped resources such as nodes, and for non-resource URLs such as `/healthz`.
- A **RoleBinding** grants a Role or a ClusterRole inside the binding's own namespace. A **ClusterRoleBinding** grants a ClusterRole across the whole cluster.

The scope comes from the binding, not the role. A RoleBinding in namespace `development` that references a ClusterRole only grants those permissions in `development`, however broad the ClusterRole is. That is the usual answer to "it works in one namespace but not another". Cluster-scoped resources such as nodes do not live in any namespace, so the docs grant access to them with a ClusterRole bound by a ClusterRoleBinding.

List the bindings in the namespace and across the cluster, then inspect the ones whose subjects include the identity from Step 1:

```
kubectl --context CONTEXT_NAME -n NAMESPACE get rolebindings -o wide
kubectl --context CONTEXT_NAME get clusterrolebindings -o wide
kubectl --context CONTEXT_NAME -n NAMESPACE describe rolebinding BINDING_NAME
kubectl --context CONTEXT_NAME -n NAMESPACE describe role ROLE_NAME
```

`-o wide` shows the role and the users, groups and service accounts each binding names. When checking a subject, look for these mistakes:

- **A service account bound with the wrong namespace.** A `ServiceAccount` subject must name the namespace the service account lives in, which may differ from the binding's namespace.
- **A typo or wrong case in a user or group name.** Subject names are matched exactly.
- **Binding the `default` service account when the pod uses another one**, or the other way round.

## Step 5: Grant the missing permission at the narrowest scope

Once you know the verb, resource, namespace and identity, grant exactly that. Prefer a Role and RoleBinding in the namespace where access is needed. Use a ClusterRole with a RoleBinding when you want one definition reused in several namespaces, and a ClusterRoleBinding only when the access really must cover every namespace or cluster-scoped resources.

For example, to let a service account read pods and their logs in one namespace:

```
kubectl --context CONTEXT_NAME -n NAMESPACE create role pod-log-reader --verb=get,list,watch --resource=pods,pods/log
kubectl --context CONTEXT_NAME -n NAMESPACE create rolebinding pod-log-reader --role=pod-log-reader --serviceaccount=SA_NAMESPACE:SA_NAME
```

The built-in user-facing ClusterRoles cover common cases. `view` allows read-only access to most objects in a namespace but not Secrets, Roles or RoleBindings. `edit` allows read and write access to most objects but not Roles or RoleBindings, though it can read Secrets and run pods as any service account in the namespace. `admin` adds managing Roles and RoleBindings within the namespace. Bind them per namespace with a RoleBinding:

```
kubectl --context CONTEXT_NAME -n NAMESPACE create rolebinding SA_NAME-view --clusterrole=view --serviceaccount=SA_NAMESPACE:SA_NAME
```

Bind roles to an application's own service account rather than to `default`, because permissions given to `default` apply to every pod in the namespace that does not set `serviceAccountName`. Avoid wildcards in verbs and resources: a wildcard automatically covers resources, subresources and verbs added later. And never grant `cluster-admin` to the `system:serviceaccounts` group to make an error go away. The docs warn that this gives any application full access to the cluster.

Run the `can-i` check from Step 2 again. It should now say `yes`.

## Step 6: Forbidden when you edit roles or bindings

Two RBAC errors come from changing RBAC itself rather than from a missing grant on the resource.

**Creating or updating a role or binding is forbidden.** RBAC prevents privilege escalation. You can only create or update a Role or ClusterRole if you already hold every permission in it at the same scope, or you have the `escalate` verb on `roles` or `clusterroles`. You can only create or update a binding if you hold every permission in the role it references, at the binding's scope, or you have the `bind` verb on that role. So a namespace admin cannot hand out permissions they do not have. Ask someone who holds them, or have a cluster administrator grant `bind` on the specific roles you need to delegate.

**Changing a binding's role is rejected.** The `roleRef` of a binding cannot be changed after it is created. Editing it returns a validation error. Delete the binding and create a new one, or apply your manifests with `kubectl auth reconcile`, which deletes and recreates bindings when the role they refer to changes.

## Step 7: Check aggregated ClusterRoles

Some ClusterRoles, including the built-in `admin`, `edit` and `view`, are aggregated. Their rules are not written directly on them. A controller fills them in from every ClusterRole whose labels match the role's `aggregationRule`. Rules you add directly to an aggregated ClusterRole get overwritten.

If a custom resource is forbidden for people who have `edit` or `view`, the operator that installed it may not have added aggregation. To extend the built-in roles, create a separate ClusterRole with the rules and one or more of these labels:

```yaml
metadata:
  labels:
    rbac.authorization.k8s.io/aggregate-to-admin: "true"
    rbac.authorization.k8s.io/aggregate-to-edit: "true"
    rbac.authorization.k8s.io/aggregate-to-view: "true"
```

Check what an aggregated role currently contains with `kubectl --context CONTEXT_NAME describe clusterrole view`. For a component example, the [Kubernetes DNS troubleshooting guide](/blog/kubernetes-dns-troubleshooting) shows how to check the CoreDNS ClusterRole.

## Conclusion

A forbidden error is a precise statement: this identity may not use this verb on this resource in this namespace. Confirm the identity with `kubectl auth whoami`, reproduce the denial with `kubectl auth can-i`, match the verb, API group and subresource exactly, then add the smallest Role or binding that grants it. Remember that RBAC only adds permissions, and that the binding sets the scope.

If you work across several clusters and cloud accounts, Infrawrench brings Kubernetes exec and logs, SSH, SQL and your cloud resources into one workspace. [Download the free desktop app](/) for macOS, Windows or Linux, no account required.

## References

- [Using RBAC authorization](https://kubernetes.io/docs/reference/access-authn-authz/rbac/)
- [Authorization: request attributes and checking API access](https://kubernetes.io/docs/reference/access-authn-authz/authorization/)
- [kubectl auth can-i](https://kubernetes.io/docs/reference/kubectl/generated/kubectl_auth/kubectl_auth_can-i/)
- [Authentication: kubectl auth whoami](https://kubernetes.io/docs/reference/access-authn-authz/authentication/#self-subject-review-cli)
- [User impersonation](https://kubernetes.io/docs/reference/access-authn-authz/user-impersonation/)
