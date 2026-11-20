import { description, discoveryDocument, example, exampleQuery, outputSchema, path, resource, serviceName } from "./metadata.js";
import { challenge, digest, makeFacilitator, readPayment, settlementFailure, settlementHeader, settlementState, storeAttempt, verifyFailure } from "./payment.js";
import { getWeatherWindows, parseQuery, querySchema, WeatherError } from "./weather.js";

const headers = {
  "Cache-Control": "private, no-store",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Expose-Headers": "PAYMENT-REQUIRED, PAYMENT-RESPONSE, Retry-After",
  "X-Content-Type-Options": "nosniff",
};

function json(data, status = 200, extra = {}, method = "GET") {
  return new Response(method === "HEAD" ? null : JSON.stringify(data), {
    status, headers: { ...headers, "Content-Type": "application/json;charset=UTF-8", ...extra },
  });
}

function failure(status, error, message, extra) {
  return json({ error, message }, status, extra);
}

function paymentRequired(origin, method = "GET", error, extra = {}) {
  return json({
    error: error ?? "payment_required",
    message: "Pay 0.005 USDC on Base using x402 v2. See PAYMENT-REQUIRED for the full challenge.",
    example: `${origin}${path}?${new URLSearchParams(exampleQuery)}`,
  }, 402, { ...extra, "PAYMENT-REQUIRED": challenge(origin, error) }, method);
}

function limitsExceeded() {
  return failure(429, "rate_limit", "Retry after 60 seconds.", { "Retry-After": "60" });
}

function pendingSettlement(transaction) {
  return json({
    error: "settlement_pending",
    message: "Settlement may be in flight. Retry this URL with the original PAYMENT-SIGNATURE. Do not create a second authorization to reconcile this attempt.",
    ...(typeof transaction === "string" && /^0x[0-9a-f]{64}$/i.test(transaction) ? { transaction } : {}),
  }, 503, { "Retry-After": "10" });
}

function apiSpec(origin) {
  return {
    openapi: "3.1.0",
    info: {
      title: serviceName,
      version: "0.1.0",
      description,
      contact: { name: "ExMachina Systems", email: "systems.exmachina@gmail.com" },
      "x-guidance": "Call with public U.S. latitude and longitude, then retry with your Base x402 payment header. Use /preview for a free example. Inspect horizon.complete before relying on an empty windows array.",
    },
    servers: [{ url: origin }],
    paths: {
      [path]: { get: {
        operationId: "getWeatherWindows",
        summary: serviceName,
        description,
        parameters: Object.entries(querySchema.properties).map(([name, schema]) => ({
          name, in: "query", required: querySchema.required.includes(name), description: schema.description, schema,
          ...(Object.hasOwn(exampleQuery, name) ? { example: exampleQuery[name] } : {}),
        })),
        "x-payment-info": { protocols: [{ x402: {} }], price: { mode: "fixed", currency: "USD", amount: "0.005" } },
        responses: {
          "200": {
            description: "Settled weather-window result",
            headers: { "PAYMENT-RESPONSE": { schema: { type: "string" } } },
            content: { "application/json": { schema: outputSchema, example } },
          },
          "400": { description: "Invalid query, no charge" },
          "402": { description: "x402 payment required", headers: { "PAYMENT-REQUIRED": { schema: { type: "string" } } } },
          "422": { description: "Outside forecast coverage, no charge" },
          "429": { description: "Rate limit reached" },
          "503": { description: "Forecast or payment unavailable, or settlement pending with retry instructions" },
        },
      } },
    },
  };
}

