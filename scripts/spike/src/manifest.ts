import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const manifest: PaperclipPluginManifestV1 = {
  id: "coma-toast.model-capacity-spike",
  apiVersion: 1,
  version: "0.0.1",
  displayName: "Model capacity spike",
  description: "Throwaway: checks blocker, wakeup, override and database behaviors. Uninstall after use.",
  author: "coma-toast",
  categories: ["automation"],
  capabilities: [
    "issues.read",
    "issues.create",
    "issues.update",
    "issues.wakeup",
    "issue.relations.read",
    "issue.relations.write",
    "issue.comments.create",
    "database.namespace.read",
    "database.namespace.migrate",
  ],
  entrypoints: { worker: "./dist/worker.js" },
  database: { migrationsDir: "migrations", coreReadTables: ["heartbeat_runs"] },
};

export default manifest;
