import { badForecast, readForecastJson } from "./weather.js";

const hourMs = 3_600_000;
const metUrl = "https://api.met.no/weatherapi/locationforecast/2.0/compact";
const licenseUrl = "https://creativecommons.org/licenses/by/4.0/";
const userAgent = "ExMachina-Weather-Windows/0.2 (systems.exmachina@gmail.com)";

export function forecastSource(lat, lon, updatedAt) {
  return {
    url: `${metUrl}?lat=${lat.toFixed(2)}&lon=${lon.toFixed(2)}`,
    updatedAt,
    attribution: "Norwegian Meteorological Institute (MET Norway)",
    license: "CC BY 4.0",
    licenseUrl,
    note: "ExMachina Systems selects forecast hours, renames fields and converts wind speed to km/h.",
  };
}

function normalizeHour(row) {
  const point = row?.data?.instant?.details;
  if (![point?.air_temperature, point?.relative_humidity, point?.wind_speed,
    point?.wind_from_direction, point?.cloud_area_fraction].every(Number.isFinite)) return null;
  const nextHour = row.data.next_1_hours;
  const rain = nextHour?.details?.precipitation_amount;
  const condition = nextHour?.summary?.symbol_code;
  return {
    time: new Date(row.time).toISOString(),
    temperatureC: point.air_temperature,
    relativeHumidityPct: point.relative_humidity,
    windKph: Math.round(point.wind_speed * 36) / 10,
    windFromDegrees: point.wind_from_direction,
    cloudCoverPct: point.cloud_area_fraction,
    precipitationNextHourMm: Number.isFinite(rain) ? rain : null,
    condition: typeof condition === "string" ? condition : null,
  };
}

export async function getForecast(input, now, env) {
  const source = forecastSource(input.lat, input.lon, null);
  let forecast;
  try {
    const proxy = env.MET_FORECAST.getByName("upstream");
    const response = await proxy.fetch(source.url);
    if (!response.ok) throw badForecast();
    forecast = (await response.json()).properties;
  } catch {
    throw badForecast();
  }
  const updated = Date.parse(forecast?.meta?.updated_at);
  if (!Array.isArray(forecast?.timeseries) || !Number.isFinite(updated)
    || now - updated > 24 * hourMs || updated - now > hourMs) throw badForecast();
  source.updatedAt = new Date(updated).toISOString();

  const start = Math.floor(now / hourMs) * hourMs + hourMs;
  const end = start + input.hours * hourMs;
  const byTime = new Map();
  for (const row of forecast.timeseries) {
    const time = Date.parse(row?.time);
    if (time % hourMs === 0 && time >= start - 2 * hourMs && time < end) {
      byTime.set(time, byTime.has(time) ? null : normalizeHour(row));
    }
  }
  const current = byTime.get(start - hourMs) ?? byTime.get(start - 2 * hourMs) ?? null;
  const hourly = [];
  for (let time = start; time < end; time += hourMs) {
    const hour = byTime.get(time);
    if (hour) hourly.push(hour);
  }
  if (!hourly.length) throw badForecast();
  return { input, source, current, hourly, complete: hourly.length === input.hours };
}

// One instance shares the cache and request budget across callers and routes.
export class MetForecast {
  constructor() {
    this.inFlight = new Map();
    this.started = [];
  }

  async fetch(request) {
    const url = request.url;
    if (!this.inFlight.has(url)) this.inFlight.set(url, this.load(url));
    try {
      return (await this.inFlight.get(url)).clone();
    } catch {
      return new Response(null, { status: 503 });
    } finally {
      this.inFlight.delete(url);
    }
  }

  async load(url) {
    const cache = caches.default;
    const cached = await cache.match(url);
    const now = Date.now();
    if (cached && Date.parse(cached.headers.get("Expires")) > now) return cached;

    this.started = this.started.filter((time) => now - time < 1_000);
    if (this.started.length >= 10) throw badForecast();
    this.started.push(now);

    const headers = new Headers({ "User-Agent": userAgent, Accept: "application/json" });
    const previous = cached?.headers.get("Last-Modified");
    if (previous) headers.set("If-Modified-Since", previous);
    const upstream = await fetch(url, { headers, signal: AbortSignal.timeout(5_000), redirect: "follow", cache: "no-store" });
    const expires = upstream.headers.get("Expires");
    const modified = upstream.headers.get("Last-Modified") ?? previous;
    const options = { headers: { "Cache-Control": "public, max-age=86400" } };
    if (expires) options.headers.Expires = expires;
    if (modified) options.headers["Last-Modified"] = modified;

    let document;
    if (upstream.status === 304 && cached) {
      document = await cached.json();
    } else if (upstream.ok && upstream.status !== 203) {
      document = await readForecastJson(upstream);
    } else {
      await upstream.body?.cancel();
      throw badForecast();
    }
    const result = Response.json(document, options);
    await cache.put(url, result.clone());
    return result;
  }
}
