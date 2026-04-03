/**
 * Client configuration and query option types.
 */

export interface ClientConfig {
  /** Drupal base URL (e.g. https://horizon-cms.ddev.site) */
  baseUrl: string
  /** Optional: custom fetch implementation (e.g. for Next.js cache tags) */
  fetch?: typeof globalThis.fetch
  /** Optional: GraphQL endpoint path (default: /graphql) */
  graphqlPath?: string
}

export interface QueryOptions {
  /** Number of items to return */
  first?: number
  /** Cursor for pagination */
  after?: string
  /** Sort key */
  sortKey?: string
  /** Reverse sort order */
  reverse?: boolean
}
