// Cloud IPC handlers, split by concern. Importing this file (or the parent
// directory) registers all of them via electron's `ipcMain.handle`.
import "./accounts";
import "./chat";
import "./costs";
import "./custom-graphs";
import "./dashboards";
import "./deployments";
import "./resources";
import "./secrets";
import "./metrics";
import "./sql-kv-docker";
import "./workflows";
import "./sftp";
import "./ssh-tunnels";
import "./host-key-trust";
