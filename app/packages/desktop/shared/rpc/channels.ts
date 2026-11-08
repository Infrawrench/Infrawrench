/**
 * The Electron IPC channels the Effect RPC transport rides on.
 *
 * Desktop RPC is `effect/rpc` over one pair of IPC channels instead of one
 * `ipcMain.handle` per operation: the renderer opens a connection with
 * {@link RPC_CONNECT}, then both sides exchange JSON frames on
 * {@link RPC_FRAME}. Every operation, its payload schema, its errors and its
 * streams are declared once in an `RpcGroup` under `shared/rpc/groups/`, which
 * both processes import, so the renderer cannot send a payload the main
 * process has not decoded and the main process cannot answer with a shape the
 * renderer does not expect.
 */
export const RPC_CONNECT = "iw-rpc:connect";
export const RPC_FRAME = "iw-rpc:frame";
