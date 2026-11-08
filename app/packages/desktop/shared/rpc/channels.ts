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
/**
 * The page is going away (a reload, a navigation, the window closing). Sent
 * by the preload on `pagehide` with the token its {@link RPC_CONNECT} carried,
 * so the main process ends that page's connection, interrupting its streams
 * (and releasing what they hold, such as an SSH channel) at once instead of
 * when the next page happens to connect. A token that does not match the
 * current connection is ignored: it is a stale page's, and the connection
 * belongs to its successor.
 */
export const RPC_DISCONNECT = "iw-rpc:disconnect";
