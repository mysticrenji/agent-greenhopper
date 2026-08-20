/**
 * HTTP transport abstraction.
 *
 * Deliberately structural and minimal rather than typed against `fetch` or
 * Cloudflare's `Fetcher`. Two reasons:
 *
 *   1. Layering. `packages/hass` must not import Cloudflare types (see AGENTS.md
 *      section 4). A Workers VPC binding is adapted at the composition root with
 *      a one-line arrow function.
 *   2. Testability. Tests supply a plain object literal, with no network, no
 *      `undici` and no Workers runtime.
 *
 * In a Worker, wire it up as:
 *
 *     const http: HttpFetch = (url, init) => env.HASS.fetch(url, init);
 */

export interface HttpResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

export interface HttpRequestInit {
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
}

export type HttpFetch = (url: string, init?: HttpRequestInit) => Promise<HttpResponse>;

export interface HassConfig {
  /**
   * Base URL of Home Assistant, without a trailing slash. With Workers VPC the
   * VPC Service pins the real host and port, so this only needs to carry a valid
   * origin — for example `http://home-assistant.default.svc.cluster.local:8123`.
   */
  readonly baseUrl: string;
  /** Long-lived access token for a Home Assistant user scoped to plant entities. */
  readonly token: string;
}

export class HassError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly path: string,
  ) {
    super(message);
    this.name = 'HassError';
  }
}

/**
 * Issue a request against Home Assistant and parse the JSON body.
 *
 * Throws `HassError` rather than returning a result type: an unreachable Home
 * Assistant is an operational failure the agent must surface, not a data
 * condition callers should silently pattern-match away. Contrast with the domain
 * layer, which returns `null` for merely insufficient data.
 */
export async function requestJson(
  http: HttpFetch,
  config: HassConfig,
  path: string,
  init?: HttpRequestInit,
): Promise<unknown> {
  const url = `${config.baseUrl}${path}`;

  let response: HttpResponse;
  try {
    response = await http(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${config.token}`,
        'Content-Type': 'application/json',
        ...init?.headers,
      },
    });
  } catch (cause) {
    throw new HassError(
      `Home Assistant unreachable: ${cause instanceof Error ? cause.message : String(cause)}`,
      null,
      path,
    );
  }

  if (!response.ok) {
    // 401 here almost always means an expired or wrong long-lived token.
    throw new HassError(`Home Assistant returned ${response.status}`, response.status, path);
  }

  return response.json();
}
