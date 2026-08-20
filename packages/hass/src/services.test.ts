import { describe, expect, it } from 'vitest';
import {
  describeResolution,
  FALLBACK_NOTIFY_SERVICE,
  listNotifyServices,
  resolveNotifyTarget,
} from './services.js';
import type { HassConfig, HttpFetch } from './transport.js';

const CONFIG: HassConfig = { baseUrl: 'http://ha.test:8123', token: 't' };

function http(body: unknown): HttpFetch {
  return async () => ({ ok: true, status: 200, json: async () => body, text: async () => '' });
}

describe('listNotifyServices', () => {
  it('extracts notify services from the documented array shape', async () => {
    const services = await listNotifyServices(
      http([
        { domain: 'switch', services: ['turn_on'] },
        { domain: 'notify', services: ['mobile_app_pixel_9', 'persistent_notification'] },
      ]),
      CONFIG,
    );
    expect(services).toEqual(['mobile_app_pixel_9', 'persistent_notification']);
  });

  it('also accepts the object-keyed shape some versions return', async () => {
    // Tolerating both avoids breaking on a Home Assistant upgrade.
    const services = await listNotifyServices(
      http([{ domain: 'notify', services: { mobile_app_iphone: {}, notify: {} } }]),
      CONFIG,
    );
    expect(services).toEqual(['mobile_app_iphone', 'notify']);
  });

  it('returns nothing when the notify integration is absent', async () => {
    const services = await listNotifyServices(http([{ domain: 'light', services: [] }]), CONFIG);
    expect(services).toEqual([]);
  });
});

describe('resolveNotifyTarget', () => {
  const available = ['mobile_app_pixel_9', 'notify', 'persistent_notification'];

  it('honours an explicitly configured service', () => {
    expect(resolveNotifyTarget(available, 'persistent_notification')).toEqual({
      service: 'persistent_notification',
      reason: 'configured',
    });
  });

  it('prefers a companion app target when nothing is configured', () => {
    // A notice in a web UI is not an alert; push to a phone is the point.
    expect(resolveNotifyTarget(available)).toEqual({
      service: 'mobile_app_pixel_9',
      reason: 'companion-app',
    });
  });

  it('falls back to discovery when the configured service does not exist', () => {
    // Covers a renamed phone, which silently invalidates the configured name.
    expect(resolveNotifyTarget(available, 'mobile_app_old_phone')).toMatchObject({
      service: 'mobile_app_pixel_9',
      reason: 'companion-app',
    });
  });

  it('picks persistent_notification when no companion app is registered', () => {
    expect(resolveNotifyTarget(['persistent_notification', 'notify'])).toEqual({
      service: FALLBACK_NOTIFY_SERVICE,
      reason: 'fallback',
    });
  });

  it('uses whatever single option exists as a last resort', () => {
    expect(resolveNotifyTarget(['smtp'])).toEqual({ service: 'smtp', reason: 'only-option' });
  });

  it('returns null when Home Assistant offers no notify services', () => {
    expect(resolveNotifyTarget([])).toBeNull();
  });

  it('is deterministic when several companion apps are registered', () => {
    const two = ['mobile_app_zeta', 'mobile_app_alpha'];
    expect(resolveNotifyTarget(two)?.service).toBe('mobile_app_alpha');
    expect(resolveNotifyTarget(two)).toEqual(resolveNotifyTarget(two));
  });
});

describe('describeResolution', () => {
  it('warns loudly when falling back to the UI only', () => {
    const message = describeResolution({ service: 'persistent_notification', reason: 'fallback' });
    // Silently losing push is only noticed when an alert is missed.
    expect(message).toContain('only appears in the Home Assistant UI');
    expect(message).toContain('companion app');
  });

  it('reports when a configured service was not found', () => {
    const message = describeResolution(
      { service: 'mobile_app_pixel_9', reason: 'companion-app' },
      'mobile_app_old_phone',
    );
    expect(message).toContain('mobile_app_old_phone');
    expect(message).toContain('not found');
  });

  it('produces a message for every reason', () => {
    const reasons = ['configured', 'companion-app', 'fallback', 'only-option'] as const;
    for (const reason of reasons) {
      expect(describeResolution({ service: 'x', reason })).toMatch(/\S/);
    }
  });
});
