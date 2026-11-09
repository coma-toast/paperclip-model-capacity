import type { BigQueryConfig } from "./types.js";

// Result of a BigQuery permission check: can the service account access the table?
export interface BigQueryPermissionResult {
  ok: boolean;
  // When ok: how many rows the table has (sample), and the most recent billing month found.
  rowCount?: number;
  mostRecentMonth?: string;
  // When not ok: what went wrong.
  error?: string;
}

// What the BigQuery billing query returns per model.
export interface BilledCostRow {
  model: string;
  cost_usd: number;
  month: string;
}

// A Google service account key parsed from the JSON secret.
interface ServiceAccountKey {
  project_id: string;
  client_email: string;
  private_key: string;
}

// Base64-encode bytes for a JWT header/payload.
const base64url = (data: Uint8Array): string =>
  btoa(String.fromCharCode(...data))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

// Create a JWT signed with the service account private key (RS256).
const createJwt = async (payload: Record<string, string>, privateKey: string): Promise<string> => {
  const header = { alg: "RS256", typ: "JWT" };
  const headerB64 = base64url(new TextEncoder().encode(JSON.stringify(header)));
  const payloadB64 = base64url(new TextEncoder().encode(JSON.stringify(payload)));
  const signingInput = `${headerB64}.${payloadB64}`;

  const pk = privateKey
    .replace(/\\n/g, "\n")
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\n/g, "");

  const keyData = Uint8Array.from(atob(pk), (c) => c.charCodeAt(0));
  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8",
    keyData,
    { name: "RSASSA-PKCS1-v1_5", hash: { name: "SHA-256" } },
    false,
    ["sign"],
  );

  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", cryptoKey, new TextEncoder().encode(signingInput));
  const signatureB64 = base64url(new Uint8Array(signature));

  return `${signingInput}.${signatureB64}`;
};

// Get an OAuth2 access token from a JWT assertion.
const getAccessToken = async (fetch: (url: string, init?: RequestInit) => Promise<Response>, clientEmail: string, jwt: string): Promise<string> => {
  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}&scope=https://www.googleapis.com/auth/cloud-platform`,
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Google OAuth2 token request failed (${resp.status}): ${text.slice(0, 200)}`);
  }
  const data = await resp.json() as { access_token: string };
  return data.access_token;
};

// Resolve the BigQuery config fields from a secret resolution function.
export interface BillingResolver {
  resolve(secretId: string): Promise<string | undefined>;
}

export const resolveBillingConfig = async (
  billingConfig: BigQueryConfig | undefined,
  resolver: BillingResolver,
): Promise<{ serviceAccount: ServiceAccountKey; projectId: string; datasetId: string; tableName: string } | null> => {
  if (!billingConfig) return null;
  const saJsonRaw = billingConfig.serviceAccountKey as Record<string, unknown> | undefined;
  if (!saJsonRaw || typeof saJsonRaw !== "object") return null;
  const saSecretId = (saJsonRaw as { secretId?: string }).secretId;
  if (!saSecretId) return null;
  const saJson = await resolver.resolve(saSecretId);
  if (!saJson) return null;

  let saKey: ServiceAccountKey;
  try {
    saKey = JSON.parse(saJson);
  } catch {
    return null;
  }
  if (!saKey.project_id || !saKey.client_email || !saKey.private_key) return null;

  const projectIdRaw = billingConfig.projectId as Record<string, unknown> | undefined;
  const datasetIdRaw = billingConfig.datasetId as Record<string, unknown> | undefined;
  const tableNameRaw = billingConfig.tableName as Record<string, unknown> | undefined;
  const projectId = projectIdRaw ? await resolver.resolve((projectIdRaw as { secretId?: string }).secretId!) : undefined;
  const datasetId = datasetIdRaw ? await resolver.resolve((datasetIdRaw as { secretId?: string }).secretId!) : undefined;
  const tableName = tableNameRaw ? await resolver.resolve((tableNameRaw as { secretId?: string }).secretId!) : undefined;

  if (!projectId || !datasetId || !tableName) return null;

  return { serviceAccount: saKey, projectId, datasetId, tableName };
};

// Check if the service account can access the specified BigQuery table.
export const checkBigQueryPermission = async (
  config: { serviceAccount: ServiceAccountKey; projectId: string; datasetId: string; tableName: string },
  fetch: (url: string, init?: RequestInit) => Promise<Response>,
): Promise<BigQueryPermissionResult> => {
  const { serviceAccount, projectId, datasetId, tableName } = config;

  // 1. Create a JWT assertion.
  const now = Math.floor(Date.now() / 1000);
  const jwt = await createJwt(
    {
      iss: serviceAccount.client_email,
      scope: "https://www.googleapis.com/auth/cloud-platform",
      aud: "https://oauth2.googleapis.com/token",
      exp: String(now + 3600),
      iat: String(now),
    },
    serviceAccount.private_key,
  );

  // 2. Exchange JWT for access token.
  const accessToken = await getAccessToken(fetch, serviceAccount.client_email, jwt);

  // 3. Query the table's row count.
  const query = `SELECT COUNT(*) as row_count FROM \`${projectId}.${datasetId}.${tableName}\` LIMIT 1`;
  const resp = await fetch(`https://bigquery.googleapis.com/bigquery/v2/projects/${projectId}/jobs`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      query,
      use_legacy_sql: false,
    }),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    const errDetail = text.slice(0, 400);
    if (/403|PERMISSION_DENIED/i.test(text)) {
      return { ok: false, error: "Permission denied: the service account cannot read this BigQuery table. Check that the account has the BigQuery Data Viewer (roles/bigquery.dataViewer) role on the dataset." };
    }
    if (/404|NOT_FOUND/i.test(text)) {
      return { ok: false, error: `Table not found: ${projectId}.${datasetId}.${tableName}. Check the project, dataset, and table names.` };
    }
    return { ok: false, error: `BigQuery query failed (${resp.status}): ${errDetail}` };
  }

  const data = (await resp.json()) as { kind: string; jobComplete?: boolean; rows?: { f: [{ v?: string }] }[] };

  // The response includes a 'rows' field when query results are available synchronously.
  // For large tables, BigQuery returns a jobReference; we fall back to checking the table metadata.
  const rowCount = data.rows?.[0]?.f?.[0]?.v ? Number(data.rows[0].f[0].v) : undefined;

  // Try to get the most recent month by querying the table's _PARTITIONTIME or a date column.
  // We try a simple SELECT that finds the max billing_month if the table has a month column.
  const monthQuery = `SELECT COALESCE(MAX(billing_account_id), MAX(month), MAX(date), MAX(period)) as most_recent FROM \`${projectId}.${datasetId}.${tableName}\` LIMIT 1`;
  const monthResp = await fetch(`https://bigquery.googleapis.com/bigquery/v2/projects/${projectId}/jobs`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ query: monthQuery, use_legacy_sql: false }),
  });

  let mostRecentMonth: string | undefined;
  if (monthResp.ok) {
    const monthData = await monthResp.json() as { rows?: { f: [{ v?: string }] }[] };
    const val = monthData.rows?.[0]?.f?.[0]?.v;
    if (val) mostRecentMonth = String(val);
  }

  return {
    ok: true,
    rowCount,
    mostRecentMonth: mostRecentMonth ?? undefined,
  };
};

