const HOUR = 3_600_000;
const NWS = "https://api.weather.gov";
const userAgent = "ExMachina-Weather-Windows/0.1 (systems.exmachina@gmail.com)";

const controls = {
  lat: { min: -90, max: 90, description: "Latitude of a public location in the United States or its territories." },
  lon: { min: -180, max: 180, description: "Longitude of a public location in the United States or its territories." },
  hours: { min: 6, max: 72, default: 48, integer: true, description: "Forecast horizon in hours." },
  minWindowHours: { min: 1, max: 8, default: 2, integer: true, description: "Minimum contiguous hours in each window." },
  maxRainPct: { min: 0, max: 100, default: 25, integer: true, description: "Maximum hourly probability of precipitation, 0–100." },
  maxWindKph: { min: 0, max: 150, default: 30, description: "Maximum sustained wind in km/h, using the upper end of any source range." },
  minTempC: { min: -60, max: 60, default: 5, description: "Minimum hourly temperature in °C." },
  maxTempC: { min: -60, max: 60, default: 32, description: "Maximum hourly temperature in °C." },
};

const decimal = /^-?\d{1,3}(\.\d{1,6})?$/;
const integer = /^-?\d{1,3}$/;
const daylightDescription = "Require hours marked as daytime by the source. Defaults to true.";

function coordinateQuerySchema(rules) {
  return {
    type: "object", additionalProperties: false, required: ["lat", "lon"],
    properties: Object.fromEntries(Object.entries(rules).map(([key, rule]) => [key, {
      type: "string",
      pattern: (rule.integer ? integer : decimal).source,
      maxLength: 11,
      description: `${rule.description} Range ${rule.min} to ${rule.max}.`,
      ...(rule.default === undefined ? {} : { default: String(rule.default) }),
    }])),
  };
}

const forecastControls = {
  lat: { ...controls.lat, description: "Latitude of a public location worldwide." },
  lon: { ...controls.lon, description: "Longitude of a public location worldwide." },
  hours: { ...controls.hours, min: 1, max: 48, default: 24 },
};
export const forecastQuerySchema = coordinateQuerySchema(forecastControls);
export const querySchema = coordinateQuerySchema(controls);
querySchema.properties.daylightOnly = { type: "string", enum: ["true", "false"], default: "true", description: daylightDescription };

export class WeatherError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const badInput = (message) => new WeatherError(400, "invalid_input", message);
export const badForecast = () => new WeatherError(503, "forecast_unavailable", "A usable forecast is temporarily unavailable. No payment was submitted for settlement.");

function parseCoordinates(url, rules, schema) {
  if (url.search.length > 512) throw badInput("Query string exceeds 512 characters.");
  const params = url.searchParams;
  for (const key of params.keys()) {
    if (!Object.hasOwn(schema.properties, key)) throw badInput("Unknown query parameter.");
    if (params.getAll(key).length !== 1) throw badInput("Duplicate query parameter.");
  }

  const input = {};
  for (const [key, rule] of Object.entries(rules)) {
    const raw = params.get(key);
    if (raw === null && rule.default !== undefined) {
      input[key] = rule.default;
      continue;
    }
    const value = Number(raw);
    if (raw === null || !(rule.integer ? integer : decimal).test(raw) || value < rule.min || value > rule.max) {
      throw badInput(`${key} must be ${rule.integer ? "an integer" : "a decimal"} between ${rule.min} and ${rule.max}.`);
    }
    input[key] = value;
  }
  input.lat = Number(input.lat.toFixed(2)) || 0;
  input.lon = Number(input.lon.toFixed(2)) || 0;
  return input;
}

export function parseForecastQuery(url) {
  return parseCoordinates(url, forecastControls, forecastQuerySchema);
}

export function parseQuery(url) {
  const input = parseCoordinates(url, controls, querySchema);
  const daylightOnly = url.searchParams.get("daylightOnly") ?? "true";
  if (daylightOnly !== "true" && daylightOnly !== "false") throw badInput("daylightOnly must be true or false.");
  if (input.minTempC > input.maxTempC) throw badInput("minTempC must be less than or equal to maxTempC.");
  input.daylightOnly = daylightOnly === "true";
  return input;
}

