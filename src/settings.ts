import { APIS, apiInfo, inferApi, type ApiKind } from "./apis.js";
import { DEFAULT_ALERT_AFTER_MINUTES } from "./constants.js";
import type { EngineKind, HostConfig, PoolConfig } from "./types.js";

export interface FieldError {
  field: string;
  message: string;
}

export type ValidationResult = { ok: true; pools: PoolConfig[] } | { ok: false; errors: FieldError[] };

const POOL_FIELDS = ["id", "name", "backend", "watch", "api", "prefix", "endpoint", "patterns", "limit", "limitFromEngines", "disabled", "sticky", "reassignAfterMinutes", "agentModel", "privacy", "mode", "scope", "companies", "hosts", "overflow", "overflowModel", "alertAfterMinutes"];
const HOST_FIELDS = ["id", "name", "engine", "baseUrl", "declaredSlots", "credential"];
const ENDPOINT_FIELDS = ["baseUrl", "credential", "slots"];
const OVERFLOW_FIELDS = ["pools", "afterMinutes", "whenHostsDown", "immediately"];
const ENGINES: readonly EngineKind[] = ["llamacpp", "ollama", "openai", "vllm", "lmstudio"];

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isWhole = (v: unknown, min: number) => typeof v === "number" && Number.isInteger(v) && v >= min;
const isText = (v: unknown) => typeof v === "string" && v.trim() !== "";
const isTextList = (v: unknown) => Array.isArray(v) && v.every(isText);

const isHttpUrl = (v: unknown) => {
  if (typeof v !== "string") return false;
  try {
    return ["http:", "https:"].includes(new URL(v).protocol);
  } catch {
    return false;
  }
};

const unknownFields = (obj: Record<string, unknown>, allowed: string[], at: string, errors: FieldError[]) => {
  for (const key of Object.keys(obj)) if (!allowed.includes(key)) errors.push({ field: `${at}.${key}`, message: "Unknown setting" });
};

const validateHost = (raw: unknown, at: string, errors: FieldError[]): HostConfig | undefined => {
  if (!isObject(raw)) return void errors.push({ field: at, message: "Must be an object" });
  unknownFields(raw, HOST_FIELDS, at, errors);
  if (!isText(raw.id)) errors.push({ field: `${at}.id`, message: "Required" });
  if (!isText(raw.name)) errors.push({ field: `${at}.name`, message: "Required" });
  if (!ENGINES.includes(raw.engine as EngineKind)) errors.push({ field: `${at}.engine`, message: `Must be one of ${ENGINES.join(", ")}` });
  if (!isHttpUrl(raw.baseUrl)) errors.push({ field: `${at}.baseUrl`, message: "Must be an http(s) URL" });
  if (!isWhole(raw.declaredSlots ?? 1, 1)) errors.push({ field: `${at}.declaredSlots`, message: "Must be a whole number, 1 or more" });
  return { ...(raw as unknown as HostConfig), declaredSlots: (raw.declaredSlots as number | undefined) ?? 1 };
};

// Limits, privacy, mode, alerting and overflow: the same for every pool, with or without a backend.
const validateCommon = (raw: Record<string, unknown>, at: string, errors: FieldError[]) => {
  if (!isWhole(raw.limit, 0)) errors.push({ field: `${at}.limit`, message: "Must be a whole number, 0 or more" });
  if (raw.disabled !== undefined && typeof raw.disabled !== "boolean") errors.push({ field: `${at}.disabled`, message: "Must be true or false" });
  if (raw.limitFromEngines !== undefined && typeof raw.limitFromEngines !== "boolean") errors.push({ field: `${at}.limitFromEngines`, message: "Must be true or false" });
  if (!["private", "shared"].includes(raw.privacy as string)) errors.push({ field: `${at}.privacy`, message: "Must be private or shared" });
  if (raw.mode !== undefined && !["observe", "enforce"].includes(raw.mode as string)) errors.push({ field: `${at}.mode`, message: "Must be observe or enforce" });
  if (raw.scope !== undefined && !["instance", "company"].includes(raw.scope as string)) errors.push({ field: `${at}.scope`, message: "Must be instance or company" });
  if (raw.companies !== undefined) {
    const c = raw.companies;
    if (!isObject(c) || (c.include !== undefined && !isTextList(c.include)) || (c.exclude !== undefined && !isTextList(c.exclude))) {
      errors.push({ field: `${at}.companies`, message: "include and exclude must be lists of company ids" });
    }
  }
  if (raw.alertAfterMinutes !== undefined && !isWhole(raw.alertAfterMinutes, 1)) errors.push({ field: `${at}.alertAfterMinutes`, message: "Must be a whole number, 1 or more" });
  if (raw.overflowModel !== undefined && !isText(raw.overflowModel)) errors.push({ field: `${at}.overflowModel`, message: "Must be text" });
  if (raw.overflow !== undefined) {
    if (!isObject(raw.overflow)) errors.push({ field: `${at}.overflow`, message: "Must be an object" });
    else {
      unknownFields(raw.overflow, OVERFLOW_FIELDS, `${at}.overflow`, errors);
      if (!isTextList(raw.overflow.pools)) errors.push({ field: `${at}.overflow.pools`, message: "Must be a list of pool ids" });
      if (raw.overflow.afterMinutes !== undefined && !isWhole(raw.overflow.afterMinutes, 1)) errors.push({ field: `${at}.overflow.afterMinutes`, message: "Must be a whole number, 1 or more" });
    }
  }
};

