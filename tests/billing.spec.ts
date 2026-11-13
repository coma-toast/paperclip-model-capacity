import { generateKeyPairSync, createVerify } from "node:crypto";
import { describe, expect, it } from "vitest";

import { readBilledCost, validBillingTable } from "../src/billing.js";
import { summarizeBackends } from "../src/backends.js";
import { prepaidSpend } from "../src/usage.js";
import { providerQuotas } from "../src/upstream.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const keyJson = JSON.stringify({ client_email: "billing@p.iam.gserviceaccount.com", private_key: privateKey.export({ type: "pkcs8", format: "pem" }) });
const TABLE = "proj-1.billing_us.gcp_billing_export_focus_X";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("billing export", () => {
  it("signs a service-account token and reads the billed cost up to the export's last whole day", async () => {
    const calls: { url: string; body: string }[] = [];
    const fetch = async (url: string, init?: RequestInit) => {
      calls.push({ url, body: String(init?.body ?? "") });
      if (url.includes("oauth2")) return json({ access_token: "tok" });
      return json({ rows: [{ f: [{ v: "4.6614" }, { v: "1.7942688E9" }] }] });
    };
    const out = await readBilledCost(fetch, keyJson, { table: TABLE }, "2026-11-08", new Date("2026-11-10T12:00:00Z"));
    expect(out).toEqual({ amount: 4.6614, through: "2026-11-10T00:00:00.000Z" });

    // The JWT is RS256-signed by the key and asks only for read-only BigQuery.
    const assertion = new URLSearchParams(calls[0].body).get("assertion")!;
    const [h, p, sig] = assertion.split(".");
    expect(createVerify("RSA-SHA256").update(`${h}.${p}`).verify(publicKey, Buffer.from(sig, "base64url"))).toBe(true);
    expect(JSON.parse(Buffer.from(p, "base64url").toString())).toMatchObject({ iss: "billing@p.iam.gserviceaccount.com", scope: "https://www.googleapis.com/auth/bigquery.readonly" });

    // Service and date go in as query parameters; the table is the only thing in the SQL text.
    expect(calls[1].url).toBe("https://bigquery.googleapis.com/bigquery/v2/projects/proj-1/queries");
    const q = JSON.parse(calls[1].body);
    expect(q.query).toContain(`\`${TABLE}\``);
    expect(q.queryParameters).toEqual([
      expect.objectContaining({ name: "service", parameterValue: { value: "Gemini API" } }),
      expect.objectContaining({ name: "since", parameterValue: { value: "2026-11-08" } }),
    ]);
  });

  it("refuses a table name that isn't project.dataset.table, and reports Google's errors", async () => {
    expect(validBillingTable("a.b.c`; DROP")).toBe(false);
    await expect(readBilledCost(async () => json({}), keyJson, { table: "a.b" }, "2026-11-08", new Date())).rejects.toThrow(/project.dataset.table/);
    const denied = async (url: string) => (url.includes("oauth2") ? json({ access_token: "t" }) : json({ error: { message: "Access Denied" } }, 403));
    await expect(readBilledCost(denied, keyJson, { table: TABLE }, "2026-11-08", new Date())).rejects.toThrow(/403: Access Denied/);
    const badToken = async () => json({ error: "invalid_grant" }, 400);
    await expect(readBilledCost(badToken, keyJson, { table: TABLE }, "2026-11-08", new Date())).rejects.toThrow(/400 \(invalid_grant\)/);
  });

  it("returns nothing while the export has no rows for the service", async () => {
    const fetch = async (url: string) => (url.includes("oauth2") ? json({ access_token: "t" }) : json({ rows: [{ f: [{ v: "0" }, { v: null }] }] }));
    expect(await readBilledCost(fetch, keyJson, { table: TABLE }, "2026-11-08", new Date())).toBeUndefined();
  });
});

describe("prepaid credit with billed cost", () => {
  it("adds LiteLLM's estimate only from the billing cut-off on", async () => {
    const urls: string[] = [];
    const fetch = async (url: string) => { urls.push(url); return json([{ provider: "gemini", spend: 0.9 }, { provider: "openai", spend: 5 }]); };
    const deps = { fetch, logsHeaders: { Authorization: "Bearer x" }, now: () => new Date("2026-11-10T12:00:00Z") };
    const billed = await prepaidSpend("https://proxy", [{ provider: "gemini", credit: 10, since: "2026-11-08", billed: { amount: 4.66, through: "2026-11-10T00:00:00.000Z" } }], deps);
    expect(billed.gemini.used).toBeCloseTo(5.56);
    expect(billed.gemini.billedThrough).toBe("2026-11-10T00:00:00.000Z");
    expect(urls[0]).toContain("start_date=2026-11-10&end_date=2026-11-11");
    // Without billing it's LiteLLM's spend since the credit was loaded.
    const plain = await prepaidSpend("https://proxy", [{ provider: "gemini", credit: 10, since: "2026-11-08" }], deps);
    expect(plain.gemini).toEqual({ used: 0.9, credit: 10, since: "2026-11-08" });
    expect(urls[1]).toContain("start_date=2026-11-08");
  });

  it("says on the meter where the billed part ends", () => {
    const [m] = providerQuotas({ "gemini-pro": ["gemini/gemini-4-argon"] }, [], {}, {}, new Date(), {}, { gemini: { used: 5.56, credit: 10, billedThrough: "2026-11-10T00:00:00.000Z" } });
    expect(m.detail).toBe("Billed through 2026-11-10, LiteLLM's estimate since");
    expect(m.remaining).toBeCloseTo(4.44);
  });

  it("keeps the billing key binding out of what the UI sees", () => {
    const [b] = summarizeBackends({ backends: [{ id: "p", name: "P", type: "litellm", prepaid: [{ provider: "gemini", credit: 10, since: "2026-11-08", billing: { table: TABLE, key: { type: "secret_ref", secretId: "s1" } } }] }] });
    expect(b.prepaid?.[0].billing).toEqual({ table: TABLE });
  });
});
