// Stands in for `ssh` in the tests (`GIT_SSH_COMMAND`): git runs it as
// `<this> [-o SendEnv=GIT_PROTOCOL] -p <port> git@127.0.0.1 "git-upload-pack '/repo.git'"`
// and speaks the stateful protocol over its stdin and stdout. It forwards
// both to the test's TCP server, with the command and `GIT_PROTOCOL` on a
// first line of their own.
import { connect } from "node:net";

const args = process.argv.slice(2);
const command = args[args.length - 1];
const port = Number(args[args.indexOf("-p") + 1]);
const socket = connect({ port, host: "127.0.0.1", allowHalfOpen: true }, () => {
  socket.write(`${JSON.stringify({ command, protocol: process.env.GIT_PROTOCOL ?? "" })}\n`);
  process.stdin.pipe(socket);
  socket.pipe(process.stdout);
});
socket.on("error", (error) => {
  process.stderr.write(`ssh-helper: ${error.message}\n`);
  process.exit(255);
});
// Exit only once stdout has taken everything: git is still reading the last packets.
socket.on("close", () => process.stdout.write("", () => process.exit(0)));