// A7 plus A9 defaults: rejects unknown fields, duplicate names and ids, bad limits, and overflow that breaks privacy (A10).
export const validatePools = (input: unknown): ValidationResult => {
  const errors: FieldError[] = [];
  if (!Array.isArray(input)) return { ok: false, errors: [{ field: "pools", message: "Must be a list" }] };
  const pools: PoolConfig[] = [];
  const ids = new Set<string>();
  const names = new Set<string>();
  const hostIds = new Set<string>();
  input.forEach((raw, i) => {
    const at = `pools[${i}]`;
    if (!isObject(raw)) return void errors.push({ field: at, message: "Must be an object" });
    unknownFields(raw, POOL_FIELDS, at, errors);
    if (!isText(raw.id)) errors.push({ field: `${at}.id`, message: "Required" });
    else if (ids.has(String(raw.id).toLowerCase())) errors.push({ field: `${at}.id`, message: `Another pool already uses the id "${raw.id}"` });
    if (!isText(raw.name)) errors.push({ field: `${at}.name`, message: "Required" });
    else if (names.has(String(raw.name).toLowerCase())) errors.push({ field: `${at}.name`, message: `Another pool is already named "${raw.name}"` });
    ids.add(String(raw.id).toLowerCase());
    names.add(String(raw.name).toLowerCase());
    if (!isTextList(raw.patterns) || !(raw.patterns as string[]).length) errors.push({ field: `${at}.patterns`, message: "Pick at least one model" });
    else if ((raw.patterns as string[]).some((p) => /[*?]/.test(p))) errors.push({ field: `${at}.patterns`, message: "Pick models from the list; wildcards aren't used" });
    if (raw.backend !== undefined && !isText(raw.backend)) errors.push({ field: `${at}.backend`, message: "Pick a backend" });
    if (raw.watch !== undefined && !(Array.isArray(raw.watch) && raw.watch.every(isText))) errors.push({ field: `${at}.watch`, message: "Must be a list of backends" });
    if (raw.sticky !== undefined) {
      const sticky = raw.sticky;
      const patterns = isTextList(raw.patterns) ? (raw.patterns as string[]) : [];
      if (!Array.isArray(sticky) || !sticky.every((t) => isObject(t) && isText(t.model) && isText(t.engine))) {
        errors.push({ field: `${at}.sticky`, message: "Each engine entry needs a model and an engine" });
      } else if (new Set(sticky.map((t) => t.model)).size !== sticky.length) {
        errors.push({ field: `${at}.sticky`, message: "Each model can reach only one engine" });
      } else if (sticky.some((t) => !patterns.includes(t.model as string))) {
        errors.push({ field: `${at}.sticky`, message: "Every model tied to an engine must be one of the pool's models" });
      }
    }
    if (raw.agentModel !== undefined && !(isText(raw.agentModel) && isTextList(raw.patterns) && (raw.patterns as string[]).includes(raw.agentModel as string))) {
      errors.push({ field: `${at}.agentModel`, message: "Must be one of the pool's models" });
    }
    if (raw.reassignAfterMinutes !== undefined && !isWhole(raw.reassignAfterMinutes, 1)) errors.push({ field: `${at}.reassignAfterMinutes`, message: "Must be a whole number of minutes, 1 or more" });
    // With a backend, the API, prefix and address come from it (checked against the company's backends on save).
    if (isText(raw.backend)) {
      pools.push({ ...(raw as unknown as PoolConfig), mode: (raw.mode as PoolConfig["mode"]) ?? "observe", scope: "instance", hosts: [], alertAfterMinutes: (raw.alertAfterMinutes as number | undefined) ?? DEFAULT_ALERT_AFTER_MINUTES });
      validateCommon(raw, at, errors);
      return;
    }
    const api: ApiKind = raw.api === undefined ? inferApi(isTextList(raw.patterns) ? (raw.patterns as string[]) : []) : (raw.api as ApiKind);
    if (!APIS.some((a) => a.kind === api)) errors.push({ field: `${at}.api`, message: `Must be one of ${APIS.map((a) => a.kind).join(", ")}` });
    else {
      const info = apiInfo(api);
      if (raw.prefix !== undefined && typeof raw.prefix !== "string") errors.push({ field: `${at}.prefix`, message: "Must be text" });
      const prefix = typeof raw.prefix === "string" ? raw.prefix : info.defaultPrefix;
      const foreign = isTextList(raw.patterns) ? (raw.patterns as string[]).filter((p) => prefix && !p.startsWith(prefix)) : [];
      if (foreign.length) errors.push({ field: `${at}.patterns`, message: `This pool's models start with ${prefix}; ${foreign.join(", ")} belongs in a pool for its own API` });
      if ((info.group === "cloud" || info.group === "local") && Array.isArray(raw.hosts) && raw.hosts.length) {
        errors.push({ field: `${at}.hosts`, message: info.group === "cloud" ? `${info.label} is a cloud API: there are no backends to watch` : `${info.label} is checked directly at its address; it has no separate backends` });
      }
      const endpoint = raw.endpoint;
      if (endpoint !== undefined && !isObject(endpoint)) errors.push({ field: `${at}.endpoint`, message: "Must be an object" });
      else {
        if (endpoint) unknownFields(endpoint, ENDPOINT_FIELDS, `${at}.endpoint`, errors);
        const url = endpoint?.baseUrl;
        if (url !== undefined && url !== "" && !isHttpUrl(url)) errors.push({ field: `${at}.endpoint.baseUrl`, message: "Must be an http(s) URL" });
        if (info.group === "local" && !isHttpUrl(url)) errors.push({ field: `${at}.endpoint.baseUrl`, message: `Enter the ${info.label} server's address, e.g. ${info.placeholderUrl}` });
        if (endpoint?.credential !== undefined && endpoint.credential !== "" && !isText(endpoint.credential)) errors.push({ field: `${at}.endpoint.credential`, message: "Must be a credential name" });
        if (endpoint?.slots !== undefined && !isWhole(endpoint.slots, 1)) errors.push({ field: `${at}.endpoint.slots`, message: "Must be a whole number, 1 or more" });
      }
    }
    validateCommon(raw, at, errors);
    const hosts = Array.isArray(raw.hosts) ? raw.hosts.map((h, j) => validateHost(h, `${at}.hosts[${j}]`, errors)) : [];
    if (raw.hosts !== undefined && !Array.isArray(raw.hosts)) errors.push({ field: `${at}.hosts`, message: "Must be a list" });
    hosts.forEach((h, j) => {
      if (!h || !isText(h.id)) return;
      if (hostIds.has(h.id)) errors.push({ field: `${at}.hosts[${j}].id`, message: `Another host already uses the id "${h.id}"` });
      hostIds.add(h.id);
    });
    pools.push({
      ...(raw as unknown as PoolConfig),
      api,
      mode: (raw.mode as PoolConfig["mode"]) ?? "observe",
      scope: (raw.scope as PoolConfig["scope"]) ?? "instance",
      hosts: hosts.filter((h): h is HostConfig => Boolean(h)),
      alertAfterMinutes: (raw.alertAfterMinutes as number | undefined) ?? DEFAULT_ALERT_AFTER_MINUTES,
    });
  });

  // Overflow targets must exist, can't be the pool itself, and private work never overflows to a shared pool (A10).
  const byId = new Map(pools.map((p) => [p.id, p]));
  pools.forEach((p, i) => {
    (p.overflow?.pools ?? []).forEach((target, j) => {
      const field = `pools[${i}].overflow.pools[${j}]`;
      const to = byId.get(target);
      if (!to) errors.push({ field, message: `No pool with id "${target}"` });
      else if (to.id === p.id) errors.push({ field, message: "A pool can't overflow to itself" });
      else if (p.privacy === "private" && to.privacy === "shared") errors.push({ field, message: `Private pool "${p.name}" can't overflow to shared pool "${to.name}"` });
    });
  });
  return errors.length ? { ok: false, errors } : { ok: true, pools };
};
