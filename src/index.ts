/**
 * horizon-drupal-client
 *
 * Type-safe TypeScript client for Horizon Drupal.
 * Full autocomplete, zero GraphQL required.
 *
 * Usage:
 *
 *   import { createClient } from 'horizon-drupal-client'
 *   import { createTypedClient } from './schema/client'  // auto-generated
 *
 *   const client = createTypedClient(createClient({
 *     baseUrl: process.env.NEXT_PUBLIC_DRUPAL_URL!,
 *   }))
 *
 *   const articles = await client.getEntries('NodeArticleDetail', { first: 10 })
 */

// Client
export { HorizonClient, createClient } from './client'

// Errors
export { HorizonError, NotFoundError } from './errors'

// Types — base entities
export type { DrupalNode, DrupalParagraph, DrupalTerm } from './types/base'

// Types — field types
export type { Text, TextSummary, Image, ImageVariation, Link, DateTime, Address, Geofield, DateRange, MediaImage, MediaVideo } from './types/fields'

// Types — client config
export type { ClientConfig, QueryOptions } from './types/client'
