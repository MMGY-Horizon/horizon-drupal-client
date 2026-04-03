# horizon-drupal-client

Type-safe TypeScript client for Horizon Drupal. Full autocomplete, zero GraphQL required.

## Quick Start

```bash
# Install from GitHub (private repo)
npm install git+ssh://git@github.com:MMGY-Horizon/horizon-drupal-client.git

# Sync schema from your Drupal site
DRUPAL_GRAPHQL_URL=https://horizon-cms.ddev.site/graphql npx horizon-schema sync --out ./schema

# Use in your app
```

```typescript
import { createClient } from 'horizon-drupal-client'
import { createTypedClient } from './schema/client'

const client = createTypedClient(createClient({
  baseUrl: process.env.NEXT_PUBLIC_DRUPAL_URL!,
}))

// Full type safety and autocomplete
const articles = await client.getEntries('NodeArticleDetail', { first: 10 })
const page = await client.getPage('/landing/frankenpage')
const article = await client.getByPath('/article-page/visit/editorial/food-truck-favorites')
```

## Schema Sync

When Drupal fields or content types change, re-sync the schema:

```bash
npx horizon-schema sync --url https://horizon-cms.ddev.site/graphql --out ./schema
```

This generates `schema/client.ts` with:
- TypeScript interfaces for every Node, Paragraph, and Term type
- Pre-built GraphQL queries (list + single per content type)
- Route and page queries for path-based content resolution
- `createTypedClient()` factory with full autocomplete

## API

### `createClient(config)`

Create a base client. Config:
- `baseUrl` — Drupal site URL
- `fetch` — Optional custom fetch (for Next.js cache tags)
- `graphqlPath` — Optional endpoint path (default: `/graphql`)

### `createTypedClient(client)` (generated)

Wraps the base client with typed methods:
- `getEntries(type, options?)` — List content by type
- `getEntry(type, id)` — Get single entry by UUID
- `getByPath(path)` — Resolve a Drupal path
- `getPage(path)` — Get page with full paragraph content
- `raw(query, variables?)` — Escape hatch for raw GraphQL
