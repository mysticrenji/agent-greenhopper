import { describe, expect, it } from 'vitest';
import { checkSetup, expectedEntityCount, summarise } from './diagnostics.js';
import { miFloraEntities } from './entities.js';
import { HassReader } from './reader.js';
import type { HassConfig, HttpFetch } from './transport.js';

const CONFIG: HassConfig = { baseUrl: 'http://ha.test:8123', token: 't' };
const AT = '2026-06-15T12:00:00+00:00';

const ENTITIES = miFloraEntities({
  plantId: 'monstera',
  deviceSlug: 'monstera_fc',
  airSensorSlug: 'lr_climate',
});

/** Builds an /api/states payload from an entity-id -> state map. */
function reader(states: Record<string, string>): HassReader {
  const body = Object.entries(states).map(([entity_id, state]) => ({
    entity_id,
    state,
    last_updated: AT,
  }));
  const http: HttpFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => '',
  });
  return new HassReader(http, CONFIG);
}

const healthy = {
  [ENTITIES.moisture]: '35',
  [ENTITIES.soilTemp]: '21',
  [ENTITIES.lux]: '8000',
  [ENTITIES.conductivity]: '800',
  [ENTITIES.battery]: '85',
  [ENTITIES.airTemp]: '22',
  [ENTITIES.humidity]: '55',
};

describe('checkSetup', () => {
  it('confirms firmware is adequate when all four soil signals report numbers', async () => {
    // Home Assistant states that firmware below 3.2.1 sends no usable beacons, so
    // four live soil signals settle the firmware question without the vendor app.
    const [report] = await checkSetup(reader(healthy), [ENTITIES]);

    expect(report?.soilSignalsHealthy).toBe(true);
    expect(report?.vpdAvailable).toBe(true);
    expect(report?.unknownEntities).toEqual([]);
  });

  it('flags an entity Home Assistant has never heard of', async () => {
    const { [ENTITIES.lux]: _dropped, ...missingLux } = healthy;
    const [report] = await checkSetup(reader(missingLux), [ENTITIES]);

    expect(report?.unknownEntities).toEqual([ENTITIES.lux]);
    expect(report?.soilSignalsHealthy).toBe(false);
  });

  it('distinguishes a temporarily unavailable sensor from a missing one', async () => {
    const [report] = await checkSetup(reader({ ...healthy, [ENTITIES.moisture]: 'unavailable' }), [
      ENTITIES,
    ]);

    const moisture = report?.entities.find((e) => e.signal === 'moisture');
    expect(moisture?.status).toBe('absent');
    expect(report?.unknownEntities).toEqual([]);
  });

  it('flags a non-numeric state', async () => {
    const [report] = await checkSetup(reader({ ...healthy, [ENTITIES.lux]: 'on' }), [ENTITIES]);
    expect(report?.entities.find((e) => e.signal === 'lux')?.status).toBe('non-numeric');
  });

  it('reports VPD unavailable when the room climate sensor is absent', async () => {
    const { [ENTITIES.humidity]: _dropped, ...noHumidity } = healthy;
    const [report] = await checkSetup(reader(noHumidity), [ENTITIES]);

    expect(report?.vpdAvailable).toBe(false);
    // Soil is still fine — the two concerns are independent.
    expect(report?.soilSignalsHealthy).toBe(true);
  });

  it('does not treat a dead battery entity as a soil-signal failure', async () => {
    // Battery is read once a day over an active connection, so it lags.
    const { [ENTITIES.battery]: _dropped, ...noBattery } = healthy;
    const [report] = await checkSetup(reader(noBattery), [ENTITIES]);

    expect(report?.soilSignalsHealthy).toBe(true);
  });

  it('reports on every plant in the registry', async () => {
    const second = miFloraEntities({
      plantId: 'fern',
      deviceSlug: 'fern_fc',
      airSensorSlug: 'lr_climate',
    });
    const reports = await checkSetup(reader(healthy), [ENTITIES, second]);

    expect(reports.map((r) => r.plantId)).toEqual(['monstera', 'fern']);
    expect(reports[1]?.soilSignalsHealthy).toBe(false);
  });
});

describe('summarise', () => {
  it('states plainly that firmware is adequate when soil signals are live', async () => {
    const lines = summarise(await checkSetup(reader(healthy), [ENTITIES]));
    expect(lines.join('\n')).toContain('firmware is adequate');
  });

  it('points at firmware and BLE range when soil signals are incomplete', async () => {
    const { [ENTITIES.conductivity]: _dropped, ...partial } = healthy;
    const lines = summarise(await checkSetup(reader(partial), [ENTITIES]));

    const text = lines.join('\n');
    expect(text).toContain('3.2.1');
    expect(text).toContain('BLE proxy');
  });

  it('explains that Mi Flora cannot supply humidity', async () => {
    const { [ENTITIES.humidity]: _dropped, ...noHumidity } = healthy;
    const lines = summarise(await checkSetup(reader(noHumidity), [ENTITIES]));

    expect(lines.join('\n')).toContain('cannot measure humidity');
  });

  it('lists unknown entity ids so typos are obvious', async () => {
    const lines = summarise(await checkSetup(reader({}), [ENTITIES]));
    expect(lines.join('\n')).toContain('unknown entity ID');
  });

  it('is quiet when everything is healthy apart from the positive confirmation', async () => {
    const lines = summarise(await checkSetup(reader(healthy), [ENTITIES]));
    expect(lines).toHaveLength(1);
  });
});

describe('expectedEntityCount', () => {
  it('counts distinct entities, collapsing a shared room sensor', () => {
    const second = miFloraEntities({
      plantId: 'fern',
      deviceSlug: 'fern_fc',
      airSensorSlug: 'lr_climate',
    });
    expect(expectedEntityCount([ENTITIES, second])).toBe(12);
  });
});
