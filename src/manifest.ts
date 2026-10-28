import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const manifest: PaperclipPluginManifestV1 = {
  id: "coma-toast.paperclip-model-capacity",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Model capacity",
  description: "A Paperclip plugin",
  author: "Plugin Author",
  categories: ["automation"],
  capabilities: [
    "events.subscribe",
    "plugin.state.read",
    "plugin.state.write",
    "ui.dashboardWidget.register"
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui"
  },
  ui: {
    slots: [
      {
        type: "dashboardWidget",
        id: "health-widget",
        displayName: "Model capacity Health",
        exportName: "DashboardWidget"
      }
    ]
  }
};

export default manifest;
