import assert from "node:assert/strict";
import { test } from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import { validateDiscoveryExtension } from "@x402/extensions/bazaar";
import { decodePaymentRequiredHeader, decodePaymentResponseHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import { example, outputSchema, path, requirement, resource } from "../src/metadata.js";
import worker, { PaymentAttempt } from "../src/worker.js";
import { calculateWindows, parseQuery } from "../src/weather.js";

const origin = "https://windows.example";
const query = "?lat=38.90&lon=-77.04&hours=6";
const payer = "0x0000000000000000000000000000000000000001";
const tx = "0x" + "a".repeat(64);
const now = Date.parse("2026-11-20T12:11:00Z");
const hourlyUrl = "https://api.weather.gov/gridpoints/LWX/97,71/forecast/hourly";
const pointUrl = "https://api.weather.gov/points/38.90,-77.04";
const syntheticSignature = "0x" + "12".repeat(65);
const ok = { success: true, transaction: tx, network: requirement.network, payer, amount: "5000" };

function header(mutate = () => {}) {
  const payment = {
    x402Version: 2,
    resource: resource(origin),
    accepted: structuredClone(requirement),
    payload: {
      signature: syntheticSignature,
      authorization: {
        from: payer, to: requirement.payTo, value: "5000",
        validAfter: String(Math.floor(now / 1000) - 30), validBefore: String(Math.floor(now / 1000) + 60),
        nonce: "0x" + "2".repeat(64),
      },
    },
  };
  mutate(payment);
  return encodePaymentSignatureHeader(payment);
}

function hour(start, override = {}) {
  return {
    startTime: `2026-11-20T${start}:00:00Z`,
    endTime: `2026-11-20T${Number(start) + 1}:00:00Z`,
    temperature: 61,
    temperatureUnit: "F",
    windSpeed: "5 to 10 mph",
    probabilityOfPrecipitation: { unitCode: "wmoUnit:percent", value: 5 },
    isDaytime: true,
    ...override,
  };
}

function harness(t, replies = {}, rate = {}) {
  t.mock.method(Date, "now", () => now);
  const expected = [];
  const attempts = new Map();
  const permit = (success = true) => ({ limit: async () => ({ success }) });
  const env = {
    HTTP_RATE: permit(rate.http),
    PAYMENT_RATE: permit(rate.payment),
    FORECAST_RATE: permit(rate.forecast),
    FACILITATOR: "payai",
    PAYMENT_ATTEMPTS: {
      idFromName: (name) => name,
      get(id) {
        if (!attempts.has(id)) {
          let value;
          const storage = {
            get: async () => structuredClone(value),
            put: async (_key, record) => { value = structuredClone(record); },
            setAlarm: async () => {},
            deleteAll: async () => { value = undefined; },
            transaction: async (callback) => callback(storage),
          };
          attempts.set(id, new PaymentAttempt({ storage }, env));
        }
        return { fetch: (url, init) => attempts.get(id).fetch(new Request(url, init)) };
      },
    },
  };

  t.mock.method(globalThis, "fetch", async (url, init) => {
    const step = String(url).split("/").at(-1);
    expected.push(step);
    if (String(url).startsWith("https://api.weather.gov/")) assert.equal(init.redirect, "manual");
    const custom = replies[step];
    if (custom) return custom(init);
    if (url === pointUrl) return Response.json({ properties: { forecastHourly: hourlyUrl } });
    if (url === hourlyUrl) return Response.json({
      properties: {
        updateTime: "2026-11-20T12:00:00Z",
        periods: [hour("13"), hour("14"), hour("15", { isDaytime: false }), hour("16"), hour("17"), hour("18")],
      },
    });
    if (step === "verify") {
      const body = JSON.parse(init.body);
      assert.deepEqual(body.paymentRequirements, requirement);
      assert.equal(body.paymentPayload.extensions.bazaar.info.input.method, "GET");
      assert.equal(body.paymentPayload.resource.url, origin + path);
      return Response.json({ isValid: true, payer });
    }
    if (step === "settle") return Response.json(ok);
    throw new Error(`Unexpected fetch ${url}`);
  });

  return {
    expected,
    fetch: (suffix = path + query, payment, method = "GET") => worker.fetch(
      new Request(origin + suffix, { method, headers: payment === undefined ? {} : { "PAYMENT-SIGNATURE": payment } }), env,
    ),
  };
}

test("unpaid GET and HEAD expose v2, payment terms and valid Bazaar discovery", async (t) => {
  const api = harness(t);
  for (const [suffix, method] of [[path, "GET"], [path + query, "GET"], [path, "HEAD"]]) {
    const response = await api.fetch(suffix, undefined, method);
    assert.equal(response.status, 402);
    const challenge = decodePaymentRequiredHeader(response.headers.get("PAYMENT-REQUIRED"));
    assert.equal(challenge.x402Version, 2);
    assert.deepEqual(challenge.accepts, [requirement]);
    assert.equal(challenge.resource.url, origin + path);
    assert.equal(challenge.extensions.bazaar.info.input.method, "GET");
    assert.equal(validateDiscoveryExtension(challenge.extensions.bazaar).valid, true);
    const body = await response.text();
    if (method === "HEAD") assert.equal(body, "");
    else assert.equal(JSON.parse(body).error, "payment_required");
  }

  const spec = await (await api.fetch("/openapi.json")).json();
  assert.deepEqual(spec.paths[path].get["x-payment-info"], {
    price: { mode: "fixed", currency: "USD", amount: "0.005" }, protocols: [{ x402: {} }],
  });
  const discovery = await (await api.fetch("/.well-known/x402")).json();
  assert.deepEqual(discovery.resources, [origin + path]);
  const preview = await (await api.fetch("/preview")).json();
  const validate = new Ajv2020().compile(outputSchema);
  assert.equal(preview.sampleIsIllustrative, true);
  assert.equal(validate(example), true);
  assert.deepEqual(api.expected, []);
});

test("query validation and mismatched or malformed authorizations never reach the facilitator", async (t) => {
  const api = harness(t);
  for (const invalid of [
    "", "?lat=38", "?lat=NaN&lon=0", "?lat=91&lon=0", query + "&lat=1",
    query + "&extra=1", query + "&maxRainPct=101", query + "&minTempC=30&maxTempC=20",
    query + "&daylightOnly=yes", query.replace("hours=6", "hours=5"),
  ]) {
    const response = await api.fetch(path + invalid, header());
    assert.equal(response.status, 400, invalid);
    assert.equal(response.headers.has("PAYMENT-REQUIRED"), false);
  }
  for (const payment of [
    "not base64",
    header((p) => { p.accepted.network = "eip155:1"; }),
    header((p) => { p.accepted.amount = "1"; }),
    header((p) => { p.payload.authorization.to = payer; }),
    header((p) => { p.resource.url = origin + "/elsewhere"; }),
    header((p) => { p.payload.authorization.from = requirement.payTo; }),
  ]) assert.equal((await api.fetch(path + query, payment)).status, 402);
  assert.deepEqual(api.expected, []);
});

test("paid request verifies, prepares and settles before release, then reuses the stored result", async (t) => {
  const api = harness(t);
  const response = await api.fetch(path + query, header());
  assert.equal(response.status, 200);
  const receipt = decodePaymentResponseHeader(response.headers.get("PAYMENT-RESPONSE"));
  assert.deepEqual(receipt, ok);
  const result = await response.json();
  assert.equal(new Ajv2020().compile(outputSchema)(result), true);
  assert.deepEqual(result.windows.map((w) => w.hours), [2, 3]);
  assert.equal(result.windows[0].maxSustainedWindKph, 16.1);
  assert.deepEqual(api.expected, ["verify", "38.90,-77.04", "hourly", "settle"]);
  assert.deepEqual(await (await api.fetch(path + query, header())).json(), result);
  assert.equal((await api.fetch(path + query + "&maxRainPct=50", header())).status, 409);
  assert.equal(api.expected.length, 4);
});

test("verification failure stops before the forecast and settlement", async (t) => {
  const api = harness(t, {
    verify: () => Response.json({ isValid: false, invalidReason: "invalid_signature" }, { status: 402 }),
  });
  assert.equal((await api.fetch(path + query, header())).status, 402);
  assert.deepEqual(api.expected, ["verify"]);
});

test("unsupported coordinates stop before settlement", async (t) => {
  const api = harness(t, { "38.90,-77.04": () => new Response(null, { status: 404 }) });
  assert.equal((await api.fetch(path + query, header())).status, 422);
  assert.deepEqual(api.expected, ["verify", "38.90,-77.04"]);
});

test("unavailable or unsafe upstream response stops before settlement", async (t) => {
  const api = harness(t, {
    "38.90,-77.04": () => Response.json({ properties: { forecastHourly: "https://elsewhere.example/gridpoints/LWX/97,71/forecast/hourly" } }),
  });
  const response = await api.fetch(path + query, header());
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("Retry-After"), "60");
  assert.deepEqual(api.expected, ["verify", "38.90,-77.04"]);
});

