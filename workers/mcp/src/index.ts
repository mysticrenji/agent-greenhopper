/**
 * Remote MCP server — composition root.
 *
 * Stateless: each request creates a fresh McpServer with tools wired to env
 * bindings. No session state, no Durable Object.
 *
 * Tools are read-only by design (ADR 0003). They surface plant data for external
 * clients such as Claude, ChatGPT, or Kiro.
 */

import type { PlantProfile, PlantRegistry } from '@greenhopper/domain';
import { assess, DEFAULT_WATERING_POLICY, derive } from '@greenhopper/domain';
import type { HttpFetch, HttpResponse } from '@greenhopper/hass';
import {
  buildObservation,
  entityIdsOf,
  HassReader,
  miFloraEntities,
  type PlantEntities,
} from '@greenhopper/hass';
import { AlertStateRepository, type D1Like, ReadingsRepository } from '@greenhopper/storage';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Environment — VPC Fetcher + D1
// ---------------------------------------------------------------------------

interface Env {
  HASS: Fetcher;
  DB: D1Database;
  HASS_BASE_URL: string;
  HASS_TOKEN: string;
}

// ---------------------------------------------------------------------------
// Hardcoded example plant registry (production: KV or config)
// ---------------------------------------------------------------------------

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
];

const ENTITY_REGISTRY: PlantEntities[] = [
  miFloraEntities({
    plantId: 'monstera',
    deviceSlug: 'monstera_flower_care',
    airSensorSlug: 'living_room_climate',
  }),
];

// ---------------------------------------------------------------------------
// Adapter: VPC Fetcher -> HttpFetch
// ---------------------------------------------------------------------------

/**
 * Adapt the Workers VPC Fetcher binding to the structural HttpFetch the hass
 * package expects. The Fetcher returns a standard Response; HttpResponse is a
 * strict subset so a simple wrapper suffices.
 */
