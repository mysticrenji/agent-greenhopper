/**
 * Remote MCP server — composition root.
 *
 * Stateless: each request creates a fresh McpServer with tools wired to env
 * bindings. No session state, no Durable Object.
 *
 * Tools are read-only by design (ADR 0003). They surface plant data for external
 * clients such as Claude, ChatGPT, or Kiro.
 */

import { ENTITY_REGISTRY, PLANT_REGISTRY } from '@greenhopper/config';
import type { PlantProfile } from '@greenhopper/domain';
import { assess, derive, isSensorFaultCode } from '@greenhopper/domain';
import type { HttpFetch, HttpResponse } from '@greenhopper/hass';
import {
  buildObservation,
  currentReadings,
  entityIdsOf,
  HassReader,
  type PlantEntities,
} from '@greenhopper/hass';
import { AlertStateRepository, type D1Like, ReadingsRepository } from '@greenhopper/storage';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { z } from 'zod';

const ASSESSMENT_HISTORY_MS = 48 * 60 * 60_000;
const ASSESSMENT_HISTORY_HOURS = ASSESSMENT_HISTORY_MS / 60 / 60_000;
const DLI_WINDOW_HOURS = 24;

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

const ACCESS_JWKS = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

// ---------------------------------------------------------------------------
// Cloudflare Access JWT validation middleware
// ---------------------------------------------------------------------------

/**
 * Validates the Cf-Access-Jwt-Assertion header set by Cloudflare Access.
 *
 * Returns null if validation passes (allow the request through), or a 403
 * Response if validation fails.
 *
 * Signature, issuer, audience and expiry are verified against the Access JWKS.
 * This remains necessary even behind Access because alternate routing mistakes
 * must not let a caller forge a trusted-looking assertion header.
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

  try {
    const issuer = normalizeTeamDomain(teamDomain);
    await jwtVerify(jwt, jwksFor(issuer), { issuer, audience: expectedAud });
  } catch {
    return new Response('Token validation failed', { status: 403 });
  }

  // Validation passed — allow request through.
  return null;
}

function normalizeTeamDomain(teamDomain: string): string {
  const withScheme = teamDomain.startsWith('https://') ? teamDomain : `https://${teamDomain}`;
  return withScheme.replace(/\/$/, '');
}

function jwksFor(issuer: string): ReturnType<typeof createRemoteJWKSet> {
  const cached = ACCESS_JWKS.get(issuer);
  if (cached) return cached;
  const jwks = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
  ACCESS_JWKS.set(issuer, jwks);
  return jwks;
}

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

async function loadCurrentObservation(env: Env, plantId: string) {
  const { reader, profile, entities } = resolveContext(env, plantId);
  const now = Date.now();
  const historyStart = now - ASSESSMENT_HISTORY_MS;
  const history = await reader.historyWithLatest(entityIdsOf(entities), historyStart, now);
  return { profile, observation: buildObservation({ profile, entities, history, now }) };
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
        const { profile, observation } = await loadCurrentObservation(env, plantId);
        const assessment = assess(observation);

        return textResult(
          JSON.stringify(
            {
              plant: {
                id: profile.id,
                name: profile.name,
                species: profile.species,
                room: profile.room,
              },
              observedAt: observation.now,
              current: currentReadings(observation),
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
        const { observation } = await loadCurrentObservation(env, plantId);
        const derived = derive(observation);

        return textResult(
          JSON.stringify(
            {
              plantId,
              observedAt: observation.now,
              historyWindowHours: ASSESSMENT_HISTORY_HOURS,
              dliWindowHours: DLI_WINDOW_HOURS,
              derived,
            },
            null,
            2,
          ),
        );
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
        const { observation } = await loadCurrentObservation(env, plantId);
        const assessment = assess(observation);

        const sensorFindings = assessment.findings.filter((f) => isSensorFaultCode(f.code));

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
