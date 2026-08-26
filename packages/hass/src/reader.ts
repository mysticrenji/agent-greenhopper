/**
 * Read-only Home Assistant access.
 *
 * This class exposes state and history and nothing else. There is deliberately no
 * generic `callService` method: the primary safety property of the system is that
 * it cannot mutate Home Assistant, and the cheapest way to guarantee that is to
 * never provide the capability (ADR 0003). Notifications are the sole permitted
 * egress and live in `notifier.ts` as a single narrowly-typed operation.
 */

import type { Sample, Series } from '@greenhopper/domain';
import {
  type HassHistoryEntry,
  type HassState,
  hassHistorySchema,
  hassStatesSchema,
  toSample,
} from './schema.js';
import { type HassConfig, type HttpFetch, requestJson } from './transport.js';

export class HassReader {
  constructor(
    private readonly http: HttpFetch,
    private readonly config: HassConfig,
  ) {}

  /** Current state of every entity, keyed by entity ID. */
  async states(): Promise<Map<string, HassState>> {
    const raw = await requestJson(this.http, this.config, '/api/states');
    const parsed = hassStatesSchema.parse(raw);
    return new Map(parsed.map((state) => [state.entity_id, state]));
  }

  /**
   * Latest numeric sample per entity, with absent and non-numeric states dropped.
   *
   * Entities that are `unavailable` are simply missing from the result. Callers
   * treat a missing signal as a staleness finding rather than an error, which is
   * what `assess()` already does.
   */
  async latestSamples(entityIds: readonly string[]): Promise<Map<string, Sample>> {
    const states = await this.states();
    const samples = new Map<string, Sample>();

    for (const id of entityIds) {
      const state = states.get(id);
      if (!state) continue;
      const sample = toSample(state);
      if (sample) samples.set(id, sample);
    }

    return samples;
  }

  /**
   * Historical series per entity over [startMs, endMs].
   *
   * Uses `minimal_response` and `no_attributes` because this project only ever
   * needs the numeric value and its timestamp; attributes on a long window are
   * pure payload waste over the tunnel. Note that `minimal_response` omits
   * `entity_id` on all but the first entry of each series, so the entity is
   * recovered from that first entry and from request order.
   */
  async history(
    entityIds: readonly string[],
    startMs: number,
    endMs: number,
  ): Promise<Map<string, Series>> {
    if (entityIds.length === 0) return new Map();

    // Built by hand rather than with URLSearchParams: this package intentionally
    // compiles without DOM or Workers lib types, and Home Assistant expects
    // `minimal_response` and `no_attributes` as bare flags rather than `flag=`.
    const query = [
      `filter_entity_id=${encodeURIComponent(entityIds.join(','))}`,
      `end_time=${encodeURIComponent(new Date(endMs).toISOString())}`,
      'minimal_response',
      'no_attributes',
    ].join('&');
    const path = `/api/history/period/${new Date(startMs).toISOString()}?${query}`;

    const raw = await requestJson(this.http, this.config, path);
    const parsed = hassHistorySchema.parse(raw);

    return collectSeries(parsed, entityIds);
  }

  /**
   * Historical series with the current state appended per entity.
   *
   * Recorder history is intentionally compressed and can omit repeated sensor
   * reports whose value did not change. The state endpoint carries
   * `last_reported`, so merging it prevents stable readings from looking stale.
   */
  async historyWithLatest(
    entityIds: readonly string[],
    startMs: number,
    endMs: number,
  ): Promise<Map<string, Series>> {
    const [history, current] = await Promise.all([
      this.history(entityIds, startMs, endMs),
      this.latestSamples(entityIds),
    ]);
    return mergeLatestSamples(history, current, entityIds);
  }
}

function mergeLatestSamples(
  history: ReadonlyMap<string, Series>,
  current: ReadonlyMap<string, Sample>,
  entityIds: readonly string[],
): Map<string, Series> {
  const merged = new Map<string, Series>();

  for (const entityId of entityIds) {
    const series = history.get(entityId) ?? [];
    const latest = current.get(entityId);
    if (!latest) {
      if (series.length > 0) merged.set(entityId, series);
      continue;
    }

    const insertionIndex = series.findIndex((sample) => sample.at >= latest.at);
    if (insertionIndex === -1) {
      merged.set(entityId, [...series, latest]);
      continue;
    }
    const afterLatest =
      series[insertionIndex]?.at === latest.at ? insertionIndex + 1 : insertionIndex;
    merged.set(entityId, [
      ...series.slice(0, insertionIndex),
      latest,
      ...series.slice(afterLatest),
    ]);
  }

  return merged;
}

/**
 * Turn Home Assistant's array-of-arrays history into a per-entity series.
 *
 * Home Assistant returns one inner array per entity that has data, in the order
 * requested, but omits entities with no history entirely — so position alone
 * cannot identify an entity. The first entry of each array carries `entity_id`;
 * request order is only the fallback.
 */
function collectSeries(
  groups: readonly (readonly HassHistoryEntry[])[],
  requested: readonly string[],
): Map<string, Series> {
  const result = new Map<string, Series>();

  groups.forEach((group, index) => {
    const entityId = group[0]?.entity_id ?? requested[index];
    if (!entityId) return;

    const samples = group
      .map(toSample)
      .filter((s): s is Sample => s !== null)
      .sort((a, b) => a.at - b.at);

    if (samples.length > 0) result.set(entityId, samples);
  });

  return result;
}
