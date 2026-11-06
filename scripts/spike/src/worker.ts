import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";

interface SpikeParams {
  companyId: string;
  agentId: string;
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

const plugin = definePlugin({
  async setup(ctx) {
    // Called through POST /api/plugins/:id/bridge/data {key: "spike", params}; ids come from the caller so none live in the repo.
    ctx.data.register("spike", async (raw) => {
      const { companyId, agentId } = raw as unknown as SpikeParams;
      const out: Record<string, unknown> = {};
      const runsFor = async (issueId: string) => {
        try {
          return await ctx.db.query<{ id: string; status: string }>(
            "SELECT id, status FROM public.heartbeat_runs WHERE context_snapshot->>'issueId' = $1 ORDER BY created_at",
            [issueId],
          );
        } catch (e) {
          return [{ id: "query-error", status: errText(e) }];
        }
      };
      const mk = (title: string) =>
        ctx.issues.create({ companyId, title: `SPIKE model-capacity (plugin): ${title} (throwaway, do nothing)`, status: "todo" });
      const created: string[] = [];
      try {
        // 4. Can the plugin read heartbeat_runs?
        try {
          const rows = await ctx.db.query<{ status: string; n: number }>(
            "SELECT status, count(*)::int AS n FROM public.heartbeat_runs GROUP BY status",
          );
          out.db_read = { ok: true, rows };
        } catch (e) {
          out.db_read = { ok: false, error: errText(e) };
        }
        const blocker = await mk("blocker");
        created.push(blocker.id);
        const task = await mk("task");
        created.push(task.id);
        // 1. Gate through the SDK: add blocker, then assign (assignment wake should be skipped).
        await ctx.issues.relations.addBlockers(task.id, [blocker.id], companyId);
        await ctx.issues.update(task.id, { assigneeAgentId: agentId }, companyId);
        await new Promise((r) => setTimeout(r, 3000));
        out.gate_sdk_runs_after_assign = await runsFor(task.id);
        // requestWakeup while blocked should throw.
        try {
          out.wake_while_blocked = await ctx.issues.requestWakeup(task.id, companyId, { reason: "spike" });
        } catch (e) {
          out.wake_while_blocked = { threw: errText(e) };
        }
        // 2. Release: removeBlockers + requestWakeup.
        await ctx.issues.relations.removeBlockers(task.id, [blocker.id], companyId);
        try {
          out.release_wakeup = await ctx.issues.requestWakeup(task.id, companyId, { reason: "spike release" });
        } catch (e) {
          out.release_wakeup = { threw: errText(e) };
        }
        out.runs_after_release = await runsFor(task.id);
        // 3. Model override through the SDK (not in the TS type; the host passes it through).
        try {
          await ctx.issues.update(task.id, { assigneeAdapterOverrides: { adapterConfig: { model: "spike/model" } } } as never, companyId);
          const back = await ctx.issues.get(task.id, companyId);
          out.override_sdk = { readBack: back?.assigneeAdapterOverrides ?? null };
        } catch (e) {
          out.override_sdk = { threw: errText(e) };
        }
      } catch (e) {
        out.fatal = errText(e);
      }
      out.created = created;
      return out;
    });
  },
  async onHealth() {
    return { status: "ok", message: "spike worker running" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
