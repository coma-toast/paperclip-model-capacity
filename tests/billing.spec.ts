import { describe, expect, it } from "vitest";

import { checkBigQueryPermission, readBilledCosts, billedCostsToMeters, resolveBillingConfig, type BigQueryPermissionResult, type BilledCostRow } from "../src/billing.js";

// Real PKCS#8 RSA-2048 private key (generated for testing; Google service account keys are RSA).
const TEST_PRIVATE_KEY =
  "-----BEGIN PRIVATE KEY-----\n" +
  "MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQCoyi4Y8JDZABJ5\n" +
  "1zyjwYo9bh88/Wnoj7dS+sC8uI/sZgc9UV15+dyR6fiBylIB04vLsw4VmmsqAHsq\n" +
  "MrbJemEbVKU/KLCucKaDxwI3w7/P7BrB9ueiQbLmHEr33K8YM4dkmEGMztBLVmo9\n" +
  "/Lm9B17ElVpgCDjFq9UCkJJGDsilDnDmiUepgnATh/NJIwjELLsTL5sVQUCfj4p4\n" +
  "vA8ox+ANWRMs4Sad3U0nOOSzx4xZgc/A0FrSUIE1gJrdJrkQd720oIGkQSW8jEVV\n" +
  "1Wd1FKfLfTZncm8PYmAKe5TTkuF5xucQICqoO1dpXr1vdKlwuYg+G7nrAQgEzZHs\n" +
  "qMJ2P9oDAgMBAAECggEANDLeYakX6nv6usJlBvGGGmxRbc+i7qBvXdKdQ1/CZqXA\n" +
  "7GYaxeuPGnLkfuL+TIFLFNJJc0XfiUw/yrOHUrStjkG1ntwrE69T16H2Xh+D1L3c\n" +
  "IosEZGnz9PTf/Fo7rfzVjLcHYo/c28ecMJJVMI+0b5AOtG8me38h71qdWdwdkelt\n" +
  "xRojTZnIN7DGQAMiQABQSFX+PaLUtQTh+yfe3iU8yNeoG7T5WUkKds18RJQ+9atm\n" +
  "AgRt+sUOAj48Z1po+4Vl/4YroaLnNwH9Rhy05dAy4jod2U4nYFVonGA1VoyRxZ8g\n" +
  "s4tj6sQs620+pP/PLpFzecHdmEc/BlhjWiBzuUeeOQKBgQDj16jwQo8o5yGyeIuk\n" +
  "ilEXumVidYQSUzh+jiSTrA89Vy1bDk+eQ7gbIP8CfTosLqIyIcc3yAW21n+Mgg1p\n" +
  "9uKUjGeu+1J+xuAXouI469t1TqRwSdqw2bLpUZH7NgNGILFWMJvlKie6fgKvTYkq\n" +
  "HT/AMMGqTHyvrGMZaWEr7g3c6QKBgQC9pj+EhGx+iSShF2isFrYTduyVQJHB2yvA\n" +
  "60G5NwjLDeASimLcMzyY/QZnpZQ/GBfIpmZ/2CpU3FBTphKnjL9zBke5v2CPmx/O\n" +
  "VU9QBuuSD8CXPIUVqtW68gUR5dZJQzvYuQQcY5gscEFVUwrtbrz4yVXmpGlPkM1T\n" +
  "Q30rvWL8CwKBgHBlkReFHi5lZwAt62VuPnbgIuehZVfM6g+0e2LF/HacLOnAc5J1\n" +
  "gbsQWfyWXj4xex4T/70K1ZbO1fkwpwFhI4F4iiWOIbIc1auTVNoTsB18gC5MoK+h\n" +
  "lVr4PHWavZ64vgLw09cHJrYfN5/XNhUqfKqI4uDp/pCDEBgXHjKXqwsRAoGAJcLJ\n" +
  "WOBpHdS+t1iK3eDzxfJi7uDZZMj38ESnZHKBzLRpjieBwahuA2Q190MvvlRUv/3p\n" +
  "4MCwxQ7M66rggf3zTLrOYzyoxE81yQaRcTS/iOicB0DkmsjWH4/61HJ39URu0Rsd\n" +
  "p21pKkf7qjqLrXTkKYElGnRYB6CkUVTZwnDGGbsCgYAr4xoc5Z3AXILMiZzCBxed\n" +
  "KwerMcObk15tBgb8DSQGPlQtyZyFZQ83g49m62F+ymDWj/EdpJa50j4frUSRCtbK\n" +
  "qqDCzAx5Ad+qNR6lN4gABtD13jJpNZl+yvbwQTqLg2YJn63GFHCN6lsTuTrxaPH3\n" +
  "h54gJ8RkONISO2xfGVwqxQ==\n" +
  "-----END PRIVATE KEY-----\n";

