#!/usr/bin/env node

/**
 * Schema sync CLI: fetches GraphQL introspection from Drupal and generates typed client.
 *
 * Usage:
 *   npx horizon-schema sync --url https://horizon-cms.ddev.site/graphql --out ./schema
 *   npx horizon-schema sync  # uses DRUPAL_GRAPHQL_URL env var
 */

const fs = require('fs')
const path = require('path')

async function main() {
  const args = process.argv.slice(2)

  if (args[0] !== 'sync') {
    console.log('Usage: horizon-schema sync [--url <graphql-url>] [--out <output-dir>]')
    process.exit(1)
  }

  // Parse args
  let url = process.env.DRUPAL_GRAPHQL_URL || process.env.NEXT_PUBLIC_DRUPAL_URL
  let outDir = './schema'

  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--url' && args[i + 1]) { url = args[++i] }
    if (args[i] === '--out' && args[i + 1]) { outDir = args[++i] }
  }

  if (url && !url.includes('/graphql')) {
    url = url.replace(/\/$/, '') + '/graphql'
  }

  if (!url) {
    console.error('Error: No GraphQL URL provided.')
    console.error('Set DRUPAL_GRAPHQL_URL env var or use --url flag.')
    process.exit(1)
  }

  console.log(`Fetching schema from: ${url}`)

  // Step 1: Fetch introspection
  const introspectionQuery = `
    query IntrospectionQuery {
      __schema {
        types {
          kind
          name
          description
          fields(includeDeprecated: false) {
            name
            description
            args { name type { kind name ofType { kind name ofType { kind name ofType { kind name } } } } }
            type { kind name ofType { kind name ofType { kind name ofType { kind name ofType { kind name } } } } }
          }
          possibleTypes { name }
          enumValues { name }
        }
      }
    }
  `

  let schema
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: introspectionQuery }),
    })

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${res.statusText}`)
    }

    const json = await res.json()
    if (json.errors) {
      throw new Error(json.errors.map(e => e.message).join('; '))
    }

    schema = json.data.__schema
  } catch (err) {
    console.error(`Failed to fetch schema: ${err.message}`)
    process.exit(1)
  }

  console.log(`  Found ${schema.types.length} types`)

  // Step 2: Save introspection
  fs.mkdirSync(outDir, { recursive: true })
  const introspectionPath = path.join(outDir, 'introspection.json')
  fs.writeFileSync(introspectionPath, JSON.stringify(schema, null, 2))
  console.log(`  Saved introspection to ${introspectionPath}`)

  // Step 3: Generate typed client
  const { generateClientCode } = require('../dist/codegen/generate')
  const clientCode = generateClientCode(schema)
  const clientPath = path.join(outDir, 'client.ts')
  fs.writeFileSync(clientPath, clientCode)

  // Count generated types
  const nodeCount = (clientCode.match(/export interface Node\w+ extends DrupalNode/g) || []).length
  const paragraphCount = (clientCode.match(/export interface Paragraph\w+ extends DrupalParagraph/g) || []).length
  const termCount = (clientCode.match(/export interface Term\w+ extends DrupalTerm/g) || []).length

  console.log(`  Generated ${clientPath}:`)
  console.log(`    ${nodeCount} node types`)
  console.log(`    ${paragraphCount} paragraph types`)
  console.log(`    ${termCount} term types`)
  console.log('\nDone!')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
