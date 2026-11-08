import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { Store } from "./state/store.js";
import type { OverrideRecord, IssueAssigneeAdapterOverrides } from "./types.js";
import { quotaTokenFor } from "./subscriptions.js";

export interface OverrideWriterDeps {
  ctx: PluginContext;
  store: Store;
  companyId?: string;
}

export function createOverrideWriter({ ctx, store, companyId }: OverrideWriterDeps) {
  const baseUrl = async () => {
    const config = await ctx.config.get(companyId ?? "c1");
    return typeof config.paperclipUrl === "string" && config.paperclipUrl.trim()
      ? config.paperclipUrl.trim()
      : "https://api.paperclip.ai";
  };

  const sdkUpdate = async (issueId: string, next: IssueAssigneeAdapterOverrides): Promise<void> => {
    await ctx.issues.update(
      issueId,
      { assigneeAdapterOverrides: next } as unknown as Parameters<typeof ctx.issues.update>[1],
      companyId ?? "c1"
    );
  };

  const restUpdate = async (issueId: string, next: IssueAssigneeAdapterOverrides): Promise<void> => {
    const auth = await quotaTokenFor(ctx, companyId ?? "c1");
    if (!auth) throw new Error("Board API token not configured");
    const url = `${await baseUrl()}/api/issues/${encodeURIComponent(issueId)}`;
    const res = await ctx.http.fetch(url, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${auth.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ assigneeAdapterOverrides: next }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`REST update failed (${res.status}): ${text.slice(0, 200)}`);
    }
  };

  const updateIssueOverride = async (issueId: string, next: IssueAssigneeAdapterOverrides): Promise<void> => {
    try {
      await sdkUpdate(issueId, next);
    } catch (e) {
      await restUpdate(issueId, next);
    }
  };

  return {
    async setOverride(issueId: string, model: string): Promise<void> {
      const issue = await ctx.issues.get(issueId, companyId ?? "c1");
      if (!issue) throw new Error(`Issue ${issueId} not found`);
      const original = issue.assigneeAdapterOverrides ?? null;
      const current = issue.assigneeAdapterOverrides ?? {};
      const next: IssueAssigneeAdapterOverrides = {
        ...current,
        adapterConfig: { ...(current.adapterConfig ?? {}), model },
      };
      await updateIssueOverride(issueId, next);
      const records = await store.overrides.get();
      records[issueId] = {
        issueId,
        agentId: issue.assigneeAgentId ?? "",
        model,
        original,
        fromPoolId: "",
        toPoolId: "",
        at: new Date().toISOString(),
      } satisfies OverrideRecord;
      await store.overrides.set(records);
    },

    async restoreOverride(issueId: string, originalOverride: IssueAssigneeAdapterOverrides | null): Promise<void> {
      const records = await store.overrides.get();
      const record = records[issueId];
      if (!record) return;
      const issue = await ctx.issues.get(issueId, companyId ?? "c1");
      if (issue && issue.assigneeAdapterOverrides?.adapterConfig?.model === record.model) {
        await updateIssueOverride(issueId, originalOverride ?? {});
      }
      delete records[issueId];
      await store.overrides.set(records);
    },
  };
}

export type OverrideWriter = ReturnType<typeof createOverrideWriter>;