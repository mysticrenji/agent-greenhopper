/**
 * Scheduled plant-monitoring agent.
 *
 * Runs hourly via Cron Trigger. The pipeline:
 *   1. Read current sensor state from Home Assistant (VPC binding)
 *   2. Roll up into D1 for long-term retention
 *   3. Assess each plant (deterministic rules)
 *   4. If escalate is true, call the model for a readable explanation
 *   5. Plan alerts (dedup, suppress, resolve)
 *   6. Send notifications via HA notify service
 *   7. Persist alert state and audit log to D1
 */

import {
  type Assessment,
  assess,
  DEFAULT_ALERT_POLICY,
  DEFAULT_WATERING_POLICY,
  type Finding,
  type PlantProfile,
  type PlantRegistry,
  planAlerts,
} from '@greenhopper/domain';
import {
  buildObservation,
  entityIdsOf,
  HassNotifier,
  HassReader,
  type HttpFetch,
  listNotifyServices,
  miFloraEntities,
  type PlantEntities,
  resolveNotifyTarget,
} from '@greenhopper/hass';
import {
  AlertStateRepository,
  type D1Like,
  NotificationLog,
  ReadingsRepository,
  rollupSeries,
  type StorableSignal,
} from '@greenhopper/storage';

// --- Env interface ---
interface Env {
  HASS: Fetcher;
  DB: D1Database;
  AI: Ai;
  HASS_BASE_URL: string;
  HASS_TOKEN: string;
  // Optional: override model
  AI_MODEL?: string;
  // Optional: explicit notify service
  NOTIFY_SERVICE?: string;
}

// --- Hardcoded registry (same as workers/mcp, move to KV in prod) ---
const PLANT_REGISTRY: PlantRegistry = [
  {
    id: 'monstera',
    name: 'Monstera Deliciosa',
    species: 'Monstera deliciosa',
    room: 'living-room',
    targets: {
      moisture: { min: 20, max: 60 },
      soilTemp: { min: 15, max: 30 },
      dli: { min: 4, max: 12 },
      vpd: { min: 0.4, max: 1.6 },
      conductivity: { min: 200, max: 1500 },
    },
    watering: DEFAULT_WATERING_POLICY,
  },
  {
    id: 'curry-leaves',
    name: 'Curry Leaves',
    species: 'Murraya koenigii',
    room: 'green-room',
    targets: {
      // Curry leaf prefers a warm, bright, well-drained setting; tune the DLI and EC
      // bands against this plant's observed baseline rather than treating them as universal.
      moisture: { min: 20, max: 50 },
      soilTemp: { min: 18, max: 32 },
      dli: { min: 4, max: 16 },
      vpd: { min: 0.6, max: 1.6 },
      conductivity: { min: 200, max: 1500 },
    },
    watering: DEFAULT_WATERING_POLICY,
  },
];

const ENTITY_REGISTRY: PlantEntities[] = [
  miFloraEntities({
    plantId: 'monstera',
    deviceSlug: 'monstera_flower_care',
    airSensorSlug: 'living_room_climate',
  }),
  {
    plantId: 'curry-leaves',
    moisture: 'sensor.ble_moisture_5c857e13542f',
    soilTemp: 'sensor.ble_temperature_5c857e13542f',
    lux: 'sensor.ble_illuminance_5c857e13542f',
    conductivity: 'sensor.ble_conductivity_5c857e13542f',
    airTemp: 'sensor.curry_leaves_temperature_2',
    humidity: 'sensor.curry_leaves_humidity_2',
  },
];

const DEFAULT_MODEL = '@cf/ibm-granite/granite-4.0-h-micro';
const HISTORY_WINDOW_MS = 48 * 60 * 60_000; // 48 hours for trend analysis

// --- HttpFetch adapter for VPC binding ---
function createHttpFetch(env: Env): HttpFetch {
  return async (url, init) => {
    const opts: RequestInit = { method: init?.method ?? 'GET' };
    if (init?.headers) opts.headers = init.headers;
    if (init?.body) opts.body = init.body;
    const response = await env.HASS.fetch(new Request(url, opts));
    return {
      ok: response.ok,
      status: response.status,
      json: () => response.json() as Promise<unknown>,
      text: () => response.text(),
    };
  };
}

// --- Signal mapping for rollup ---
const SIGNAL_ENTRIES: ReadonlyArray<
  readonly [StorableSignal, keyof Omit<PlantEntities, 'plantId'>]
> = [
  ['moisture', 'moisture'],
  ['soilTemp', 'soilTemp'],
  ['lux', 'lux'],
  ['conductivity', 'conductivity'],
  ['battery', 'battery'],
  ['airTemp', 'airTemp'],
  ['humidity', 'humidity'],
];

interface PlantContext {
  readonly reader: HassReader;
  readonly readingsRepo: ReadingsRepository;
  readonly now: number;
}

