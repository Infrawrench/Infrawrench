/**
 * Every RPC group the desktop main process serves to the renderer, merged
 * into the one group the server and client are built from. One line per group.
 */
import { ShellCommandRpcs } from "./shell-command";

export class DesktopRpcs extends ShellCommandRpcs {}
