import type { WebResponse } from './http'

export interface RouteMatch<Context> {
  readonly handler: (context: Context) => Promise<WebResponse>
  readonly params: Readonly<Record<string, string>>
}

interface Route<Context> {
  readonly method: string
  readonly matcher: RegExp
  readonly handler: (context: Context) => Promise<WebResponse>
}

/** A path router with `:name` parameters — no more than these routes need. */
export class Router<Context> {
  private readonly routes: Array<Route<Context>> = []

  get(path: string, handler: (context: Context) => Promise<WebResponse>): this {
    return this.add('GET', path, handler)
  }

  post(path: string, handler: (context: Context) => Promise<WebResponse>): this {
    return this.add('POST', path, handler)
  }

  match(method: string, path: string): RouteMatch<Context> | null {
    for (const route of this.routes) {
      if (route.method !== method) continue

      const found = route.matcher.exec(path)
      if (found) return { handler: route.handler, params: { ...found.groups } }
    }

    return null
  }

  private add(method: string, path: string, handler: (context: Context) => Promise<WebResponse>): this {
    const pattern = path
      .split('/')
      .map((segment) => (segment.startsWith(':') ? `(?<${segment.slice(1)}>[^/]+)` : escapeForRegex(segment)))
      .join('/')
    this.routes.push({ method, matcher: new RegExp(`^${pattern}$`), handler })

    return this
  }
}

const REGEX_SPECIALS = /[.*+?^${}()|[\]\\]/g

function escapeForRegex(segment: string): string {
  return segment.replace(REGEX_SPECIALS, (character) => `\\${character}`)
}
