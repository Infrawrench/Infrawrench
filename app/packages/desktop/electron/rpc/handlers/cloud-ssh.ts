import { Effect, Layer } from "effect";
import { CloudSshRpcs } from "../../../shared/rpc/groups/cloud-ssh";
import { CloudSsh } from "../../cloud-ssh";

export const CloudSshHandlers = CloudSshRpcs.toLayer(
  Effect.gen(function* () {
    const ssh = yield* CloudSsh;
    return CloudSshRpcs.of({
      CloudSftpUpload: (input) => ssh.upload(input),
      CloudSftpDownload: (input) => ssh.download(input),
      CloudSshHostKeyTrust: (input) => ssh.trustHostKey(input),
    });
  }),
).pipe(Layer.provide(CloudSsh.layer));
