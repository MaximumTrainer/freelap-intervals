import type { OutboundRateLimiter } from '~/outbound-rate-limiter'
import type { ConnectionStore } from '~/security/connection-store'

import type { FreelapSource } from './freelap-source'
import { MyFreelapWebSource } from './myfreelap/myfreelap-web-source'

export interface FeatureFlags {
  /** The MyFreelap web backend is unofficial, so it stays off until an operator turns it on. */
  readonly myfreelapWebAdapter: boolean
}

export function featureFlagsFromEnvironment(env: NodeJS.ProcessEnv = process.env): FeatureFlags {
  return { myfreelapWebAdapter: env.FREELAP_WEB_ADAPTER === 'on' }
}

export interface FreelapSourcesOptions {
  readonly connections: ConnectionStore
  readonly flags: FeatureFlags
  readonly timezone: string
  readonly baseUrl?: string
  readonly fetch?: typeof fetch
  readonly limiter?: OutboundRateLimiter
}

/**
 * Chooses where an athlete's sessions come from. The web source appears only when an operator has
 * enabled it and the athlete has chosen to store their MyFreelap credentials; otherwise the
 * caller falls back to a CSV upload.
 */
export class FreelapSources {
  constructor(private readonly options: FreelapSourcesOptions) {}

  async webSourceFor(userId: string): Promise<FreelapSource | null> {
    if (!this.options.flags.myfreelapWebAdapter) return null

    const connection = await this.options.connections.findFreelap(userId)
    if (!connection) return null

    return new MyFreelapWebSource({
      credentials: connection.credentials,
      timezone: this.options.timezone,
      ...(this.options.baseUrl === undefined ? {} : { baseUrl: this.options.baseUrl }),
      ...(this.options.fetch === undefined ? {} : { fetch: this.options.fetch }),
      ...(this.options.limiter === undefined ? {} : {
        limiter: this.options.limiter,
        limiterKeys: ['myfreelap', `athlete:${userId}`],
      }),
    })
  }
}
