import { describe, expect, it } from 'vitest';
import {
  type HassConfig,
  HassError,
  type HttpFetch,
  type HttpResponse,
  requestJson,
} from './transport.js';

const CONFIG: HassConfig = { baseUrl: 'http://ha.test:8123', token: 'secret-token' };

interface Call {
  url: string;
  method?: string | undefined;
  headers?: Readonly<Record<string, string>> | undefined;
  body?: string | undefined;
}

/** Records calls and returns a canned response, so tests need no network. */
function stub(response: Partial<HttpResponse> & { body?: unknown }) {
  const calls: Call[] = [];
  const http: HttpFetch = async (url, init) => {
    calls.push({ url, method: init?.method, headers: init?.headers, body: init?.body });
    return {
      ok: response.ok ?? true,
      status: response.status ?? 200,
      json: async () => response.body ?? {},
      text: async () => JSON.stringify(response.body ?? {}),
    };
  };
  return { http, calls };
}

describe('requestJson', () => {
  it('attaches the bearer token and content type', async () => {
    const { http, calls } = stub({ body: { ok: true } });
    await requestJson(http, CONFIG, '/api/states');

    expect(calls[0]?.url).toBe('http://ha.test:8123/api/states');
    expect(calls[0]?.headers).toMatchObject({
      Authorization: 'Bearer secret-token',
      'Content-Type': 'application/json',
    });
  });

  it('returns the parsed body', async () => {
    const { http } = stub({ body: [{ entity_id: 'sensor.x', state: '1' }] });
    await expect(requestJson(http, CONFIG, '/api/states')).resolves.toEqual([
      { entity_id: 'sensor.x', state: '1' },
    ]);
  });

  it('passes through method and body for service calls', async () => {
    const { http, calls } = stub({ body: {} });
    await requestJson(http, CONFIG, '/api/services/notify/x', {
      method: 'POST',
      body: '{"message":"hi"}',
    });

    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.body).toBe('{"message":"hi"}');
  });

  it('throws HassError with the status on a non-ok response', async () => {
    const { http } = stub({ ok: false, status: 401 });
    const error = await requestJson(http, CONFIG, '/api/states').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(HassError);
    expect(error).toMatchObject({ status: 401, path: '/api/states' });
  });

  it('wraps transport failures with a null status', async () => {
    const http: HttpFetch = async () => {
      throw new Error('tunnel down');
    };
    const error = await requestJson(http, CONFIG, '/api/states').catch((e: unknown) => e);

    // An unreachable Home Assistant is operational failure, not a data condition.
    expect(error).toBeInstanceOf(HassError);
    expect(error).toMatchObject({ status: null });
    expect((error as HassError).message).toContain('tunnel down');
  });
});
