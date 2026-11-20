import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { forecastQuerySchema, getWeatherWindows, parseForecastQuery, parseQuery, querySchema } from "./weather.js";
import { forecastSource, getForecast } from "./met-forecast.js";

export const path = "/v1/weather-windows";
export const exampleQuery = {
  lat: "38.90", lon: "-77.04", hours: "24", minWindowHours: "3",
  maxRainPct: "20", maxWindKph: "25", daylightOnly: "true",
};
export const serviceName = "ExMachina Weather Windows";
export const legacyDescription = "Find contiguous U.S. forecast hours for outdoor work within your rain, sustained wind, temperature, and daylight limits. For a three-hour outdoor paint job in Washington, DC, find a daylight window in the next 24 hours with at most 20% hourly rain probability and 25 km/h sustained wind.";
export const description = "Find the next rain- and wind-safe weather window for outdoor work at U.S. coordinates. Filter the hourly forecast by precipitation probability, sustained wind, temperature, daylight, and minimum duration. Returns contiguous windows with UTC start and end times, forecast coverage, and the National Weather Service source. Example: find three daylight hours for outdoor painting in Washington, DC.";
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

export const windowsRoute = {
  path, operationId: "getWeatherWindows", title: serviceName, description, tags, querySchema, outputSchema,
  exampleQuery, example, parseQuery, getReport: (input, now) => getWeatherWindows(input, now), price: "0.005", requirement, extensions,
};

const forecastHourSchema = object({
  time: timestamp, temperatureC: number, relativeHumidityPct: number, windKph: number, windFromDegrees: number,
  cloudCoverPct: number, precipitationNextHourMm: { type: ["number", "null"] }, condition: { type: ["string", "null"] },
});
const forecastOutput = object({
  input: object({ lat: number, lon: number, hours: count }),
  source: object({ url: string, updatedAt: timestamp, attribution: string, license: string, licenseUrl: string, note: string }),
  current: { anyOf: [forecastHourSchema, { type: "null" }], description: "Latest available model estimate at or before the current time, if available." },
  hourly: { type: "array", items: forecastHourSchema, description: "Forecast hours in UTC, beginning at the next hour. Missing hours are omitted." },
  complete: { type: "boolean", description: "True when all requested hourly records are available." },
});
const forecastExample = {
  input: { lat: 35.68, lon: 139.76, hours: 1 },
  source: forecastSource(35.68, 139.76, "2026-11-20T09:21:52.000Z"),
  current: {
    time: "2026-11-20T10:00:00.000Z", temperatureC: 8.7, relativeHumidityPct: 54.1, windKph: 24.1,
    windFromDegrees: 244.1, cloudCoverPct: 8.6, precipitationNextHourMm: 0, condition: "clearsky_night",
  },
  hourly: [{
    time: "2026-11-20T11:00:00.000Z", temperatureC: 7.9, relativeHumidityPct: 57.7, windKph: 25.2,
    windFromDegrees: 254.5, cloudCoverPct: 10.2, precipitationNextHourMm: 0, condition: "clearsky_night",
  }],
  complete: true,
};
const forecastExampleQuery = { lat: "35.68", lon: "139.76", hours: "1" };
export const forecastRoute = {
  path: "/v1/weather/forecast", operationId: "getHourlyWeatherForecast", title: "Global Hourly Weather Forecast and Current Conditions",
  description: "Get current modeled weather conditions and up to 48 hours of hourly forecast by latitude and longitude worldwide. Returns temperature, humidity, wind speed and direction, cloud cover, next-hour precipitation amount and condition codes in UTC, with MET Norway attribution. Example: get the next hour for Tokyo.",
  tags: ["weather", "forecast", "current conditions", "hourly", "global"],
  querySchema: forecastQuerySchema, outputSchema: forecastOutput, exampleQuery: forecastExampleQuery, example: forecastExample,
  parseQuery: parseForecastQuery, getReport: getForecast, price: "0.001", requirement: { ...requirement, amount: "1000" },
  extensions: declareDiscoveryExtension({
    method: "GET", input: forecastExampleQuery, inputSchema: forecastQuerySchema,
    output: { example: forecastExample, schema: forecastOutput },
  }),
};

export const paidRoutes = new Map([windowsRoute, forecastRoute].map((route) => [route.path, route]));

export function resource(origin, route = windowsRoute) {
  return { url: origin + route.path, description: route.description, mimeType: "application/json", serviceName: route.title, tags: route.tags, iconUrl: origin + "/favicon.png" };
}

export function discoveryDocument(origin) {
  return { version: 1, resources: [...paidRoutes.keys()].map((routePath) => origin + routePath) };
}
