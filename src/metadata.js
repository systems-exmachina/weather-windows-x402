import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { parseQuery, querySchema } from "./weather.js";

export const path = "/v1/weather-windows";
export const exampleQuery = {
  lat: "38.90", lon: "-77.04", hours: "24", minWindowHours: "3",
  maxRainPct: "20", maxWindKph: "25", daylightOnly: "true",
};
export const serviceName = "ExMachina Weather Windows";
export const description = "Find contiguous U.S. forecast hours for outdoor work within your rain, sustained wind, temperature, and daylight limits. For a three-hour outdoor paint job in Washington, DC, find a daylight window in the next 24 hours with at most 20% hourly rain probability and 25 km/h sustained wind.";
export const tags = ["weather", "forecast", "planning", "us"];
export const requirement = {
  scheme: "exact",
  network: "eip155:8453",
  asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  amount: "5000",
  payTo: "0x8f66e0973B5808028c072860AD8605241C9a6b75",
  maxTimeoutSeconds: 90,
  extra: { name: "USD Coin", version: "2" },
};

const timestamp = { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$" };
const count = { type: "integer", minimum: 0 };
const number = { type: "number" };
const string = { type: "string" };
const boolean = { type: "boolean" };
const object = (properties) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });

export const outputSchema = object({
  input: object({
    lat: number, lon: number, hours: count, minWindowHours: count, maxRainPct: count,
    maxWindKph: number, minTempC: number, maxTempC: number, daylightOnly: boolean,
  }),
  horizon: object({ start: timestamp, end: timestamp, usableHours: count, complete: boolean }),
  source: object({ url: { type: "string", pattern: "^https://api\\.weather\\.gov/" }, updatedAt: timestamp, note: string }),
  windows: { type: "array", items: object({
    start: timestamp, end: timestamp, hours: count, minTempC: number, maxTempC: number,
    maxHourlyRainPct: count, maxSustainedWindKph: number,
  }) },
});

export const example = {
  input: parseQuery(new URL(`https://example.com${path}?${new URLSearchParams(exampleQuery)}`)),
  horizon: { start: "2026-11-20T12:00:00.000Z", end: "2026-11-21T12:00:00.000Z", usableHours: 24, complete: true },
  source: {
    url: "https://api.weather.gov/gridpoints/LWX/97,71/forecast/hourly",
    updatedAt: "2026-11-20T10:00:00.000Z",
    note: "Illustrative sample. Live windows are derived by ExMachina Systems from U.S. National Weather Service hourly data.",
  },
  windows: [{
    start: "2026-11-20T16:00:00.000Z", end: "2026-11-20T19:00:00.000Z", hours: 3,
    minTempC: 12, maxTempC: 17, maxHourlyRainPct: 5, maxSustainedWindKph: 18.4,
  }],
};

export const extensions = declareDiscoveryExtension({
  method: "GET",
  input: exampleQuery,
  inputSchema: querySchema,
  output: { example, schema: outputSchema },
});

export function resource(origin) {
  return { url: origin + path, description, mimeType: "application/json", serviceName, tags, iconUrl: origin + "/favicon.png" };
}

export function discoveryDocument(origin) {
  return { version: 1, resources: [resource(origin).url] };
}
