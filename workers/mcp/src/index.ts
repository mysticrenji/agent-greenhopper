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
  /** Cloudflare Access team domain, e.g. 'myteam.cloudflareaccess.com' */
  CF_ACCESS_TEAM_DOMAIN?: string;
  /** Cloudflare Access Application Audience (AUD) tag */
  CF_ACCESS_AUD?: string;
}

// ---------------------------------------------------------------------------
// Cloudflare Access JWT validation middleware
// ---------------------------------------------------------------------------

/**
 * Validates the Cf-Access-Jwt-Assertion header set by Cloudflare Access.
 *
 * Returns null if validation passes (allow the request through), or a 403
 * Response if validation fails.
 *
 * This performs lightweight validation: presence of the JWT, base64-decoding
 * the payload, and verifying the `aud` claim matches CF_ACCESS_AUD.
 *
 * NOTE: For production-grade validation, the JWT signature should be verified
 * against the JWKS endpoint at https://<team-domain>/cdn-cgi/access/certs.
 * Full JWKS verification requires a JWT library or manual RSA/ECDSA validation
 * which adds significant complexity. Cloudflare Access guarantees the header is
 * only present on requests that passed its authentication layer, so header
 * presence + aud matching provides a strong defence-in-depth layer.
 */
async function validateAccessJwt(request: Request, env: Env): Promise<Response | null> {
  const teamDomain = env.CF_ACCESS_TEAM_DOMAIN;
  const expectedAud = env.CF_ACCESS_AUD;

  // If Access is not configured, deny all requests — fail closed.
  if (!teamDomain || !expectedAud) {
    return new Response('Access not configured', { status: 403 });
  }

  const jwt = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!jwt) {
    return new Response('Missing access token', { status: 403 });
  }

  // Decode the JWT payload (second segment, base64url-encoded).
  try {
    const parts = jwt.split('.');
    if (parts.length !== 3) {
      return new Response('Malformed token', { status: 403 });
    }

    // Base64url → standard base64 → decode
    const payloadSegment = parts[1];
    if (!payloadSegment) {
      return new Response('Malformed token', { status: 403 });
    }
    const payloadB64 = payloadSegment.replace(/-/g, '+').replace(/_/g, '/');
    const payloadJson = atob(payloadB64);
    const payload = JSON.parse(payloadJson) as { aud?: unknown };

    // Validate audience claim
    const aud = payload.aud;
    const audMatches = Array.isArray(aud)
      ? (aud as unknown[]).includes(expectedAud)
      : aud === expectedAud;

    if (!audMatches) {
      return new Response('Invalid audience', { status: 403 });
    }
  } catch {
    return new Response('Token validation failed', { status: 403 });
  }

  // Validation passed — allow request through.
  return null;
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
  {
    id: 'curry-leaves',
    name: 'Curry Leaves',
    species: 'Murraya koenigii',
    room: 'green-room',
    targets: {
      // Tune light and EC against this plant's observed baseline after collecting history.
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
    // Cloudflare Access JWT validation — must pass before reaching any tool.
    const denied = await validateAccessJwt(request, env);
    if (denied) return denied;

    const handler = createMcpHandler(createServerFactory(env));
    return handler.fetch(request);
  },
} satisfies ExportedHandler<Env>;