function forecastHour(period) {
  const start = Date.parse(period?.startTime);
  const end = Date.parse(period?.endTime);
  if (!Number.isFinite(start) || end - start !== HOUR) return null;

  const toTenth = (num) => Math.round(num * 10) / 10;
  const unit = period.temperatureUnit;
  const temp = period.temperature;
  const tempC = Number.isFinite(temp) && (unit === "C" || unit === "F")
    ? toTenth(unit === "F" ? (temp - 32) * 5 / 9 : temp)
    : null;

  const wind = typeof period.windSpeed === "string"
    ? /^(\d{1,3})(?:\s*(?:to|-)\s*(\d{1,3}))?\s*(mph|km\/h|kph)$/i.exec(period.windSpeed.trim())
    : null;
  const windKph = wind
    ? toTenth(Math.max(Number(wind[1]), Number(wind[2] ?? wind[1])) * (wind[3].toLowerCase() === "mph" ? 1.609344 : 1))
    : null;

  const rain = period.probabilityOfPrecipitation;
  const rainPct = rain?.unitCode === "wmoUnit:percent" && Number.isInteger(rain.value) && rain.value >= 0 && rain.value <= 100
    ? rain.value
    : null;
  const daytime = typeof period.isDaytime === "boolean" ? period.isDaytime : null;
  return { start, end, tempC, windKph, rainPct, daytime };
}

export function calculateWindows(periods, input, source, now) {
  const first = Math.ceil(now / HOUR) * HOUR;
  const last = first + input.hours * HOUR;
  const byStart = new Map();
  for (const period of periods) {
    const hour = forecastHour(period);
    if (hour && hour.start >= first && hour.end <= last && (hour.start - first) % HOUR === 0) {
      byStart.set(hour.start, byStart.has(hour.start) ? null : hour);
    }
  }

  let observedHours = 0;
  const groups = [];
  let group = [];
  for (let time = first; time < last; time += HOUR) {
    const hour = byStart.get(time);
    const usable = hour && hour.tempC !== null && hour.windKph !== null && hour.rainPct !== null
      && (!input.daylightOnly || hour.daytime !== null);
    if (usable) observedHours++;
    if (usable && (!input.daylightOnly || hour.daytime) && hour.tempC >= input.minTempC
      && hour.tempC <= input.maxTempC && hour.windKph <= input.maxWindKph && hour.rainPct <= input.maxRainPct) {
      group.push(hour);
    } else if (group.length) {
      groups.push(group);
      group = [];
    }
  }
  if (group.length) groups.push(group);
  if (observedHours === 0) throw badForecast();

  const iso = (time) => new Date(time).toISOString();
  return {
    input,
    horizon: { start: iso(first), end: iso(last), usableHours: observedHours, complete: observedHours === input.hours },
    source,
    windows: groups.filter((hours) => hours.length >= input.minWindowHours).map((hours) => ({
      start: iso(hours[0].start),
      end: iso(hours.at(-1).end),
      hours: hours.length,
      minTempC: Math.min(...hours.map((hour) => hour.tempC)),
      maxTempC: Math.max(...hours.map((hour) => hour.tempC)),
      maxHourlyRainPct: Math.max(...hours.map((hour) => hour.rainPct)),
      maxSustainedWindKph: Math.max(...hours.map((hour) => hour.windKph)),
    })),
  };
}

async function nwsJson(url, ttl, requestFetch) {
  const response = await requestFetch(url, {
    headers: { "User-Agent": userAgent, Accept: "application/geo+json" },
    signal: AbortSignal.timeout(4_000),
    redirect: "manual",
    cf: { cacheEverything: true, cacheTtlByStatus: { "200": ttl, "404": 300, "400-403": 0, "405-599": 0 } },
  });
  if (response.status === 404) {
    await response.body?.cancel();
    return null;
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw badForecast();
  }

  return readForecastJson(response);
}

export async function readForecastJson(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let body = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 512_000) throw badForecast();
      body += decoder.decode(value, { stream: true });
    }
    return JSON.parse(body + decoder.decode());
  } finally {
    await reader.cancel().catch(() => {});
  }
}

export async function getWeatherWindows(input, now, requestFetch = fetch) {
  try {
    const point = await nwsJson(`${NWS}/points/${input.lat.toFixed(2)},${input.lon.toFixed(2)}`, 86_400, requestFetch);
    if (!point) {
      throw new WeatherError(422, "outside_forecast_coverage", "The source has no forecast grid for this location. No payment was submitted for settlement.");
    }
    const url = point.properties?.forecastHourly;
    // Only request the expected government API path, even if its response changes.
    if (typeof url !== "string" || !/^https:\/\/api\.weather\.gov\/gridpoints\/[A-Z]{3}\/-?\d{1,4},-?\d{1,4}\/forecast\/hourly$/.test(url)) {
      throw badForecast();
    }
    const forecast = (await nwsJson(url, 1_800, requestFetch))?.properties;
    const updated = Date.parse(forecast?.updateTime);
    if (!Array.isArray(forecast?.periods) || forecast.periods.length > 200 || !Number.isFinite(updated)
      || now - updated > 24 * HOUR || updated - now > HOUR) {
      throw badForecast();
    }
    return calculateWindows(forecast.periods, input, {
      url,
      updatedAt: new Date(updated).toISOString(),
      note: "Derived from U.S. National Weather Service hourly data. Window calculations are by ExMachina Systems.",
    }, now);
  } catch (error) {
    if (error instanceof WeatherError) throw error;
    throw badForecast();
  }
}
