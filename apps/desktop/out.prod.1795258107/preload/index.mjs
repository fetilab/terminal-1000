import { contextBridge, ipcRenderer } from "electron";
import { z } from "zod";
const IPC_CHANNEL = "t1000";
const IPC_DOMAINS = [
  "app",
  "store",
  "ssh",
  "sftp",
  "forward",
  "pty",
  "telnet",
  "vnc",
  "rdp",
  "monitor",
  "notes",
  "completion",
  "ai",
  "mcp",
  "sessionlog",
  "settings",
  "sync",
  "hotkey",
  "broadcast",
  "quickcmd",
  "system",
  "update",
  "shellIntegration"
];
z.object({
  domain: z.enum(IPC_DOMAINS),
  action: z.string().min(1),
  payload: z.unknown()
});
function ipcRequest(domain, action, payload) {
  return { domain, action, payload };
}
const bridge = {
  invoke(domain, action, payload) {
    return ipcRenderer.invoke(IPC_CHANNEL, ipcRequest(domain, action, payload));
  },
  on(event, listener) {
    const wrapped = (_e, payload) => {
      listener(payload);
    };
    ipcRenderer.on(event, wrapped);
    return () => {
      ipcRenderer.removeListener(event, wrapped);
    };
  },
  platform: process.platform
};
contextBridge.exposeInMainWorld("t1000", bridge);
