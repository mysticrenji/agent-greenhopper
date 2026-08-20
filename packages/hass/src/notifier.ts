/**
 * Notification egress.
 *
 * Sending a notification is technically a Home Assistant service call, so it is a
 * POST rather than a read. That is the single exception to "read-only", and the
 * distinction that matters is precise: **no call from this package may change the
 * state of a device.** `notify.*` services deliver a message and touch nothing
 * else.
 *
 * The guarantee is enforced by the type system rather than by convention. There
 * is no generic `callService(domain, service, data)`; the only thing this class
 * can construct is a `notify.<service>` call carrying a title and message. Adding
 * a `switch.turn_on` capability would require editing this file, which is exactly
 * the review checkpoint we want (ADR 0003).
 */

import { type HassConfig, type HttpFetch, requestJson } from './transport.js';

export interface Notification {
  readonly title: string;
  readonly message: string;
}

export class HassNotifier {
  /**
   * @param service Bare `notify` service name, for example `mobile_app_pixel_9`.
   *   Validated to reject anything that could escape the `notify` domain.
   */
  constructor(
    private readonly http: HttpFetch,
    private readonly config: HassConfig,
    private readonly service: string,
  ) {
    assertNotifyService(service);
  }

  async send(notification: Notification): Promise<void> {
    await requestJson(this.http, this.config, `/api/services/notify/${this.service}`, {
      method: 'POST',
      body: JSON.stringify({
        title: notification.title,
        message: notification.message,
      }),
    });
  }
}

/**
 * Reject service names that are not plain `notify` targets.
 *
 * Without this a configuration value such as `../switch/turn_on` would let a
 * config change silently acquire actuation, defeating the read-only property at
 * its weakest point.
 */
export function assertNotifyService(service: string): void {
  if (!/^[a-z0-9_]+$/.test(service)) {
    throw new Error(
      `Invalid notify service "${service}": expected a bare service name such as ` +
        '"mobile_app_pixel_9" containing only lowercase letters, digits and underscores.',
    );
  }
}
