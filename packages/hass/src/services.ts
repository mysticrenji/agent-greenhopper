/**
 * Notify-target discovery.
 *
 * The exact `notify.mobile_app_*` service name depends on the device name the
 * Home Assistant companion app registered, which nobody remembers and which
 * changes if the phone is renamed. Rather than making it a configuration value
 * the owner has to look up, ask Home Assistant what exists.
 *
 * This keeps the read-only guarantee: `/api/services` is a GET, and the resolved
 * name is still funnelled through `HassNotifier`, which can only construct
 * `notify.*` calls.
 */

import { z } from 'zod';
import { type HassConfig, type HttpFetch, requestJson } from './transport.js';

/**
 * Home Assistant's documented shape is `{ domain, services: string[] }`, but some
 * versions return `services` as an object keyed by service name. Accept both
 * rather than breaking on an upgrade.
 */
const serviceDomainSchema = z.object({
  domain: z.string(),
  services: z.union([z.array(z.string()), z.record(z.string(), z.unknown())]),
});

const servicesSchema = z.array(serviceDomainSchema);

/**
 * Always present in Home Assistant and needs no companion app, so it is a safe
 * zero-configuration fallback: notifications land in the Home Assistant UI.
 */
export const FALLBACK_NOTIFY_SERVICE = 'persistent_notification';

/** Every service name in the `notify` domain, sorted for stable output. */
export async function listNotifyServices(http: HttpFetch, config: HassConfig): Promise<string[]> {
  const raw = await requestJson(http, config, '/api/services');
  const domains = servicesSchema.parse(raw);

  const notify = domains.find((entry) => entry.domain === 'notify');
  if (!notify) return [];

  const names = Array.isArray(notify.services) ? notify.services : Object.keys(notify.services);

  return [...names].sort();
}

export interface NotifyResolution {
  readonly service: string;
  readonly reason: 'configured' | 'companion-app' | 'fallback' | 'only-option';
}

/**
 * Choose a notify target from what Home Assistant actually offers.
 *
 * Preference order, and why:
 *   1. An explicitly configured service, if it exists — the owner's intent wins.
 *   2. A `mobile_app_*` service — push to a phone is the point of an alerting
 *      system; a notice sitting in a web UI is not an alert.
 *   3. `persistent_notification` — always available, so the system is never
 *      unable to report at all.
 *
 * Returns null only when Home Assistant exposes no notify services whatsoever,
 * which means the `notify` integration is not loaded.
 */
export function resolveNotifyTarget(
  available: readonly string[],
  configured?: string | undefined,
): NotifyResolution | null {
  if (configured && available.includes(configured)) {
    return { service: configured, reason: 'configured' };
  }

  const companionApp = available.filter((s) => s.startsWith('mobile_app_')).sort();
  const first = companionApp[0];
  if (first) return { service: first, reason: 'companion-app' };

  if (available.includes(FALLBACK_NOTIFY_SERVICE)) {
    return { service: FALLBACK_NOTIFY_SERVICE, reason: 'fallback' };
  }

  const only = available[0];
  return only ? { service: only, reason: 'only-option' } : null;
}

/**
 * Explain a resolution in one line, for startup logs.
 *
 * Worth logging: silently falling back to the Home Assistant UI when a phone push
 * was expected is the kind of thing that is only noticed when an alert is missed.
 */
export function describeResolution(
  resolution: NotifyResolution,
  configured?: string | undefined,
): string {
  switch (resolution.reason) {
    case 'configured':
      return `Using configured notify service notify.${resolution.service}.`;
    case 'companion-app':
      return configured
        ? `Configured notify service "${configured}" was not found; using discovered ` +
            `companion app target notify.${resolution.service}.`
        : `No notify service configured; using discovered companion app target ` +
            `notify.${resolution.service}.`;
    case 'fallback':
      return (
        `No companion app notify target found; falling back to ` +
        `notify.${FALLBACK_NOTIFY_SERVICE}, which only appears in the Home Assistant UI. ` +
        'Install the companion app to receive push notifications.'
      );
    case 'only-option':
      return `Using the only available notify service, notify.${resolution.service}.`;
  }
}
