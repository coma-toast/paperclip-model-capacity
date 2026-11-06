import { describe, expect, it } from "vitest";

import { alertSummary } from "../src/ui/components/poolTiles.js";

describe("alertSummary", () => {
  it("totals open alerts and counts the pools that have any", () => {
    expect(alertSummary([{ openAlerts: 10 }, { openAlerts: 0 }, { openAlerts: 8 }, { openAlerts: 3 }])).toEqual({ total: 21, pools: 3 });
  });

  it("is empty when no pool has alerts", () => {
    expect(alertSummary([{ openAlerts: 0 }, { openAlerts: 0 }])).toEqual({ total: 0, pools: 0 });
  });
});
