import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

import { backendsConfigSchema } from "./backends.js";
import { PLUGIN_KEY, PRUNE_CRON, SWEEP_CRON } from "./constants.js";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_KEY,
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
    "ui.detailTab.register",
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
  // Only for reading core tables: heartbeat_runs (spike check 4), and cost_events for what runs cost through a backend
  // with no usage API. The plugin keeps its data in plugin state.
  database: { migrationsDir: "migrations", coreReadTables: ["heartbeat_runs", "cost_events"] },
  instanceConfigSchema: {
    type: "object",
    description: "Pools, limits and model servers are set per company under Company settings → Model capacity. Backends and pools are set on Company settings → Model capacity. The two settings here are optional: how held tasks are labelled and where alerts are posted.",
    additionalProperties: false,
    properties: {
      queueLabelId: { type: "string", title: "Queue label", description: "Existing label added to held tasks (optional)." },
      alertIssueId: { type: "string", title: "Alert task", description: "Unassigned standing task that gets alert comments (optional)." },
      quotaToken: { format: "secret-ref", title: "Board token for subscription quotas", description: "Optional. Lets the plugin read this company's Claude and ChatGPT subscription windows (board-only in Paperclip), so a subscription pool pauses when a window reaches 100%, and switch agents between Claude Code and Codex in a switching pool." },
      paperclipUrl: { type: "string", title: "Paperclip address", description: "Where the plugin reaches Paperclip's API with the board token. Paperclip blocks plugin requests to private addresses such as 127.0.0.1, so use its tailnet or public address (e.g. https://paperclip.example.ts.net)." },
      ...backendsConfigSchema,
    },
  },
  ui: {
    slots: [
      { type: "dashboardWidget", id: "capacity-widget", displayName: "Model capacity", exportName: "DashboardWidget" },
      { type: "page", id: "capacity-page", displayName: "Model capacity", exportName: "CapacityPage", routePath: "model-capacity" },
      { type: "companySettingsPage", id: "capacity-settings", displayName: "Model capacity", exportName: "SettingsPage", routePath: "model-capacity" },
      { type: "detailTab", id: "agent-pool", displayName: "Model capacity", exportName: "AgentPoolTab", entityTypes: ["agent"] },
    ],
  },
};

export default manifest;
