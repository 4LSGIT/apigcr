'use strict';

const weather = require('../services/assistantWeatherService');

describe('assistant weather adapter', () => {
  test('constructs fixed-provider geocoding and forecast requests', async () => {
    const urls = [];
    const fetchImpl = jest.fn(async (url) => {
      urls.push(String(url));
      if (String(url).includes('geocoding-api')) return { ok: true, json: async () => ({ results: [{ name: 'Detroit', admin1: 'Michigan', country: 'United States', latitude: 42.33, longitude: -83.05, timezone: 'America/Detroit' }] }) };
      return { ok: true, json: async () => ({ timezone: 'America/Detroit', current_units: { temperature_2m: '°F' }, current: { time: '2026-10-18T10:00', temperature_2m: 55 } }) };
    });
    const out = await weather.current('Detroit, Michigan', { fetchImpl });
    expect(out).toMatchObject({ location: 'Detroit, Michigan, United States', temperature_2m: 55, provider: 'Open-Meteo' });
    expect(urls[0]).toMatch(/^https:\/\/geocoding-api\.open-meteo\.com\/v1\/search\?/);
    expect(urls[1]).toMatch(/^https:\/\/api\.open-meteo\.com\/v1\/forecast\?/);
    expect(urls[1]).toContain('timezone=auto');
  });

  test('rejects a location the provider cannot resolve', async () => {
    const fetchImpl = jest.fn(async () => ({ ok: true, json: async () => ({ results: [] }) }));
    await expect(weather.current('Not-a-place', { fetchImpl })).rejects.toMatchObject({ status: 404 });
  });
});
