import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";

import { registerApi } from "./api.js";
import { AUTH_SLOTS } from "./auth.js";
import manifest from "./manifest.js";
import { createRuntime, type Runtime } from "./runtime.js";

const CONFIG_KEYS = Object.keys(manifest.instanceConfigSchema?.properties ?? {});
let runtime: Runtime | undefined;

const plugin = definePlugin({
  async setup(ctx) {
    runtime = createRuntime(ctx);
    runtime.start();
    registerApi(ctx, runtime);
    ctx.data.register("health", async () => ({ status: "ok", ...runtime?.health(), checkedAt: new Date().toISOString() }));
  },

  async onHealth() {
    const h = runtime?.health();
    if (h?.lastError) return { status: "degraded", message: `Last cycle failed: ${h.lastError}` };
    return { status: "ok", message: h?.lastCycleAt ? `Last cycle ${h.lastCycleAt}` : "Waiting for the first cycle" };
  },

  async onValidateConfig(config) {
    const errors: string[] = [];
    for (const [key, value] of Object.entries(config)) {
      if (!CONFIG_KEYS.includes(key)) errors.push(`${key}: unknown setting`);
      else if (AUTH_SLOTS.includes(key as (typeof AUTH_SLOTS)[number]) || key === "apiEndpoints") {
        if (value !== undefined && value !== null && (typeof value !== "object" || Array.isArray(value))) errors.push(`${key}: must be an object`);
      } else if (value !== undefined && value !== null && typeof value !== "string") errors.push(`${key}: must be a text id`);
    }
    return errors.length ? { ok: false, errors } : { ok: true };
  },

  async onShutdown() {
    await runtime?.stop();
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
