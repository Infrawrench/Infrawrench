/**
 * Kubernetes on this machine (`K8sLocalRpcs`), as an Effect service over the
 * terminal, port-forward and cluster-request modules beside it. Every call
 * that writes a kubeconfig to disk for kubectl or k9s passes the local-exec
 * consent gate first: a kubeconfig can name a program to run.
 */
import { Context, Effect, Layer, Stream } from "effect";
import { errorMessage } from "../shared/rpc/errors";
import {
  K8sLocalError,
  type K8sApiRequest,
  type K8sApiResponse,
  type K8sExecConfig,
  type K8sPortForwardConfig,
  type K8sPortForwardEvent,
  type K8sTerminalEvent,
  type K9sConfig,
} from "../shared/rpc/groups/k8s-local";
import { k8sApiRequest } from "./k8s-api-request";
import { k8sExecSessions } from "./k8s-exec";
import { openPortForward } from "./k8s-port-forward";
import { checkK9sInstalled, k9sSessions } from "./k9s";
import { localExecGuard } from "./local-exec-consent";

const toK8sError = (cause: unknown) => new K8sLocalError({ message: errorMessage(cause) });

/** `stream`, once the user has consented to running `kubeconfig`. */
const afterConsent = <A>(kubeconfig: string, stream: Stream.Stream<A, K8sLocalError>) =>
  Stream.unwrap(
    Effect.tryPromise({
      try: () => localExecGuard.assertKubeconfig(kubeconfig),
      catch: toK8sError,
    }).pipe(Effect.as(stream)),
  );

type Terminal = Stream.Stream<K8sTerminalEvent, K8sLocalError>;

export class K8sLocal extends Context.Service<
  K8sLocal,
  {
    readonly openExec: (config: K8sExecConfig, owner: number) => Terminal;
    readonly writeExec: (sessionId: string, owner: number, data: string) => Effect.Effect<void>;
    readonly resizeExec: (
      sessionId: string,
      owner: number,
      cols: number,
      rows: number,
    ) => Effect.Effect<void>;
    readonly k9sInstalled: Effect.Effect<boolean>;
    readonly openK9s: (config: K9sConfig, owner: number) => Terminal;
    readonly writeK9s: (sessionId: string, owner: number, data: string) => Effect.Effect<void>;
    readonly resizeK9s: (
      sessionId: string,
      owner: number,
      cols: number,
      rows: number,
    ) => Effect.Effect<void>;
    readonly portForward: (
      config: K8sPortForwardConfig,
    ) => Stream.Stream<K8sPortForwardEvent, K8sLocalError>;
    readonly apiRequest: (req: K8sApiRequest) => Effect.Effect<K8sApiResponse, K8sLocalError>;
  }
>()("infrawrench/desktop/K8sLocal") {
  static readonly layer = Layer.succeed(K8sLocal)(
    K8sLocal.of({
      openExec: (config, owner) =>
        afterConsent(config.kubeconfig, k8sExecSessions.open(config, owner)),
      writeExec: k8sExecSessions.write,
      resizeExec: k8sExecSessions.resize,
      k9sInstalled: Effect.sync(checkK9sInstalled),
      openK9s: (config, owner) => afterConsent(config.kubeconfig, k9sSessions.open(config, owner)),
      writeK9s: k9sSessions.write,
      resizeK9s: k9sSessions.resize,
      portForward: (config) => afterConsent(config.kubeconfig, openPortForward(config)),
      apiRequest: (req) => Effect.tryPromise({ try: () => k8sApiRequest(req), catch: toK8sError }),
    }),
  );
}
