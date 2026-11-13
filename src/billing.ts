import { createSign } from "node:crypto";

import type { FetchFn } from "./probes/http.js";

// A prepaid credit's real drawdown, from the provider's Cloud Billing export (FOCUS format) in BigQuery: what was billed
// (after discounts and promotional credits) for one service. The export lags by hours, so only whole UTC days are
// read; the caller adds LiteLLM's own estimate from `through` on.
export interface PrepaidBilling {
  // A company secret holding a Google service-account key (JSON) with BigQuery read access to the export.
  key?: unknown;
  // project.dataset.table of the FOCUS export.
  table: string;
  // The FOCUS ServiceName to count, e.g. "Gemini API".
  service?: string;
  // The dataset's location, e.g. "US".
  location?: string;
}

export interface BilledCost {
  // Billed since the credit was loaded, up to `through`.
  amount: number;
  // Start of the first UTC day not counted (ISO).
  through: string;
}

const TABLE_RE = /^[\w-]+\.[\w-]+\.[\w-]+$/;
export const validBillingTable = (t: unknown): t is string => typeof t === "string" && TABLE_RE.test(t);

const b64 = (s: string | Buffer) => Buffer.from(s).toString("base64url");

// An OAuth token for a service account (JWT bearer grant), read-only BigQuery scope.
export const serviceAccountToken = async (fetch: FetchFn, keyJson: string, now: Date): Promise<string> => {
  const sa = JSON.parse(keyJson) as { client_email?: string; private_key?: string; token_uri?: string };
  if (!sa.client_email || !sa.private_key) throw new Error("the billing key isn't a service-account key");
  const iat = Math.floor(now.getTime() / 1000);
  const aud = sa.token_uri ?? "https://oauth2.googleapis.com/token";
  const unsigned = `${b64(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64(JSON.stringify({ iss: sa.client_email, scope: "https://www.googleapis.com/auth/bigquery.readonly", aud, iat, exp: iat + 600 }))}`;
  const signature = createSign("RSA-SHA256").update(unsigned).sign(sa.private_key).toString("base64url");
  const res = await fetch(aud, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: `grant_type=${encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer")}&assertion=${unsigned}.${signature}`,
  });
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; error?: string };
  if (!res.ok || !body.access_token) throw new Error(`Google token request returned ${res.status}${body.error ? ` (${body.error})` : ""}`);
  return body.access_token;
};

// The billed cost of `service` from `since` to the start of the export's last (partial) UTC day.
export const BILLED_SQL = (table: string) =>
  `WITH t AS (SELECT * FROM \`${table}\` WHERE ServiceName = @service), ` +
  `cut AS (SELECT TIMESTAMP_TRUNC(MAX(ChargePeriodEnd), DAY) AS d FROM t) ` +
  `SELECT IFNULL(SUM(BilledCost), 0) AS billed, ANY_VALUE(cut.d) AS through FROM cut LEFT JOIN t ` +
  `ON t.ChargePeriodStart >= TIMESTAMP(@since) AND t.ChargePeriodEnd <= cut.d`;

export const readBilledCost = async (
  fetch: FetchFn, keyJson: string, billing: PrepaidBilling, since: string, now: Date,
): Promise<BilledCost | undefined> => {
  if (!validBillingTable(billing.table)) throw new Error(`billing table "${String(billing.table)}" isn't project.dataset.table`);
  const token = await serviceAccountToken(fetch, keyJson, now);
  const project = billing.table.split(".")[0];
  const res = await fetch(`https://bigquery.googleapis.com/bigquery/v2/projects/${project}/queries`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      useLegacySql: false,
      location: billing.location ?? "US",
      query: BILLED_SQL(billing.table),
      parameterMode: "NAMED",
      queryParameters: [
        { name: "service", parameterType: { type: "STRING" }, parameterValue: { value: billing.service ?? "Gemini API" } },
        { name: "since", parameterType: { type: "STRING" }, parameterValue: { value: since.slice(0, 10) } },
      ],
    }),
  });
  const body = (await res.json().catch(() => ({}))) as { rows?: { f: { v: unknown }[] }[]; error?: { message?: string } };
  if (!res.ok) throw new Error(`BigQuery returned ${res.status}${body.error?.message ? `: ${body.error.message.slice(0, 160)}` : ""}`);
  const [billed, through] = body.rows?.[0]?.f.map((c) => c.v) ?? [];
  // BigQuery's REST API gives timestamps as epoch seconds in a string; no export rows yet means no cut-off.
  if (through === null || through === undefined) return undefined;
  const ms = Number(through) * 1000;
  if (!Number.isFinite(ms)) return undefined;
  return { amount: Number(billed) || 0, through: new Date(ms).toISOString() };
};
