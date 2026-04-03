/**
 * Core Horizon Drupal client.
 * Handles GraphQL queries against a Drupal backend with GraphQL Compose.
 *
 * Horizon uses public GraphQL endpoints (no OAuth required).
 * For authenticated scenarios, pass a custom fetch with auth headers.
 */

import { HorizonError } from './errors'
import type { ClientConfig } from './types/client'
import type { DrupalNode } from './types/base'

export class HorizonClient {
  private fetchFn: typeof globalThis.fetch
  private graphqlUrl: string

  constructor(private config: ClientConfig) {
    const graphqlPath = config.graphqlPath ?? '/graphql'
    this.graphqlUrl = `${config.baseUrl.replace(/\/$/, '')}${graphqlPath}`
    this.fetchFn = config.fetch ?? globalThis.fetch.bind(globalThis)
  }

  /** Execute a GraphQL query and return the data */
  async query<T = any>(query: string, variables?: Record<string, any>): Promise<T> {
    const res = await this.fetchFn(this.graphqlUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    })

    if (!res.ok) {
      throw new HorizonError([
        { message: `GraphQL request failed: ${res.status} ${res.statusText}` },
      ])
    }

    const json = (await res.json()) as {
      data?: T
      errors?: Array<{ message: string; path?: string[] }>
    }

    if (json.errors?.length) {
      throw new HorizonError(json.errors)
    }

    return json.data as T
  }

  /** Resolve a Drupal path to a content node using the route() query */
  async queryByPath<T extends DrupalNode = DrupalNode>(
    path: string,
    routeQuery: string,
  ): Promise<T | null> {
    const data = await this.query<{ route?: { entity?: T } }>(routeQuery, { path })
    return data?.route?.entity ?? null
  }

  /** Get the configured GraphQL endpoint URL */
  get endpoint(): string {
    return this.graphqlUrl
  }
}

/** Create a new HorizonClient instance */
export function createClient(config: ClientConfig): HorizonClient {
  return new HorizonClient(config)
}
