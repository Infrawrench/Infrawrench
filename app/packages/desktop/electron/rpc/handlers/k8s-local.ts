import { Effect, Layer } from "effect";
import { K8sLocalRpcs } from "../../../shared/rpc/groups/k8s-local";
import { K8sLocal } from "../../k8s-local";

export const K8sLocalHandlers = K8sLocalRpcs.toLayer(
  Effect.gen(function* () {
    const k8s = yield* K8sLocal;
    return K8sLocalRpcs.of({
      // Each stream's scope owns its process and kubeconfig: the server closes
      // it when the process exits, the renderer interrupts it, or the
      // renderer's connection goes.
      K8sExecOpen: (config, { client }) => k8s.openExec(config, client.id),
      K8sExecWrite: ({ sessionId, data }, { client }) => k8s.writeExec(sessionId, client.id, data),
      K8sExecResize: ({ sessionId, cols, rows }, { client }) =>
        k8s.resizeExec(sessionId, client.id, cols, rows),
      K9sCheck: () => k8s.k9sInstalled,
      K9sOpen: (config, { client }) => k8s.openK9s(config, client.id),
      K9sWrite: ({ sessionId, data }, { client }) => k8s.writeK9s(sessionId, client.id, data),
      K9sResize: ({ sessionId, cols, rows }, { client }) =>
        k8s.resizeK9s(sessionId, client.id, cols, rows),
      K8sPortForwardOpen: (config) => k8s.portForward(config),
      K8sApiRequest: (req) => k8s.apiRequest(req),
    });
  }),
).pipe(Layer.provide(K8sLocal.layer));
