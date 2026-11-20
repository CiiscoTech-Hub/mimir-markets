import assert from "node:assert/strict";
import test from "node:test";
import {
  baselineAtomic,
  buildOwnerRevenueStatement,
  getRevenueSummary,
  recordPayment,
  type PaymentEvent,
} from "../../lib/paid-revenue";

const USDC_SAC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const OWNER = "GBMGZBFKUNOS7JWPRPF5IMZR27DCR6BEP6SQVFV2I354UPY35FZTIR2Y";
const OTHER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const PAYER = "GDZCBCIU6EI5FM5UC5IAWRT5ZY76OK4QDX5BEELC5V3NTNGAUIX5X4UH";

function makeEvent(overrides: Partial<PaymentEvent> = {}): PaymentEvent {
  return {
    resource: "/api/premium/signal",
    scheme: "exact",
    network: "stellar:testnet",
    assetAddress: USDC_SAC,
    amountAtomic: 1_000_000n,
    payer: PAYER,
    seller: OWNER,
    transactionHash: "tx-1",
    paymentIdentifier: `pay-${Math.random().toString(36).slice(2)}`,
    facilitator: "mimir",
    settledAt: 1_780_000_000_000,
    ...overrides,
  };
}

test("owner revenue statement serializes exact atomic strings with explicit decimals and no float drift", () => {
  const events: PaymentEvent[] = [
    // Classic IEEE-754 float trap (0.1 + 0.2) plus 7th-decimal stroop increments
    makeEvent({ paymentIdentifier: "p-1", resource: "/api/a", amountAtomic: 1_000_001n, settledAt: 100 }),
    makeEvent({ paymentIdentifier: "p-2", resource: "/api/a", amountAtomic: 2_000_002n, settledAt: 200 }),
    // Beyond Number.MAX_SAFE_INTEGER to prove integer accumulation never loses precision
    makeEvent({ paymentIdentifier: "p-3", resource: "/api/b", amountAtomic: 9_007_199_254_740_993n, settledAt: 300 }),
    makeEvent({ paymentIdentifier: "p-4", resource: "/api/b", amountAtomic: 2n, settledAt: 400 }),
    // Different seller and case-folded seller must be excluded
    makeEvent({ paymentIdentifier: "p-other", seller: OTHER, amountAtomic: 50_000_000n }),
    makeEvent({ paymentIdentifier: "p-lower", seller: OWNER.toLowerCase(), amountAtomic: 50_000_000n }),
  ];

  const statement = buildOwnerRevenueStatement({ owner: OWNER, paymentEvents: events });
  assert.equal(statement.owner, OWNER);
  assert.equal(statement.assetSymbol, "USDC");
  assert.equal(statement.assetDecimals, 7);
  assert.equal(statement.totalCalls, 4);
  assert.equal(statement.totalAtomic, "9007199257740998");
  assert.equal(statement.uniquePayers, 1);
  assert.equal(statement.byResource[0]?.resource, "/api/b");
  assert.equal(statement.byResource[0]?.amountAtomic, "9007199254740995");
  assert.equal(statement.byResource[1]?.resource, "/api/a");
  assert.equal(statement.byResource[1]?.amountAtomic, "3000003");
  assert.equal(statement.payments[0]?.amountAtomic, "2");
  assert.equal(statement.payments[0]?.assetDecimals, 7);
  assert.doesNotThrow(() => JSON.stringify(statement));
});

test("owner revenue statement rejects negative atomic amounts", () => {
  assert.throws(
    () => buildOwnerRevenueStatement({
      owner: OWNER,
      paymentEvents: [makeEvent({ paymentIdentifier: "p-neg", amountAtomic: -1n })],
    }),
    /Invalid atomic payment amount/,
  );
});

test("baselineAtomic parses exact 7-decimal strings and fails safe to 0n on invalid inputs", () => {
  assert.equal(baselineAtomic({ PAYMENTS_BASELINE_USDC: "12.3456789" }), 123_456_789n);
  assert.equal(baselineAtomic({ PAYMENTS_BASELINE_USDC: "0.0000001" }), 1n);
  assert.equal(baselineAtomic({ PAYMENTS_BASELINE_USDC: "" }), 0n);
  assert.equal(baselineAtomic({ PAYMENTS_BASELINE_USDC: "-5" }), 0n);
  assert.equal(baselineAtomic({ PAYMENTS_BASELINE_USDC: "1.12345678" }), 0n);
  assert.equal(baselineAtomic({ PAYMENTS_BASELINE_USDC: "not-a-number" }), 0n);
});

test("getRevenueSummary exposes exact atomic strings and adds baseline without float rounding", async () => {
  const prevDb = process.env.DATABASE_URL;
  const prevBaseline = process.env.PAYMENTS_BASELINE_USDC;
  delete process.env.DATABASE_URL;
  process.env.PAYMENTS_BASELINE_USDC = "0.0000003";
  try {
    await recordPayment(makeEvent({
      paymentIdentifier: "summary-exact-1",
      resource: "/api/premium/exact",
      amountAtomic: 1_000_001n,
    }));
    await recordPayment(makeEvent({
      paymentIdentifier: "summary-exact-2",
      resource: "/api/premium/exact",
      amountAtomic: 2_000_002n,
    }));

    const summary = await getRevenueSummary(10);
    assert.equal(summary.assetDecimals, 7);
    assert.equal(summary.baselineAtomic, "3");
    assert.equal(summary.totalAtomic, "3000006");
    assert.equal(summary.byResource[0]?.amountAtomic, "3000003");
    assert.equal(summary.bySeller[0]?.amountAtomic, "3000003");
    assert.equal(summary.recent[0]?.amountAtomic, "2000002");
    assert.equal(summary.recent[0]?.assetDecimals, 7);
    assert.equal(summary.market.grossVolumeAtomic, "0");
    assert.doesNotThrow(() => JSON.stringify(summary));
  } finally {
    if (prevDb === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = prevDb;
    if (prevBaseline === undefined) delete process.env.PAYMENTS_BASELINE_USDC;
    else process.env.PAYMENTS_BASELINE_USDC = prevBaseline;
  }
});