const terms = {
  provider: "ExMachina Systems, an AI-run service",
  contact: "systems.exmachina@gmail.com",
  sellerInformation: "Contact the operator to request applicable statutory seller information before purchase.",
  price: "0.005 native USDC on Base per completed query, with no recurring fees.",
  payment: "Approve an x402 exact payment in your client. The facilitator settles before the API returns the result.",
  delivery: "JSON in the paid HTTP response. If settlement is pending or the response is lost, retry with the original authorization.",
  cancellation: "You can stop before authorizing a payment. After settlement, contact support about missing or defective delivery and include the Base transaction hash.",
  source: "Independent planning aid derived from U.S. National Weather Service data. For official forecasts and severe weather use https://www.weather.gov/.",
  privacy: "Use coordinates for public locations only. We round coordinates to two decimals before querying the source. For payment replay recovery we retain the normalized forecast and settlement reference for up to 48 hours after the last settlement record update.",
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { method } = request;
    const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
    if (!(await env.HTTP_RATE.limit({ key: ip })).success) return limitsExceeded();

    if (method === "OPTIONS" && url.pathname === path) {
      return new Response(null, { status: 204, headers: {
        ...headers, "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS", "Access-Control-Allow-Headers": "PAYMENT-SIGNATURE",
      } });
    }
    if (method !== "GET" && method !== "HEAD") {
      return failure(405, "method_not_allowed", "Use GET or HEAD.", { Allow: "GET, HEAD" });
    }
    if (url.pathname === "/health") return json({ status: "ok" }, 200, {}, method);
    if (url.pathname === "/openapi.json") return json(apiSpec(url.origin), 200, {}, method);
    if (url.pathname === "/.well-known/x402") return json(discoveryDocument(url.origin), 200, {}, method);
    if (url.pathname === "/terms") return json(terms, 200, {}, method);
    if (url.pathname === "/" || url.pathname === "/preview") {
      return json({
        service: resource(url.origin),
        price: "0.005 USDC on Base",
        sample: example,
        sampleIsIllustrative: true,
        inputSchema: querySchema,
        outputSchema,
        docs: url.origin + "/openapi.json",
        terms: url.origin + "/terms",
      }, 200, {}, method);
    }
    if (url.pathname !== path) return json({ error: "not_found" }, 404, {}, method);

    const authorization = request.headers.get("PAYMENT-SIGNATURE");
    // Directory probes need to discover the schema without choosing coordinates.
    if (method === "HEAD" || (!url.search && authorization === null)) return paymentRequired(url.origin, method);

    let input;
    try {
      input = parseQuery(url);
    } catch (error) {
      if (!(error instanceof WeatherError)) throw error;
      return failure(error.status, error.code, error.message);
    }
    if (authorization === null) return paymentRequired(url.origin);
    if (!(await env.PAYMENT_RATE.limit({ key: ip })).success) return limitsExceeded();
    const payment = readPayment(authorization, url.origin);
    if (!payment) return paymentRequired(url.origin, method, "invalid_payment_signature");

    const { from, nonce } = payment.payload.authorization;
    const key = await digest([from.toLowerCase(), nonce.toLowerCase()]);
    const attempt = env.PAYMENT_ATTEMPTS.get(env.PAYMENT_ATTEMPTS.idFromName(key));
    try {
      return await attempt.fetch("https://settlement.internal/", {
        method: "POST",
        body: JSON.stringify({ origin: url.origin, input, payment }),
      });
    } catch {
      return pendingSettlement();
    }
  },
};

export class PaymentAttempt {
  constructor(state, env) {
    this.storage = state.storage;
    this.env = env;
    this.inFlight = false;
  }

  async fetch(request) {
    if (this.inFlight) return pendingSettlement();
    this.inFlight = true;
    try {
      const { origin, input, payment } = await request.json();
      return await this.process(origin, input, payment);
    } finally {
      this.inFlight = false;
    }
  }

  async process(origin, input, payment) {
    const fingerprint = await digest({ input, payment });
    let attempt = await this.storage.get("attempt");
    if (attempt && attempt.fingerprint !== fingerprint) {
      return failure(409, "authorization_reused", "Use the original query and payment authorization to reconcile this attempt.");
    }
    if (attempt?.receipt) {
      return json(attempt.report, 200, { "PAYMENT-RESPONSE": attempt.receipt });
    }

    const name = attempt?.facilitator ?? this.env.FACILITATOR;
    const client = makeFacilitator(name);
    if (!attempt) {
      let verified;
      try {
        verified = await client.verify(payment, payment.accepted);
      } catch (error) {
        if (verifyFailure(error)) return paymentRequired(origin, "GET", "payment_verification_failed");
        return failure(503, "verification_unavailable", "Payment verification is temporarily unavailable. No payment was submitted for settlement.");
      }
      if (verified.isValid !== true || (verified.payer !== undefined
        && verified.payer.toLowerCase() !== payment.payload.authorization.from.toLowerCase())) {
        return paymentRequired(origin, "GET", "payment_verification_failed");
      }
      if (!(await this.env.FORECAST_RATE.limit({ key: "forecast" })).success) return limitsExceeded();

      let report;
      try {
        report = await getWeatherWindows(input, Date.now());
      } catch (error) {
        if (!(error instanceof WeatherError)) throw error;
        return failure(error.status, error.code, error.message, error.status === 503 ? { "Retry-After": "60" } : {});
      }
      attempt = { fingerprint, report, facilitator: name };
      await storeAttempt(this.storage, attempt);
    }

    let settlement;
    try {
      settlement = await client.settle(payment, payment.accepted);
    } catch (error) {
      settlement = settlementFailure(error);
    }

    const status = settlementState(settlement, payment);
    if (status === "pending") return pendingSettlement(settlement?.transaction);
    if (status === "declined") return paymentRequired(origin, "GET", "payment_settlement_declined");

    const receipt = settlementHeader(settlement, payment);
    await storeAttempt(this.storage, { ...attempt, receipt });
    return json(attempt.report, 200, { "PAYMENT-RESPONSE": receipt });
  }

  async alarm() {
    await this.storage.deleteAll();
  }
}
