import { ipcMain } from "electron";
import { killK8sExec, resizeK8sExec, spawnK8sExec, writeK8sExec } from "./k8s-exec";
import { checkK9sInstalled, killK9s, resizeK9s, spawnK9s, writeK9s } from "./k9s";

ipcMain.handle("k8s_exec_spawn", (event, args) => spawnK8sExec(event.sender, args));
ipcMain.handle("k8s_exec_write", (_event, { sessionId, data }) => writeK8sExec(sessionId, data));
ipcMain.handle("k8s_exec_resize", (_event, { sessionId, cols, rows }) =>
  resizeK8sExec(sessionId, cols, rows),
);
ipcMain.handle("k8s_exec_kill", (_event, { sessionId }) => killK8sExec(sessionId));

ipcMain.handle("k9s_check", () => checkK9sInstalled());
ipcMain.handle("k9s_spawn", (event, args) => spawnK9s(event.sender, args));
ipcMain.handle("k9s_write", (_event, { sessionId, data }) => writeK9s(sessionId, data));
ipcMain.handle("k9s_resize", (_event, { sessionId, cols, rows }) =>
  resizeK9s(sessionId, cols, rows),
);
ipcMain.handle("k9s_kill", (_event, { sessionId }) => killK9s(sessionId));
