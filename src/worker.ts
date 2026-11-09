import type { PluginApiRequestInput, PluginApiResponse, PluginContext } from "@paperclipai/plugin-sdk";
import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";

import { registerApi } from "./api.js";
import manifest from "./manifest.js";
import { authorizeMetricsRequest, collectMetrics } from "./metrics.js";
import { createRuntime, type Runtime } from "./runtime.js";

const CONFIG_KEYS = Object.keys(manifest.instanceConfigSchema?.properties ?? {});
let runtime: Runtime | undefined;
let pluginCtx: PluginContext | undefined;

const plugin = definePlugin({
  async setup(ctx) {
    pluginCtx = ctx;
    runtime = createRuntime(ctx);
    runtime.start();
    registerApi(ctx, runtime);
    ctx.data.register("health", async () => ({ status: "ok", ...runtime?.health(), checkedAt: new Date().toISOString() }));
  },

  async onApiRequest(input: PluginApiRequestInput): Promise<PluginApiResponse> {
    if (input.routeKey === "metrics" || input.path === "/metrics") {
      if (!runtime || !pluginCtx) {
        return { status: 503, headers: { "content-type": "application/json" }, body: { error: "Plugin worker runtime is not initialized" } };
      }
      const auth = await authorizeMetricsRequest(pluginCtx, input);
      if (!auth.authorized) {
        return { status: 401, headers: { "content-type": "application/json" }, body: { error: auth.reason ?? "Unauthorized" } };
      }
      const text = await collectMetrics(runtime, input.companyId);
      return {
        status: 200,
        headers: { "content-type": "text/plain; version=0.0.4; charset=utf-8" },
        body: text,
      };
    }
    return { status: 404, headers: { "content-type": "application/json" }, body: { error: "Route not found" } };
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
      else if (key === "backends") {
        if (value !== undefined && value !== null && !Array.isArray(value)) errors.push("backends: must be a list");
      } else if (value !== undefined && value !== null && typeof value !== "string") errors.push(`${key}: must be a text id`);
    }
    return errors.length ? { ok: false, errors } : { ok: true };
  },

  // Backends live in the company config and are read on use, so a change needs no restart, just a fresh cycle.
  async onConfigChanged() {
    runtime?.schedule("config changed");
  },

  async onShutdown() {
    await runtime?.stop();
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