const FAKE_SA_KEY = {
  project_id: "test-project",
  client_email: "sa@test-project.iam.gserviceaccount.com",
  private_key: TEST_PRIVATE_KEY,
};

// A minimal fetch that mocks Google OAuth2 + BigQuery responses.
const makeBillingFetch = (options: {
  tokenStatus?: number;
  queryStatus?: number;
  queryRows?: { f: { v?: string }[] }[];
  queryError?: string;
  mostRecent?: string;
}) => {
  const json = (body: unknown) => JSON.stringify(body);
  return async (url: string, init?: RequestInit): Promise<Response> => {
    // Google OAuth2 token endpoint.
    if (url.includes("oauth2.googleapis.com/token")) {
      if (options.tokenStatus !== undefined && options.tokenStatus >= 400) {
        return new Response(json({ error: "invalid_grant" }), { status: options.tokenStatus });
      }
      return new Response(json({ access_token: "fake-token", expires_in: 3600 }), { status: 200 });
    }
    // BigQuery jobs endpoint (used by checkBigQueryPermission and readBilledCosts).
    if (url.includes("bigquery")) {
      // Permission/error responses.
      if (options.queryStatus !== undefined && options.queryStatus >= 400) {
        const errMap: Record<number, string> = {
          403: '{"error":{"message":"PERMISSION_DENIED: User does not have bigquery.jobs.create permission"}}',
          404: '{"error":{"message":"NOT_FOUND: Table test-project:test_dataset.billed_costs not found"}}',
        };
        return new Response(options.queryError ?? errMap[options.queryStatus] ?? `{"error":{"message":"Error"}}`, { status: options.queryStatus });
      }
      // Success: return job results with rows.
      const rowCount = options.queryRows?.[0]?.f?.[0]?.v ?? "0";
      const rows = options.queryRows ?? [{ f: [{ v: rowCount }] }];
      const isRowCountQuery = url.includes("COUNT") || url.includes("row_count");
      const isMonthQuery = url.includes("MAX(") || url.includes("most_recent");
      if (isMonthQuery) {
        return new Response(json({ kind: "bigquery#getQueryResultsResponse", jobComplete: true, rows: [{ f: [{ v: options.mostRecent ?? "2026-11" }] }], totalRows: "1" }), { status: 200 });
      }
      if (isRowCountQuery) {
        return new Response(json({ kind: "bigquery#getQueryResultsResponse", jobComplete: true, rows, totalRows: "1" }), { status: 200 });
      }
      // Fallback: return cost rows.
      return new Response(json({ kind: "bigquery#getQueryResultsResponse", jobComplete: true, rows: options.queryRows ?? [], totalRows: String(options.queryRows?.length ?? 0) }), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  };
};

describe("checkBigQueryPermission", () => {
  it("returns success with row count when access is granted", async () => {
    const fetch = makeBillingFetch({ queryRows: [{ f: [{ v: "12345" }] }] });
    const result = await checkBigQueryPermission(
      { serviceAccount: FAKE_SA_KEY, projectId: "test-project", datasetId: "test_dataset", tableName: "billed_costs" },
      fetch,
    );
    expect(result.ok).toBe(true);
    expect(result.rowCount).toBe(12345);
  });

  it("returns success with no rows when table is empty", async () => {
    const fetch = makeBillingFetch({ queryRows: [{ f: [{ v: "0" }] }] });
    const result = await checkBigQueryPermission(
      { serviceAccount: FAKE_SA_KEY, projectId: "test-project", datasetId: "test_dataset", tableName: "billed_costs" },
      fetch,
    );
    expect(result.ok).toBe(true);
    expect(result.rowCount).toBe(0);
  });

  it("returns permission denied error", async () => {
    const fetch = makeBillingFetch({ queryStatus: 403 });
    const result = await checkBigQueryPermission(
      { serviceAccount: FAKE_SA_KEY, projectId: "test-project", datasetId: "test_dataset", tableName: "billed_costs" },
      fetch,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Permission denied");
    expect(result.error).toContain("BigQuery Data Viewer");
  });

  it("returns not found error", async () => {
    const fetch = makeBillingFetch({ queryStatus: 404 });
    const result = await checkBigQueryPermission(
      { serviceAccount: FAKE_SA_KEY, projectId: "test-project", datasetId: "test_dataset", tableName: "billed_costs" },
      fetch,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Table not found");
  });

  it("returns OAuth2 error when token request fails", async () => {
    const fetch = makeBillingFetch({ tokenStatus: 400 });
    await expect(
      checkBigQueryPermission(
        { serviceAccount: FAKE_SA_KEY, projectId: "test-project", datasetId: "test_dataset", tableName: "billed_costs" },
        fetch,
      ),
    ).rejects.toThrow("OAuth2 token request failed");
  });
});

describe("readBilledCosts", () => {
  it("returns cost rows for current and previous month", async () => {
    const fetch = makeBillingFetch({
      queryStatus: 200,
      queryRows: [
        { f: [{ v: "gemini-2.5-pro" }, { v: "12.50" }, { v: "2026-11" }] },
        { f: [{ v: "gemini-2.5-flash" }, { v: "3.20" }, { v: "2026-11" }] },
        { f: [{ v: "gemini-2.5-pro" }, { v: "10.00" }, { v: "2026-10" }] },
      ],
    });
    const rows = await readBilledCosts(
      { serviceAccount: FAKE_SA_KEY, projectId: "test-project", datasetId: "test_dataset", tableName: "billed_costs" },
      fetch,
      new Date("2026-11-02T12:00:00Z"),
    );
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual({ model: "gemini-2.5-pro", cost_usd: 12.5, month: "2026-11" });
    expect(rows[1]).toEqual({ model: "gemini-2.5-flash", cost_usd: 3.2, month: "2026-11" });
    expect(rows[2]).toEqual({ model: "gemini-2.5-pro", cost_usd: 10.0, month: "2026-10" });
  });

  it("returns empty array when table has no cost data", async () => {
    const fetch = makeBillingFetch({ queryStatus: 200, queryRows: [] });
    const rows = await readBilledCosts(
      { serviceAccount: FAKE_SA_KEY, projectId: "test-project", datasetId: "test_dataset", tableName: "billed_costs" },
      fetch,
      new Date("2026-11-02T12:00:00Z"),
    );
    expect(rows).toHaveLength(0);
  });

  it("throws on BigQuery query failure", async () => {
    const fetch = makeBillingFetch({ queryStatus: 500, queryError: "Internal error" });
    await expect(
      readBilledCosts(
        { serviceAccount: FAKE_SA_KEY, projectId: "test-project", datasetId: "test_dataset", tableName: "billed_costs" },
        fetch,
        new Date("2026-11-02T12:00:00Z"),
      ),
    ).rejects.toThrow("BigQuery query failed (500)");
  });
});

describe("billedCostsToMeters", () => {
  it("groups costs by month and shows top models", () => {
    const rows: BilledCostRow[] = [
      { model: "gemini-2.5-pro", cost_usd: 12.5, month: "2026-11" },
      { model: "gemini-2.5-flash", cost_usd: 3.2, month: "2026-11" },
      { model: "gemini-2.5-pro", cost_usd: 10.0, month: "2026-10" },
    ];
    const meters = billedCostsToMeters(rows, "test-backend");
    expect(meters).toHaveLength(3); // 2 monthly + 1 total
    expect(meters[0].label).toBe("Billed cost (2026-11)");
    expect(meters[0].used).toBe(15.7);
    expect(meters[0].detail).toContain("gemini-2.5-pro");
    expect(meters[1].label).toBe("Billed cost (2026-10)");
    expect(meters[1].used).toBe(10.0);
    expect(meters[2].label).toBe("Total billed cost");
    expect(meters[2].used).toBe(25.7);
  });

  it("returns a single total meter when only one month of data", () => {
    const rows: BilledCostRow[] = [
      { model: "claude-sonnet-4", cost_usd: 5.0, month: "2026-10" },
    ];
    const meters = billedCostsToMeters(rows, "test-backend");
    expect(meters).toHaveLength(2); // 1 monthly + 1 total (same value)
    expect(meters[0].label).toBe("Billed cost (2026-10)");
    expect(meters[1].label).toBe("Total billed cost");
  });
});

describe("resolveBillingConfig", () => {
  it("returns null when billingConfig is undefined", async () => {
    const result = await resolveBillingConfig(undefined, { resolve: async () => "secret" });
    expect(result).toBeNull();
  });

  it("returns null when service account secret ref has no secretId", async () => {
    const result = await resolveBillingConfig({}, { resolve: async () => "secret" });
    expect(result).toBeNull();
  });

  it("resolves all secret refs and returns config", async () => {
    const billingConfig = {
      serviceAccountKey: { secretId: "sa-key-1" },
      projectId: { secretId: "project-1" },
      datasetId: { secretId: "dataset-1" },
      tableName: { secretId: "table-1" },
    };
    const resolvedSecrets: Record<string, string> = {
      "sa-key-1": JSON.stringify(FAKE_SA_KEY),
      "project-1": "test-project",
      "dataset-1": "test_dataset",
      "table-1": "billed_costs",
    };
    const result = await resolveBillingConfig(billingConfig, {
      resolve: async (secretId: string) => resolvedSecrets[secretId],
    });
    expect(result).not.toBeNull();
    expect(result!.projectId).toBe("test-project");
    expect(result!.datasetId).toBe("test_dataset");
    expect(result!.tableName).toBe("billed_costs");
    expect(result!.serviceAccount.project_id).toBe("test-project");
  });

  it("returns null when service account JSON is invalid", async () => {
    const billingConfig = {
      serviceAccountKey: { secretId: "sa-key-1" },
      projectId: { secretId: "project-1" },
      datasetId: { secretId: "dataset-1" },
      tableName: { secretId: "table-1" },
    };
    const result = await resolveBillingConfig(billingConfig, {
      resolve: async () => "not json",
    });
    expect(result).toBeNull();
  });

  it("returns null when SA key is missing required fields", async () => {
    const billingConfig = {
      serviceAccountKey: { secretId: "sa-key-1" },
      projectId: { secretId: "project-1" },
      datasetId: { secretId: "dataset-1" },
      tableName: { secretId: "table-1" },
    };
    const result = await resolveBillingConfig(billingConfig, {
      resolve: async (secretId: string) => {
        if (secretId === "sa-key-1") return JSON.stringify({ project_id: "test" }); // missing fields
        return "resolved";
      },
    });
    expect(result).toBeNull();
  });
});
