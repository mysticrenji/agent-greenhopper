import { describe, expect, it } from 'vitest';
import { assertNotifyService, HassNotifier } from './notifier.js';
import type { HassConfig, HttpFetch } from './transport.js';

const CONFIG: HassConfig = { baseUrl: 'http://ha.test:8123', token: 't' };

function capturing() {
  const calls: { url: string; method?: string | undefined; body?: string | undefined }[] = [];
  const http: HttpFetch = async (url, init) => {
    calls.push({ url, method: init?.method, body: init?.body });
    return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
  };
  return { http, calls };
}

describe('HassNotifier', () => {
  it('posts to the configured notify service', async () => {
    const { http, calls } = capturing();
    await new HassNotifier(http, CONFIG, 'mobile_app_pixel_9').send({
      title: 'Monstera',
      message: 'Soil moisture is below target.',
    });

    expect(calls[0]?.url).toBe('http://ha.test:8123/api/services/notify/mobile_app_pixel_9');
    expect(calls[0]?.method).toBe('POST');
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({
      title: 'Monstera',
      message: 'Soil moisture is below target.',
    });
  });

  it('only ever targets the notify domain', async () => {
    const { http, calls } = capturing();
    await new HassNotifier(http, CONFIG, 'persistent_notification').send({
      title: 't',
      message: 'm',
    });

    // The read-only guarantee depends on this: no constructible path reaches
    // switch, light, or any other actuating domain.
    expect(calls[0]?.url).toContain('/api/services/notify/');
  });
});

describe('assertNotifyService', () => {
  it('accepts conventional service names', () => {
    for (const service of ['mobile_app_pixel_9', 'persistent_notification', 'notify']) {
      expect(() => assertNotifyService(service)).not.toThrow();
    }
  });

  it('rejects path traversal that would escape the notify domain', () => {
    // Without this, a config value could silently acquire actuation.
    for (const service of ['../switch/turn_on', 'switch/turn_on', 'a/b', '..', 'a b', 'A_B', '']) {
      expect(() => assertNotifyService(service)).toThrow(/Invalid notify service/);
    }
  });

  it('is validated at construction, not at send time', () => {
    const { http } = capturing();
    expect(() => new HassNotifier(http, CONFIG, '../switch/turn_on')).toThrow();
  });
});