test("failed settlement with a definitive 402 returns only the payment challenge", async (t) => {
  const api = harness(t, {
    settle: () => Response.json({ success: false, errorReason: "authorization_expired", transaction: "", network: requirement.network }, { status: 402 }),
  });
  const response = await api.fetch(path + query, header());
  assert.equal(response.status, 402);
  assert.equal((await response.json()).error, "payment_settlement_declined");
  assert.equal(response.headers.has("PAYMENT-RESPONSE"), false);
});

test("pending, duplicate and successful replay submit an identical authorization without regenerating the report", async (t) => {
  const submitted = [];
  const api = harness(t, {
    settle(init) {
      submitted.push(init.body);
      if (submitted.length === 1) return Response.json({ ...ok, success: false, errorReason: "settlement_pending" });
      if (submitted.length === 2) return Response.json({ ...ok, success: false, errorReason: "duplicate_settlement" }, { status: 409 });
      return Response.json(ok);
    },
  });
  for (let attempt = 0; attempt < 2; attempt++) {
    const pending = await api.fetch(path + query, header());
    assert.equal(pending.status, 503);
    assert.equal(pending.headers.has("PAYMENT-RESPONSE"), false);
    assert.deepEqual(Object.keys(await pending.json()), ["error", "message", "transaction"]);
  }
  const paid = await api.fetch(path + query, header());
  assert.equal(paid.status, 200);
  assert.equal((await paid.json()).windows.length, 2);
  assert.deepEqual(submitted, [submitted[0], submitted[0], submitted[0]]);
  assert.deepEqual(api.expected, ["verify", "38.90,-77.04", "hourly", "settle", "settle", "settle"]);
});

test("contradictory settlement success never releases the report", async (t) => {
  const api = harness(t, { settle: () => Response.json({ ...ok, network: "eip155:1" }) });
  const response = await api.fetch(path + query, header());
  assert.equal(response.status, 503);
  assert.equal(response.headers.has("PAYMENT-RESPONSE"), false);
});

test("rate limits stop payment verification before external calls", async (t) => {
  const api = harness(t, {}, { payment: false });
  const response = await api.fetch(path + query, header());
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("Retry-After"), "60");
  assert.deepEqual(api.expected, []);
});

test("forecast rejects unknown or duplicate hours and distinguishes partial coverage from no matches", () => {
  const input = parseQuery(new URL(origin + path + query));
  const result = calculateWindows([
    hour("13"), hour("14"), hour("14"), hour("15", { probabilityOfPrecipitation: { value: null } }),
    hour("16", { windSpeed: "20 mph" }), hour("17", { isDaytime: false }), hour("18"),
  ], input, {}, now);
  assert.deepEqual(result.windows, []);
  assert.equal(result.horizon.usableHours, 4);
  assert.equal(result.horizon.complete, false);
  assert.throws(() => calculateWindows([], input, {}, now), { code: "forecast_unavailable" });
});
