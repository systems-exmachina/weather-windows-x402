import { discoveryDocument, forecastRoute, legacyDescription, paidRoutes, resource, serviceName, windowsRoute } from "./metadata.js";
import { challenge, digest, makeFacilitator, readPayment, settlementFailure, settlementHeader, settlementState, storeAttempt, verifyFailure } from "./payment.js";
import { WeatherError } from "./weather.js";
import { handleMcp } from "./mcp.js";
export { MetForecast } from "./met-forecast.js";

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

function exampleUrl(origin, route, query = route.exampleQuery) {
  return `${origin}${route.path}?${new URLSearchParams(query)}`;
}

function paymentRequired(origin, route, method = "GET", error) {
  return json({
    error: error ?? "payment_required",
    message: `Pay ${route.price} USDC on Base using x402 v2. See PAYMENT-REQUIRED for the full challenge.`,
    example: exampleUrl(origin, route),
  }, 402, { "PAYMENT-REQUIRED": challenge(origin, route, error) }, method);
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

function paidOperation(route) {
  const { querySchema, outputSchema } = route;
  return {
    operationId: route.operationId,
    summary: route.title,
    description: route.description,
    tags: route.tags,
    parameters: Object.entries(querySchema.properties).map(([name, schema]) => ({
      name, in: "query", required: querySchema.required.includes(name), description: schema.description, schema,
      ...(Object.hasOwn(route.exampleQuery, name) ? { example: route.exampleQuery[name] } : {}),
    })),
    "x-payment-info": { protocols: [{ x402: {} }], price: { mode: "fixed", currency: "USD", amount: route.price } },
    responses: {
      "200": {
        description: "Settled weather result",
        headers: { "PAYMENT-RESPONSE": { schema: { type: "string" } } },
        content: { "application/json": { schema: outputSchema, example: route.example } },
      },
      "400": { description: "Invalid query, no charge" },
      "402": { description: "x402 payment required", headers: { "PAYMENT-REQUIRED": { schema: { type: "string" } } } },
      ...(route === windowsRoute ? { "422": { description: "Outside forecast coverage, no charge" } } : {}),
      "429": { description: "Rate limit reached" },
      "503": { description: "Forecast or payment unavailable, or settlement pending with retry instructions" },
    },
  };
}

function apiSpec(origin) {
  return {
    openapi: "3.1.0",
    info: {
      title: serviceName,
      version: "0.2.0",
      description: "U.S. outdoor weather windows and worldwide hourly weather forecasts via x402 on Base.",
      contact: { name: "ExMachina Systems", email: "systems.exmachina@gmail.com" },
      "x-guidance": "Provide public latitude and longitude, then retry the same query with your Base x402 payment header. Use /preview for free live samples. Inspect horizon.complete before relying on an empty windows array.",
    },
    servers: [{ url: origin }],
    paths: {
      ...Object.fromEntries([...paidRoutes].map(([path, route]) => [path, { get: paidOperation(route) }])),
      "/preview": { get: {
        summary: "Free live samples for Washington, DC and Tokyo",
        responses: { "200": { description: "Sample weather windows and hourly forecast, with per-sample freshness status" } },
      } },
    },
  };
}

const terms = {
  provider: "ExMachina Systems, an AI-run service",
  contact: "systems.exmachina@gmail.com",
  sellerInformation: "Contact the operator to request applicable statutory seller information before purchase.",
  price: "0.005 native USDC on Base per weather-window query and 0.001 per global hourly forecast query, with no recurring fees.",
  payment: "Approve an x402 exact payment in your client. The facilitator settles before the API returns the result.",
  delivery: "JSON in the paid HTTP response. If settlement is pending or the response is lost, retry with the original authorization.",
  cancellation: "You can stop before authorizing a payment. After settlement, contact support about missing or defective delivery and include the Base transaction hash.",
  source: "Weather windows use U.S. National Weather Service hourly forecasts. Global forecasts use MET Norway Locationforecast data under CC BY 4.0. ExMachina Systems selects hours, renames fields and converts wind speed to km/h. Current conditions are model estimates. For official forecasts and severe weather use your local weather authority.",
  forecastLicense: "https://creativecommons.org/licenses/by/4.0/",
  privacy: "Use coordinates for public locations only. We round coordinates to two decimals before querying the source. For payment replay recovery we retain the normalized forecast and settlement reference for up to 48 hours after the last settlement record update.",
};

function routeSummary(origin, route) {
  return { ...resource(origin, route), price: `${route.price} USDC on Base`, exampleUrl: exampleUrl(origin, route) };
}

const sampleInputs = new Map([
  [windowsRoute, windowsRoute.example.input],
  [forecastRoute, { ...forecastRoute.example.input, hours: 3 }],
]);

async function previewSample(route, env) {
  try {
    return { result: await route.getReport(sampleInputs.get(route), Date.now(), env), live: true };
  } catch (error) {
    if (!(error instanceof WeatherError)) throw error;
    return { result: route.example, live: false, error: error.code };
  }
}

export async function preview(origin, env) {
  const [windows, forecast] = await Promise.all([
    previewSample(windowsRoute, env), previewSample(forecastRoute, env),
  ]);
  return {
    service: resource(origin),
    price: `${windowsRoute.price} USDC on Base`,
    sample: windows.result,
    sampleIsIllustrative: !windows.live,
    weatherWindows: { ...windows, request: exampleUrl(origin, windowsRoute) },
    hourlyForecast: { ...forecast, request: exampleUrl(origin, forecastRoute, { ...forecastRoute.exampleQuery, hours: "3" }) },
    inputSchema: windowsRoute.querySchema,
    outputSchema: windowsRoute.outputSchema,
    docs: `${origin}/openapi.json`, terms: `${origin}/terms`,
  };
}

function agentGuide(origin) {
  return `# ${serviceName}

> Outdoor scheduling windows for U.S. coordinates and worldwide hourly weather forecasts. Pay per completed call using x402 v2 and native USDC on Base.

## Weather API

- [Free live preview](${origin}/preview): Example results for Washington, DC and Tokyo. Each sample identifies whether it is live.
- [OpenAPI](${origin}/openapi.json): Request and response schemas, prices, and examples.
- [Weather windows](${exampleUrl(origin, windowsRoute)}): ${windowsRoute.price} USDC. ${windowsRoute.description} Check horizon.complete before relying on an empty result.
- [Hourly forecast and current conditions](${exampleUrl(origin, forecastRoute)}): ${forecastRoute.price} USDC. ${forecastRoute.description} Current conditions are model estimates and may be null. Check complete for missing forecast hours.
- [Terms and data attribution](${origin}/terms)

Send an unpaid GET, then use the PAYMENT-REQUIRED challenge with a Base x402 v2 client to authorize the exact amount. Retry the same URL with PAYMENT-SIGNATURE. If settlement is pending or the response is lost, retry that URL with the original authorization.
`;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { method } = request;
    const route = paidRoutes.get(url.pathname);
    const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
    if (!(await env.HTTP_RATE.limit({ key: ip })).success) return limitsExceeded();
    if (url.pathname === "/mcp") return handleMcp(request, () => preview(url.origin, env));

    if (method === "OPTIONS" && route) {
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
    if (url.pathname === "/llms.txt") return new Response(method === "HEAD" ? null : agentGuide(url.origin), {
      headers: { ...headers, "Content-Type": "text/plain;charset=UTF-8" },
    });
    if (url.pathname === "/preview") return json(method === "HEAD" ? null : await preview(url.origin, env), 200, {}, method);
    if (url.pathname === "/") {
      return json({
        service: resource(url.origin),
        price: `${windowsRoute.price} USDC on Base`,
        sample: windowsRoute.example,
        sampleIsIllustrative: true,
        inputSchema: windowsRoute.querySchema,
        outputSchema: windowsRoute.outputSchema,
        tools: [...paidRoutes.values()].map((tool) => routeSummary(url.origin, tool)),
        preview: url.origin + "/preview",
        llms: url.origin + "/llms.txt",
        mcp: url.origin + "/mcp",
        docs: url.origin + "/openapi.json",
        terms: url.origin + "/terms",
      }, 200, {}, method);
    }
    if (!route) return json({ error: "not_found" }, 404, {}, method);

    const authorization = request.headers.get("PAYMENT-SIGNATURE");
    // Directory probes need to discover the schema without choosing coordinates.
    if (method === "HEAD" || (!url.search && authorization === null)) return paymentRequired(url.origin, route, method);

    let input;
    try {
      input = route.parseQuery(url);
    } catch (error) {
      if (!(error instanceof WeatherError)) throw error;
      return failure(error.status, error.code, error.message);
    }
    if (authorization === null) return paymentRequired(url.origin, route);
    if (!(await env.PAYMENT_RATE.limit({ key: ip })).success) return limitsExceeded();
    const payment = readPayment(authorization, url.origin, route);
    if (!payment) return paymentRequired(url.origin, route, method, "invalid_payment_signature");

    const { from, nonce } = payment.payload.authorization;
    const key = await digest([from.toLowerCase(), nonce.toLowerCase()]);
    const attempt = env.PAYMENT_ATTEMPTS.get(env.PAYMENT_ATTEMPTS.idFromName(key));
    try {
      return await attempt.fetch("https://settlement.internal/", {
        method: "POST",
        body: JSON.stringify({ origin: url.origin, path: route.path, input, payment }),
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
      const { origin, path = windowsRoute.path, input, payment } = await request.json();
      return await this.process(origin, paidRoutes.get(path), input, payment);
    } finally {
      this.inFlight = false;
    }
  }

  async process(origin, route, input, payment) {
    let attempt = await this.storage.get("attempt");
    let fingerprint;
    if (attempt && !attempt.fingerprintVersion && route === windowsRoute) {
      // Versions before the forecast route hashed the whole discovery payload.
      payment.resource.description = legacyDescription;
      fingerprint = await digest({ input, payment });
    } else {
      fingerprint = await digest({ input, url: payment.resource.url, payload: payment.payload });
    }
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
        if (verifyFailure(error)) return paymentRequired(origin, route, "GET", "payment_verification_failed");
        return failure(503, "verification_unavailable", "Payment verification is temporarily unavailable. No payment was submitted for settlement.");
      }
      if (verified.isValid !== true || (verified.payer !== undefined
        && verified.payer.toLowerCase() !== payment.payload.authorization.from.toLowerCase())) {
        return paymentRequired(origin, route, "GET", "payment_verification_failed");
      }
      if (!(await this.env.FORECAST_RATE.limit({ key: "forecast" })).success) return limitsExceeded();

      let report;
      try {
        report = await route.getReport(input, Date.now(), this.env);
      } catch (error) {
        if (!(error instanceof WeatherError)) throw error;
        return failure(error.status, error.code, error.message, error.status === 503 ? { "Retry-After": "60" } : {});
      }
      attempt = { fingerprint, fingerprintVersion: 2, report, facilitator: name };
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
    if (status === "declined") return paymentRequired(origin, route, "GET", "payment_settlement_declined");

    const receipt = settlementHeader(settlement, payment);
    await storeAttempt(this.storage, { ...attempt, receipt });
    return json(attempt.report, 200, { "PAYMENT-RESPONSE": receipt });
  }

  async alarm() {
    await this.storage.deleteAll();
  }
}
