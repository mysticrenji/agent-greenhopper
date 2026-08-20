import { describe, expect, it } from 'vitest';
import { HassReader } from './reader.js';
import type { HassConfig, HttpFetch } from './transport.js';

const CONFIG: HassConfig = { baseUrl: 'http://ha.test:8123', token: 't' };

function reader(body: unknown, capture?: { url?: string }) {
  const http: HttpFetch = async (url) => {
    if (capture) capture.url = url;
    return { ok: true, status: 200, json: async () => body, text: async () => '' };
  };
  return new HassReader(http, CONFIG);
}

const AT = '2026-06-15T12:00:00+00:00';
const AT_MS = Date.UTC(2026, 5, 15, 12);

describe('HassReader.states', () => {
  it('keys states by entity id', async () => {
    const states = await reader([
      { entity_id: 'sensor.a', state: '1', last_updated: AT },
      { entity_id: 'sensor.b', state: '2', last_updated: AT },
    ]).states();

    expect([...states.keys()]).toEqual(['sensor.a', 'sensor.b']);
  });

  it('rejects a malformed payload rather than silently returning nothing', async () => {
    // A shape change in Home Assistant should be loud, not produce empty readings
    // that look like healthy-but-quiet sensors.
    await expect(reader([{ state: 42 }]).states()).rejects.toThrow();
  });
});

describe('HassReader.latestSamples', () => {
  it('returns numeric samples for the requested entities only', async () => {
    const samples = await reader([
      { entity_id: 'sensor.moisture', state: '35.5', last_updated: AT },
      { entity_id: 'sensor.other', state: '99', last_updated: AT },
    ]).latestSamples(['sensor.moisture']);

    expect(samples.get('sensor.moisture')).toEqual({ value: 35.5, at: AT_MS });
    expect(samples.has('sensor.other')).toBe(false);
  });

  it('omits unavailable entities instead of failing', async () => {
    // Downstream, a missing signal becomes a staleness finding — not an error.
    const samples = await reader([
      { entity_id: 'sensor.moisture', state: 'unavailable', last_updated: AT },
    ]).latestSamples(['sensor.moisture']);

    expect(samples.size).toBe(0);
  });

  it('omits entities Home Assistant does not know about', async () => {
    const samples = await reader([]).latestSamples(['sensor.missing']);
    expect(samples.size).toBe(0);
  });
});

describe('HassReader.history', () => {
  it('requests a minimal, attribute-free window', async () => {
    const capture: { url?: string } = {};
    const http: HttpFetch = async (url) => {
      capture.url = url;
      return { ok: true, status: 200, json: async () => [], text: async () => '' };
    };
    await new HassReader(http, CONFIG).history(['sensor.a', 'sensor.b'], AT_MS, AT_MS + 3_600_000);

    expect(capture.url).toContain('/api/history/period/2026-06-15T12:00:00.000Z');
    expect(capture.url).toContain('filter_entity_id=sensor.a%2Csensor.b');
    expect(capture.url).toContain('minimal_response');
    expect(capture.url).toContain('no_attributes');
  });

  it('does not call Home Assistant for an empty entity list', async () => {
    let called = false;
    const http: HttpFetch = async () => {
      called = true;
      return { ok: true, status: 200, json: async () => [], text: async () => '' };
    };
    const result = await new HassReader(http, CONFIG).history([], AT_MS, AT_MS);

    expect(called).toBe(false);
    expect(result.size).toBe(0);
  });

  it('groups entries into a series per entity, sorted oldest first', async () => {
    const body = [
      [
        { entity_id: 'sensor.a', state: '30', last_updated: '2026-06-15T12:00:00Z' },
        { state: '28', last_updated: '2026-06-15T13:00:00Z' },
      ],
    ];
    const result = await reader(body).history(['sensor.a'], AT_MS, AT_MS + 7_200_000);

    expect(result.get('sensor.a')).toEqual([
      { value: 30, at: Date.UTC(2026, 5, 15, 12) },
      { value: 28, at: Date.UTC(2026, 5, 15, 13) },
    ]);
  });

  it('identifies entities by the first entry, not by position', async () => {
    // Home Assistant omits entities with no history, so array position is unreliable.
    const body = [[{ entity_id: 'sensor.b', state: '5', last_updated: AT }]];
    const result = await reader(body).history(['sensor.a', 'sensor.b'], AT_MS, AT_MS);

    expect(result.has('sensor.b')).toBe(true);
    expect(result.has('sensor.a')).toBe(false);
  });

  it('drops absent readings from within a series', async () => {
    const body = [
      [
        { entity_id: 'sensor.a', state: '30', last_updated: '2026-06-15T12:00:00Z' },
        { state: 'unavailable', last_updated: '2026-06-15T12:30:00Z' },
        { state: '29', last_updated: '2026-06-15T13:00:00Z' },
      ],
    ];
    const result = await reader(body).history(['sensor.a'], AT_MS, AT_MS);

    expect(result.get('sensor.a')).toHaveLength(2);
  });

  it('omits an entity whose entries are all unusable', async () => {
    const body = [[{ entity_id: 'sensor.a', state: 'unknown', last_updated: AT }]];
    const result = await reader(body).history(['sensor.a'], AT_MS, AT_MS);

    expect(result.has('sensor.a')).toBe(false);
  });
});
