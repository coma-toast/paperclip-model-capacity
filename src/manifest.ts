import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

import { PRUNE_CRON, SWEEP_CRON } from "./constants.js";

const manifest: PaperclipPluginManifestV1 = {
  id: "coma-toast.paperclip-model-capacity",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Model capacity",
  description: "Caps concurrent agent runs per model pool, queues the rest with native blockers, and watches host health.",
  author: "coma-toast",
  categories: ["automation"],
  capabilities: [
    "events.subscribe",
    "jobs.schedule",
    "plugin.state.read",
    "plugin.state.write",
    "companies.read",
    "agents.read",
    "issues.read",
    "issues.create",
    "issues.update",
    "issues.wakeup",
    "issue.relations.read",
    "issue.relations.write",
    "issue.comments.read",
    "issue.comments.create",
    "activity.log.write",
    "http.outbound",
    "secrets.read-ref",
    "database.namespace.read",
    "database.namespace.migrate",
    "ui.dashboardWidget.register",
    "ui.page.register",
    "instance.settings.register",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  jobs: [
    { jobKey: "sweep", displayName: "Capacity sweep", description: "Recount runs, release or hold tasks, fix anything events missed.", schedule: SWEEP_CRON },
    { jobKey: "prune", displayName: "Prune history", description: "Drop decision history older than the retention period.", schedule: PRUNE_CRON },
  ],
  // Only for the read-only core heartbeat_runs table (spike check 4); the plugin keeps its data in plugin state.
  database: { migrationsDir: "migrations", coreReadTables: ["heartbeat_runs"] },
  instanceConfigSchema: {
    type: "object",
    description: "Pools, limits and model servers are set per company under Company settings → Model capacity. These two optional settings only control how held tasks are labelled and where alerts are posted.",
    additionalProperties: false,
    properties: {
      queueLabelId: { type: "string", title: "Queue label", description: "Existing label added to held tasks (optional)." },
      alertIssueId: { type: "string", title: "Alert task", description: "Unassigned standing task that gets alert comments (optional)." },
    },
  },
  ui: {
    slots: [
      { type: "dashboardWidget", id: "capacity-widget", displayName: "Model capacity", exportName: "DashboardWidget" },
      { type: "page", id: "capacity-page", displayName: "Model capacity", exportName: "CapacityPage", routePath: "model-capacity" },
      { type: "companySettingsPage", id: "capacity-settings", displayName: "Model capacity", exportName: "SettingsPage", routePath: "model-capacity" },
    ],
  },
};

export default manifest;