function adaptFetcher(fetcher: Fetcher): HttpFetch {
  return async (url, init) => {
    const opts: RequestInit = {};
    if (init?.method) opts.method = init.method;
    if (init?.headers) opts.headers = init.headers;
    if (init?.body) opts.body = init.body;
    const request = new Request(url, opts);
    const response = await fetcher.fetch(request);
    const adapted: HttpResponse = {
      ok: response.ok,
      status: response.status,
      json: () => response.json() as Promise<unknown>,
      text: () => response.text(),
    };
    return adapted;
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function findProfile(plantId: string): PlantProfile | undefined {
  return PLANT_REGISTRY.find((p) => p.id === plantId);
}

function findEntities(plantId: string): PlantEntities | undefined {
  return ENTITY_REGISTRY.find((e) => e.plantId === plantId);
}

function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function resolveContext(env: Env, plantId: string) {
  const profile = findProfile(plantId);
  if (!profile) throw new Error(`Unknown plant: ${plantId}`);

  const entities = findEntities(plantId);
  if (!entities) throw new Error(`No entities configured for plant: ${plantId}`);

  const http = adaptFetcher(env.HASS);
  const reader = new HassReader(http, {
    baseUrl: env.HASS_BASE_URL,
    token: env.HASS_TOKEN,
  });

  return { reader, profile, entities };
}

// ---------------------------------------------------------------------------
// MCP Server factory — closes over env for tool handlers
// ---------------------------------------------------------------------------

function createServerFactory(env: Env) {
  return () => {
    const server = new McpServer({
      name: 'greenhopper',
      version: '1.0.0',
    });

    // -- list_plants --------------------------------------------------------

    server.registerTool(
      'list_plants',
      {
        description: 'List all monitored plants with their profiles.',
        inputSchema: {},
      },
      async () => {
        const plants = PLANT_REGISTRY.map((p) => ({
          id: p.id,
          name: p.name,
          species: p.species,
          room: p.room,
        }));
        return textResult(JSON.stringify(plants, null, 2));
      },
    );

    // -- get_plant_snapshot -------------------------------------------------

    server.registerTool(
      'get_plant_snapshot',
      {
        description: 'Get the current sensor readings and health assessment for a plant.',
        inputSchema: { plantId: z.string().describe('Plant identifier') },
      },
      async ({ plantId }) => {
        const { reader, profile, entities } = resolveContext(env, plantId);

        const now = Date.now();
        const oneHourAgo = now - 60 * 60_000;
        const ids = entityIdsOf(entities);
        const history = await reader.history(ids, oneHourAgo, now);

        const observation = buildObservation({ profile, entities, history, now });
        const assessment = assess(observation);

        return textResult(
          JSON.stringify(
            {
              derived: assessment.derived,
              findings: assessment.findings,
              severity: assessment.severity,
            },
            null,
            2,
          ),
        );
      },
    );

    // -- get_plant_history --------------------------------------------------

    server.registerTool(
      'get_plant_history',
      {
        description: 'Get stored reading rollups for a plant over a time window.',
        inputSchema: {
          plantId: z.string().describe('Plant identifier'),
          hoursBack: z
            .number()
            .positive()
            .default(24)
            .describe('How many hours of history to return'),
        },
      },
      async ({ plantId, hoursBack }) => {
        const profile = findProfile(plantId);
        if (!profile) return textResult(`Unknown plant: ${plantId}`);

        const repo = new ReadingsRepository(env.DB as unknown as D1Like);
        const now = Date.now();
        const from = now - hoursBack * 60 * 60_000;
        const rows = await repo.window(plantId, from, now);

        return textResult(JSON.stringify({ plantId, from, to: now, rows }, null, 2));
      },
    );

    // -- get_plant_trends ---------------------------------------------------

    server.registerTool(
      'get_plant_trends',
      {
        description:
          'Get derived metrics (dry-down rate, DLI, VPD, normalised EC) from recent sensor data.',
        inputSchema: { plantId: z.string().describe('Plant identifier') },
      },
      async ({ plantId }) => {
        const { reader, profile, entities } = resolveContext(env, plantId);

        const now = Date.now();
        const twentyFourHoursAgo = now - 24 * 60 * 60_000;
        const ids = entityIdsOf(entities);
        const history = await reader.history(ids, twentyFourHoursAgo, now);

        const observation = buildObservation({ profile, entities, history, now });
        const derived = derive(observation);

        return textResult(JSON.stringify({ plantId, derived }, null, 2));
      },
    );

    // -- get_sensor_health --------------------------------------------------

    server.registerTool(
      'get_sensor_health',
      {
        description:
          'Check sensor health: staleness, plausibility, battery, and pinning for a plant.',
        inputSchema: { plantId: z.string().describe('Plant identifier') },
      },
      async ({ plantId }) => {
        const { reader, profile, entities } = resolveContext(env, plantId);

        const now = Date.now();
        const oneHourAgo = now - 60 * 60_000;
        const ids = entityIdsOf(entities);
        const history = await reader.history(ids, oneHourAgo, now);

        const observation = buildObservation({ profile, entities, history, now });
        const assessment = assess(observation);

        const sensorCodes = new Set([
          'SENSOR_STALE',
          'SENSOR_IMPLAUSIBLE',
          'SENSOR_PINNED',
          'PROBE_UNRESPONSIVE',
          'BATTERY_LOW',
          'AIR_SENSOR_MISSING',
        ]);
        const sensorFindings = assessment.findings.filter((f) => sensorCodes.has(f.code));

        return textResult(
          JSON.stringify(
            { plantId, sensorFindings, overallSeverity: assessment.severity },
            null,
            2,
          ),
        );
      },
    );

    // -- get_active_alerts --------------------------------------------------

    server.registerTool(
      'get_active_alerts',
      {
        description: 'Get active (non-resolved) alert states for one or all plants.',
        inputSchema: {
          plantId: z.string().optional().describe('Plant identifier. Omit for all plants.'),
        },
      },
      async ({ plantId }) => {
        const repo = new AlertStateRepository(env.DB as unknown as D1Like);

        const states = plantId ? await repo.loadForPlants([plantId]) : await repo.loadAll();

        return textResult(JSON.stringify({ alerts: states }, null, 2));
      },
    );

    return server;
  };
}

// ---------------------------------------------------------------------------
// Worker export
// ---------------------------------------------------------------------------

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const handler = createMcpHandler(createServerFactory(env));
    return handler.fetch(request);
  },
} satisfies ExportedHandler<Env>;
