// Narrow external-data adapter for Ask Casey/YisrAI. The model can request a
// location name, but it never controls a URL: both hosts and all parameters
// are constructed here. Open-Meteo needs no credential for its public tier;
// deployments using a commercial plan can set OPEN_METEO_API_KEY and
// OPEN_METEO_HOST (for example customer-api.open-meteo.com).

'use strict';

const TIMEOUT_MS = 10000;

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

async function getJson(url, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json', 'User-Agent': 'YisraCase/1.0' },
    });
    if (!res.ok) throw httpError(502, `Weather provider returned HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    if (err && err.name === 'AbortError') throw httpError(504, 'The weather lookup timed out');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function apiKey(url) {
  if (process.env.OPEN_METEO_API_KEY) url.searchParams.set('apikey', process.env.OPEN_METEO_API_KEY);
  return url;
}

async function current(location, { fetchImpl = global.fetch } = {}) {
  const place = String(location || '').trim();
  if (place.length < 2 || place.length > 120) throw httpError(422, 'Weather location must be 2-120 characters');
  if (typeof fetchImpl !== 'function') throw httpError(500, 'Weather lookup is unavailable in this runtime');

  const geoHost = process.env.OPEN_METEO_GEOCODING_HOST || 'geocoding-api.open-meteo.com';
  const weatherHost = process.env.OPEN_METEO_HOST || 'api.open-meteo.com';
  const geoUrl = apiKey(new URL(`https://${geoHost}/v1/search`));
  geoUrl.searchParams.set('name', place);
  geoUrl.searchParams.set('count', '1');
  geoUrl.searchParams.set('language', 'en');
  geoUrl.searchParams.set('format', 'json');
  const geo = await getJson(geoUrl, fetchImpl);
  const found = geo && Array.isArray(geo.results) ? geo.results[0] : null;
  if (!found || !Number.isFinite(Number(found.latitude)) || !Number.isFinite(Number(found.longitude))) {
    throw httpError(404, `No weather location matched “${place}”`);
  }

  const weatherUrl = apiKey(new URL(`https://${weatherHost}/v1/forecast`));
  weatherUrl.searchParams.set('latitude', String(found.latitude));
  weatherUrl.searchParams.set('longitude', String(found.longitude));
  weatherUrl.searchParams.set('current', 'temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,cloud_cover,wind_speed_10m,wind_direction_10m');
  weatherUrl.searchParams.set('temperature_unit', 'fahrenheit');
  weatherUrl.searchParams.set('wind_speed_unit', 'mph');
  weatherUrl.searchParams.set('precipitation_unit', 'inch');
  weatherUrl.searchParams.set('timezone', 'auto');
  const weather = await getJson(weatherUrl, fetchImpl);
  if (!weather || !weather.current) throw httpError(502, 'The weather provider returned no current conditions');

  return {
    location: [found.name, found.admin1, found.country].filter(Boolean).join(', '),
    latitude: Number(found.latitude),
    longitude: Number(found.longitude),
    timezone: weather.timezone || found.timezone || null,
    observed_at: weather.current.time || null,
    units: weather.current_units || {},
    ...weather.current,
    provider: 'Open-Meteo',
  };
}

module.exports = { current, TIMEOUT_MS };
