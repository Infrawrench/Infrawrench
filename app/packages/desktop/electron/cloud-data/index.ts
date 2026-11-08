// Cloud IPC handlers, split by concern. Importing this file (or the parent
// directory) registers all of them via electron's `ipcMain.handle`.
import "./chat";
import "./costs";
import "./cost-canvases";
import "./invoices";
import "./compliance";
import "./access-review";
import "./resource-reports";
import "./custom-graphs";
import "./resources";
import "./workflows";
import "./sftp";
import "./ssh-fanout";
import "./host-key-trust";