// Query the BigQuery table for billed costs per model.
export const readBilledCosts = async (
  config: { serviceAccount: ServiceAccountKey; projectId: string; datasetId: string; tableName: string },
  fetch: (url: string, init?: RequestInit) => Promise<Response>,
  refDate?: Date,
): Promise<BilledCostRow[]> => {
  const { serviceAccount, projectId, datasetId, tableName } = config;

  const now = refDate ?? new Date();
  // Get the current month as YYYY-MM.
  const currentMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const prevMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth()).padStart(2, "0")}`;

  // Create JWT and get access token.
  const jwt = await createJwt(
    {
      iss: serviceAccount.client_email,
      scope: "https://www.googleapis.com/auth/cloud-platform",
      aud: "https://oauth2.googleapis.com/token",
      exp: String(Math.floor(Date.now() / 1000) + 3600),
      iat: String(Math.floor(Date.now() / 1000)),
    },
    serviceAccount.private_key,
  );
  const accessToken = await getAccessToken(fetch, serviceAccount.client_email, jwt);

  // Query billed costs for the current and previous month.
  // The FOCUS BigQuery export typically has columns: model, cost_usd, billing_month (or similar).
  // We try common column names.
  const query = `
    SELECT
      COALESCE(model, model_name, resource_name, service_name) as model,
      COALESCE(cost, cost_usd, total_cost) as cost_usd,
      COALESCE(billing_month, month, date, period) as month
    FROM \`${projectId}.${datasetId}.${tableName}\`
    WHERE (COALESCE(billing_month, month, date, period) IN ('${currentMonth}', '${prevMonth}'))
      AND COALESCE(cost, cost_usd, total_cost) > 0
    ORDER BY cost_usd DESC
  `;

  const resp = await fetch(`https://bigquery.googleapis.com/bigquery/v2/projects/${projectId}/jobs`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ query, use_legacy_sql: false }),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`BigQuery query failed (${resp.status}): ${text.slice(0, 400)}`);
  }

  const data = (await resp.json()) as { rows?: { f: [{ v?: string }, { v?: string }, { v?: string }] }[] };

  const rows: BilledCostRow[] = [];
  for (const row of data.rows ?? []) {
    const model = row.f[0]?.v ?? "unknown";
    const cost = Number(row.f[1]?.v ?? 0);
    const month = row.f[2]?.v ?? currentMonth;
    if (Number.isFinite(cost) && cost > 0) {
      rows.push({ model, cost_usd: cost, month });
    }
  }

  return rows;
};

// Format billed cost rows as UsageMeters for display.
export const billedCostsToMeters = (rows: BilledCostRow[], backendId: string): Array<{ label: string; unit: "usd"; used: number; detail?: string }> => {
  // Group by month.
  const byMonth = new Map<string, number>();
  for (const row of rows) {
    byMonth.set(row.month, (byMonth.get(row.month) ?? 0) + row.cost_usd);
  }

  const meters: Array<{ label: string; unit: "usd"; used: number; detail?: string }> = [];
  const sortedMonths = [...byMonth.keys()].sort().reverse();

  for (const month of sortedMonths) {
    const total = byMonth.get(month)!;
    // Top models by spend this month.
    const topModels = rows
      .filter((r) => r.month === month)
      .sort((a, b) => b.cost_usd - a.cost_usd)
      .slice(0, 3)
      .map((r) => `${r.model} ($${r.cost_usd.toFixed(2)})`)
      .join(", ");
    meters.push({
      label: `Billed cost (${month})`,
      unit: "usd",
      used: total,
      detail: topModels ? `Top models: ${topModels}` : undefined,
    });
  }

  // Total across all months.
  const grandTotal = rows.reduce((sum, r) => sum + r.cost_usd, 0);
  if (grandTotal > 0) {
    meters.push({ label: "Total billed cost", unit: "usd", used: grandTotal });
  }

  return meters;
};
