// Cloud IPC handlers, split by concern. Importing this file (or the parent
// directory) registers all of them via electron's `ipcMain.handle`.
import "./accounts";
import "./dashboards";
import "./resources";
import "./secrets";
import "./metrics";
import "./sql-kv-docker";
import "./sftp";
import "./ssh-tunnels";