/** Process one plant: read history, rollup, assess, escalate if needed. */
async function processPlant(
  env: Env,
  profile: PlantProfile,
  entities: PlantEntities,
  ctx: PlantContext,
): Promise<readonly Finding[]> {
  const ids = entityIdsOf(entities);
  const windowStart = ctx.now - HISTORY_WINDOW_MS;

  const history = await ctx.reader.history(ids, windowStart, ctx.now);

  // Roll up into D1 for long-term retention
  const signalMap: Partial<Record<StorableSignal, readonly { value: number; at: number }[]>> = {};
  for (const [signal, key] of SIGNAL_ENTRIES) {
    const entityId = entities[key];
    if (!entityId) continue;
    const series = history.get(entityId);
    if (series) signalMap[signal] = series;
  }
  const rows = rollupSeries(profile.id, signalMap);
  if (rows.length > 0) await ctx.readingsRepo.upsert(rows);

  // Assess with deterministic rules
  const observation = buildObservation({ profile, entities, history, now: ctx.now });
  const assessment = assess(observation);

  // LLM escalation when rules flag something beyond their reach
  if (assessment.escalate) {
    await escalateToModel(env, profile, assessment);
  }

  return assessment.findings;
}

/** Send push notifications for actions that merit them. */
async function deliverNotifications(
  notifier: HassNotifier,
  actions: readonly import('@greenhopper/domain').AlertAction[],
): Promise<void> {
  for (const action of actions) {
    if (action.kind === 'notify' && action.channel === 'push') {
      await notifier.send({ title: `🌱 ${action.plantId}`, message: action.message });
    } else if (action.kind === 'resolve') {
      await notifier.send({ title: `✅ ${action.plantId}`, message: action.message });
    }
  }
}

// --- Main check pipeline ---
async function checkPlants(env: Env): Promise<void> {
  const now = Date.now();
  const http = createHttpFetch(env);
  const config = { baseUrl: env.HASS_BASE_URL, token: env.HASS_TOKEN };
  const reader = new HassReader(http, config);
  const db = env.DB as unknown as D1Like;
  const readingsRepo = new ReadingsRepository(db);
  const alertStateRepo = new AlertStateRepository(db);
  const notificationLog = new NotificationLog(db);

  // Resolve notify target at runtime (self-discovering, no config needed)
  const available = await listNotifyServices(http, config);
  const resolution = resolveNotifyTarget(available, env.NOTIFY_SERVICE);
  if (!resolution) {
    console.error('No notify services available in Home Assistant. Aborting.');
    return;
  }
  const notifier = new HassNotifier(http, config, resolution.service);

  const plantIds = PLANT_REGISTRY.map((p) => p.id);
  const previousStates = await alertStateRepo.loadForPlants(plantIds);
  const findingsByPlant = new Map<string, readonly Finding[]>();
  const plantCtx: PlantContext = { reader, readingsRepo, now };

  for (const profile of PLANT_REGISTRY) {
    const entities = ENTITY_REGISTRY.find((e) => e.plantId === profile.id);
    if (!entities) continue;
    const findings = await processPlant(env, profile, entities, plantCtx);
    findingsByPlant.set(profile.id, findings);
  }

  // Plan alerts (dedup, suppress, resolve based on stored state)
  const plan = planAlerts({ now, policy: DEFAULT_ALERT_POLICY, findingsByPlant, previousStates });

  await deliverNotifications(notifier, plan.actions);
  await alertStateRepo.replaceForPlants(plantIds, plan.nextStates);
  await notificationLog.append(plan.actions, now);
}

// --- LLM escalation ---
async function escalateToModel(
  env: Env,
  profile: PlantProfile,
  assessment: Assessment,
): Promise<string | null> {
  const model = env.AI_MODEL ?? DEFAULT_MODEL;
  const findings = assessment.findings
    .filter((f) => f.severity !== 'ok' && f.severity !== 'info')
    .map((f) => `[${f.severity}] ${f.code}: ${f.message}`)
    .join('\n');

  if (!findings) return null;

  try {
    const response = (await env.AI.run(model as Parameters<Ai['run']>[0], {
      messages: [
        {
          role: 'system',
          content:
            'You are a plant health advisor. Given sensor findings for a plant, ' +
            'provide a brief, actionable explanation in 2-3 sentences. ' +
            'Be specific about what the owner should check or do. ' +
            `Plant: ${profile.name} (${profile.species}), room: ${profile.room}.`,
        },
        {
          role: 'user',
          content: `Current findings:\n${findings}\n\nDerived metrics: ${JSON.stringify(assessment.derived)}`,
        },
      ],
    })) as { response?: string };

    return response?.response ?? null;
  } catch (error) {
    console.error('LLM escalation failed:', error instanceof Error ? error.message : error);
    return null;
  }
}

// --- Worker exports ---
export default {
  async scheduled(
    _controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    ctx.waitUntil(checkPlants(env));
  },

  // Allow manual trigger via HTTP for testing
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    if (new URL(request.url).pathname === '/run') {
      await checkPlants(env);
      return new Response('OK', { status: 200 });
    }
    return new Response('Not found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;
