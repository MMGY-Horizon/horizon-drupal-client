/**
 * Code generator: GraphQL introspection → typed client file.
 *
 * Takes the raw GraphQL introspection result and generates a TypeScript
 * file with interfaces, queries, and a typed client factory.
 *
 * Enhanced from decoupled-client with:
 * - Paragraph union support with depth-limited recursion
 * - Landing/article page queries with full paragraph fragments
 * - Horizon-specific field type mappings (Address, Geofield, DateRange)
 */

import { FILE_HEADER, TYPED_CLIENT_INTERFACE, CREATE_TYPED_CLIENT } from './templates'

// ── Type helpers ─────────────────────────────────────────────────────

interface IntrospectionType {
  kind: string
  name: string
  description?: string
  fields?: IntrospectionField[]
  possibleTypes?: { name: string }[]
}

interface IntrospectionField {
  name: string
  description?: string
  type: TypeRef
  args?: any[]
}

interface TypeRef {
  kind: string
  name: string | null
  ofType?: TypeRef | null
}

interface IntrospectionSchema {
  types: IntrospectionType[]
}

// ── Internal fields to skip ──────────────────────────────────────────

const SKIP_FIELDS = new Set([
  'uuid', 'langcode', 'status', 'created', 'changed',
  'promote', 'sticky', 'defaultLangcode',
  'revisionTranslationAffected', 'metatag', 'author',
])

// Term-only unions get simplified to `... on TermInterface { name }` in queries
function isTermUnion(type: TypeRef, schema: IntrospectionSchema): boolean {
  const name = unwrapTypeName(type)
  const t = schema.types.find(s => s.name === name)
  if (!t || t.kind !== 'UNION' || !t.possibleTypes) return false
  return t.possibleTypes.every(pt => pt.name.startsWith('Term'))
}

// Media unions get simplified to `... on MediaImage { mediaImage { url } }`
function isMediaUnion(type: TypeRef, schema: IntrospectionSchema): boolean {
  const name = unwrapTypeName(type)
  const t = schema.types.find(s => s.name === name)
  if (!t || t.kind !== 'UNION' || !t.possibleTypes) return false
  return t.possibleTypes.every(pt => pt.name.startsWith('Media'))
}

const BASE_NODE_FIELDS = new Set(['id', 'title', 'path', 'created', 'changed'])

// ── GraphQL → TypeScript type mapping ────────────────────────────────

function unwrapTypeName(type: TypeRef): string {
  if (type.name) return type.name
  if (type.ofType) return unwrapTypeName(type.ofType)
  return 'String'
}

function isListType(type: TypeRef): boolean {
  if (type.kind === 'LIST') return true
  if (type.kind === 'NON_NULL' && type.ofType) return isListType(type.ofType)
  return false
}

function gqlTypeToTS(type: TypeRef, schema: IntrospectionSchema): string {
  if (!type) return 'any'
  if (type.kind === 'NON_NULL') return gqlTypeToTS(type.ofType!, schema)
  if (type.kind === 'LIST') return `${gqlTypeToTS(type.ofType!, schema)}[]`

  const name = type.name
  if (!name) return 'any'

  // Scalars
  if (name === 'String' || name === 'ID') return 'string'
  if (name === 'Int' || name === 'Float') return 'number'
  if (name === 'Boolean') return 'boolean'

  // Known Drupal field types
  if (name === 'Text') return 'Text'
  if (name === 'TextSummary') return 'TextSummary'
  if (name === 'DateTime') return 'DateTime'
  if (name === 'Image') return 'Image'
  if (name === 'Link') return 'Link'
  if (name === 'Address') return 'Address'
  if (name === 'Language') return 'string'
  if (name === 'Cursor') return 'string'

  // Connection types → skip
  if (name.endsWith('Connection') || name.endsWith('Edge')) return 'any'

  // Media union → MediaImage type (we only extract mediaImage.url in queries)
  if (name === 'MediaUnion' || name === 'MediaImage') return 'MediaImage'
  if (name === 'MediaVideo') return 'MediaVideo'

  // Geospatial/Geofield → Geofield type
  if (name === 'Geospatial' || name === 'Geofield') return 'Geofield'

  // Known entity/paragraph/term → reference by name
  const schemaType = schema.types.find(t => t.name === name)
  if (schemaType) {
    if (name.startsWith('Node') || name.startsWith('Paragraph') || name.startsWith('Term')) {
      return name
    }
    if (schemaType.kind === 'UNION') return name
    if (schemaType.kind === 'OBJECT') return name
  }

  return 'any'
}

// ── GraphQL field selection builder ──────────────────────────────────

function buildFieldSelection(
  field: IntrospectionField,
  schema: IntrospectionSchema,
  depth = 0,
  maxDepth = 2,
): string {
  if (depth > maxDepth) return field.name

  const typeName = unwrapTypeName(field.type)
  const schemaType = schema.types.find(t => t.name === typeName)

  if (!schemaType || schemaType.kind === 'SCALAR' || schemaType.kind === 'ENUM') {
    return field.name
  }

  // Object type — recurse into fields
  if (schemaType.kind === 'OBJECT') {
    const subFields = (schemaType.fields ?? [])
      .filter(f => !SKIP_FIELDS.has(f.name))
      .filter(f => !f.args?.length)
      .filter(f => isExpandable(f.type, schema, depth + 1, maxDepth))
      .map(f => buildFieldSelection(f, schema, depth + 1, maxDepth))

    return subFields.length > 0
      ? `${field.name} { ${subFields.join(' ')} }`
      : field.name
  }

  // Term union — simplified to TermInterface
  if (schemaType.kind === 'UNION' && isTermUnion(field.type, schema)) {
    return `${field.name} { ... on TermInterface { name } }`
  }

  // Media union — simplified to MediaImage/MediaVideo
  if (schemaType.kind === 'UNION' && isMediaUnion(field.type, schema)) {
    return `${field.name} { ... on MediaImage { mediaImage { url } } ... on MediaVideo { mediaVideoFile { url } } }`
  }

  // Other union types — inline fragments
  if (schemaType.kind === 'UNION' && schemaType.possibleTypes) {
    const fragments = schemaType.possibleTypes.map(pt => {
      const memberType = schema.types.find(t => t.name === pt.name)
      if (!memberType?.fields) return `... on ${pt.name} { __typename id }`

      const subFields = memberType.fields
        .filter(f => !SKIP_FIELDS.has(f.name))
        .filter(f => !f.args?.length)
        .filter(f => isExpandable(f.type, schema, depth + 1, maxDepth))
        .map(f => buildFieldSelection(f, schema, depth + 1, maxDepth))

      return `... on ${pt.name} { __typename ${subFields.join(' ')} }`
    })
    return `${field.name} { ${fragments.join(' ')} }`
  }

  return field.name
}

function isExpandable(type: TypeRef, schema: IntrospectionSchema, depth: number, maxDepth: number): boolean {
  if (depth > maxDepth) return false
  const name = unwrapTypeName(type)
  const t = schema.types.find(s => s.name === name)
  if (!t) return true
  if (t.kind === 'SCALAR' || t.kind === 'ENUM') return true
  // Only expand small objects (prevents runaway expansion)
  if (t.kind === 'OBJECT' && (t.fields?.length ?? 0) <= 8) return true
  // Only expand unions at shallow depths
  if (t.kind === 'UNION' && depth <= 1) return true
  return false
}

// ── Paragraph-specific field builder (conservative) ──────────────────

/**
 * Build field selection for paragraph content fields.
 * Uses a flat strategy: expands fieldset children with scalar fields only,
 * uses simplified patterns for media/term unions.
 */
function buildParagraphFieldSelection(field: IntrospectionField, schema: IntrospectionSchema, aliasPrefix?: string): string {
  const typeName = unwrapTypeName(field.type)
  const schemaType = schema.types.find(t => t.name === typeName)

  if (!schemaType || schemaType.kind === 'SCALAR' || schemaType.kind === 'ENUM') {
    // Alias scalar fields to avoid union conflicts (e.g. card_displayType: displayType)
    if (aliasPrefix && field.name !== 'id') {
      return `${aliasPrefix}_${field.name}: ${field.name}`
    }
    return field.name
  }

  // Use alias for non-scalar fields too to prevent union conflicts
  const alias = aliasPrefix && field.name !== 'id' ? `${aliasPrefix}_${field.name}: ` : ''

  // Node union → basic node fields
  if (schemaType.kind === 'UNION' && schemaType.possibleTypes?.some(pt => pt.name.startsWith('Node'))) {
    return `${alias}${field.name} { ... on NodeInterface { id title path } }`
  }

  // Term union → simple name
  if (isTermUnion(field.type, schema)) {
    return `${alias}${field.name} { ... on TermInterface { name } }`
  }

  // Media union → image url
  if (isMediaUnion(field.type, schema)) {
    return `${alias}${field.name} { ... on MediaImage { mediaImage { url } } ... on MediaVideo { mediaVideoFile { url } } }`
  }

  // Object type (e.g. Text, Address, Geofield, DateRange) — expand with one level of recursion
  if (schemaType.kind === 'OBJECT') {
    const subFields = (schemaType.fields ?? [])
      .filter(f => !SKIP_FIELDS.has(f.name) && !f.args?.length)
      .map(f => {
        const n = unwrapTypeName(f.type)
        const t = schema.types.find(s => s.name === n)
        if (!t || t.kind === 'SCALAR' || t.kind === 'ENUM') return f.name
        // Recurse one level for nested objects (e.g. DateRange.start → DateTime { timestamp })
        if (t.kind === 'OBJECT') {
          const innerScalars = (t.fields ?? [])
            .filter(sf => !SKIP_FIELDS.has(sf.name) && !sf.args?.length)
            .filter(sf => { const sn = unwrapTypeName(sf.type); const st = schema.types.find(s => s.name === sn); return !st || st.kind === 'SCALAR' || st.kind === 'ENUM' })
            .map(sf => sf.name)
          return innerScalars.length > 0 ? `${f.name} { ${innerScalars.join(' ')} }` : null
        }
        return null
      })
      .filter(Boolean)

    return subFields.length > 0
      ? `${alias}${field.name} { ${subFields.join(' ')} }`
      : (aliasPrefix && field.name !== 'id' ? `${aliasPrefix}_${field.name}: ${field.name}` : field.name)
  }

  // Paragraph union — use naming convention to find the expected fieldset type
  // e.g. "basicFieldset" field → look for ParagraphBasicFieldset in the union
  if (schemaType.kind === 'UNION' && schemaType.possibleTypes?.some(pt => pt.name.startsWith('Paragraph'))) {
    // Infer expected type from field name: "basicFieldset" → "ParagraphBasicFieldset"
    const baseName = field.name.charAt(0).toUpperCase() + field.name.slice(1)
    const expectedName = `Paragraph${baseName}`
    // Try multiple matching strategies for naming mismatches (e.g. "accordionItems" → ParagraphAccordionItem)
    // Prefer Fieldset types over parent paragraph types (fieldsets have the actual content data)
    const singularName = expectedName.replace(/s$/, '')
    const candidates = [
      // Exact match: "basicFieldset" → ParagraphBasicFieldset
      schemaType.possibleTypes.find(pt => pt.name === expectedName),
      // Fieldset suffix (preferred over singular): "testimonials" → ParagraphTestimonialFieldset
      schemaType.possibleTypes.find(pt => pt.name === singularName + 'Fieldset'),
      // Strip trailing 's' for plural: "accordionItems" → ParagraphAccordionItem
      schemaType.possibleTypes.find(pt => pt.name === singularName),
      // Case-insensitive partial match as last resort
      schemaType.possibleTypes.find(pt => pt.name.toLowerCase().startsWith(`paragraph${field.name.replace(/s$/, '').toLowerCase()}`)),
    ]
    const matchedType = candidates.find(Boolean) ?? null

    if (matchedType) {
      // Only expand the specific expected fieldset type
      const memberType = schema.types.find(t => t.name === matchedType.name)
      if (memberType?.fields) {
        const subFields = memberType.fields
          .filter(f => !SKIP_FIELDS.has(f.name) && !f.args?.length)
          .map(f => {
            const fTypeName = unwrapTypeName(f.type)
            const fType = schema.types.find(t => t.name === fTypeName)
            if (!fType || fType.kind === 'SCALAR' || fType.kind === 'ENUM') return f.name
            if (isTermUnion(f.type, schema)) return `${f.name} { ... on TermInterface { name } }`
            if (isMediaUnion(f.type, schema)) return `${f.name} { ... on MediaImage { mediaImage { url } } }`
            if (fType.kind === 'OBJECT' && (fType.fields?.length ?? 0) <= 8) {
              const scalars = (fType.fields ?? []).filter(sf => !SKIP_FIELDS.has(sf.name)).filter(sf => { const n = unwrapTypeName(sf.type); const t = schema.types.find(s => s.name === n); return !t || t.kind === 'SCALAR' }).map(sf => sf.name)
              return scalars.length ? `${f.name} { ${scalars.join(' ')} }` : f.name
            }
            return null
          })
          .filter(Boolean)
        return `${alias}${field.name} { ... on ${matchedType.name} { ${subFields.join(' ')} } }`
      }
    }

    // Fallback: just get __typename for unknown paragraph unions
    // Log a warning so developers can identify broken fields
    const possibleNames = schemaType.possibleTypes?.map(pt => pt.name).join(', ') ?? 'none'
    console.warn(`⚠️  Codegen: Could not find matching paragraph type for field "${field.name}" (tried Paragraph${baseName}, Paragraph${baseName.replace(/s$/, '')}, Paragraph${baseName.replace(/s$/, 'Fieldset')}). Available types: ${possibleNames}. This field will only return __typename — nested data will be missing.`)
    return `${alias}${field.name} { __typename }`
  }

  return aliasPrefix && field.name !== 'id' ? `${aliasPrefix}_${field.name}: ${field.name}` : field.name
}

// ── Main generator ───────────────────────────────────────────────────

export function generateClientCode(schema: IntrospectionSchema): string {
  const lines: string[] = [FILE_HEADER]

  // Collect entity types
  const nodeTypes = schema.types.filter(t =>
    t.name.startsWith('Node') &&
    t.kind === 'OBJECT' &&
    !t.name.endsWith('Connection') &&
    !t.name.endsWith('Edge') &&
    t.fields?.length
  )

  const paragraphTypes = schema.types.filter(t =>
    t.name.startsWith('Paragraph') &&
    t.kind === 'OBJECT' &&
    !t.name.includes('Connection') &&
    !t.name.includes('Edge') &&
    t.fields?.length
  )

  const termTypes = schema.types.filter(t =>
    t.name.startsWith('Term') &&
    t.kind === 'OBJECT' &&
    !t.name.includes('Connection') &&
    !t.name.includes('Edge') &&
    t.fields?.length
  )

  // Collect union types
  const generatedNames = new Set([
    ...nodeTypes.map(t => t.name),
    ...paragraphTypes.map(t => t.name),
    ...termTypes.map(t => t.name),
  ])

  const unionTypes = schema.types.filter(t => {
    if (t.kind !== 'UNION' || !t.possibleTypes?.length) return false
    return t.possibleTypes.some(pt => generatedNames.has(pt.name))
  })

  // ── Generate Node interfaces ───────────────────────────────────

  lines.push('// ─── Node Types ────────────────────────────────────────────────────\n')
  for (const type of nodeTypes) {
    lines.push(`export interface ${type.name} extends DrupalNode {`)
    lines.push(`  __typename: '${type.name}'`)
    for (const field of type.fields ?? []) {
      if (SKIP_FIELDS.has(field.name) || BASE_NODE_FIELDS.has(field.name)) continue
      const tsType = gqlTypeToTS(field.type, schema)
      const isList = isListType(field.type)
      if (isList && !tsType.endsWith('[]')) {
        lines.push(`  ${field.name}?: ${tsType}[]`)
      } else {
        lines.push(`  ${field.name}?: ${tsType}`)
      }
    }
    lines.push('}\n')
  }

  // ── Generate Paragraph interfaces ──────────────────────────────

  if (paragraphTypes.length) {
    lines.push('// ─── Paragraph Types ───────────────────────────────────────────────\n')
    for (const type of paragraphTypes) {
      lines.push(`export interface ${type.name} extends DrupalParagraph {`)
      lines.push(`  __typename: '${type.name}'`)
      for (const field of type.fields ?? []) {
        if (SKIP_FIELDS.has(field.name) || field.name === 'id') continue
        const tsType = gqlTypeToTS(field.type, schema)
        const isList = isListType(field.type)
        if (isList && !tsType.endsWith('[]')) {
          lines.push(`  ${field.name}?: ${tsType}[]`)
        } else {
          lines.push(`  ${field.name}?: ${tsType}`)
        }
      }
      lines.push('}\n')
    }
  }

  // ── Generate Term interfaces ───────────────────────────────────

  if (termTypes.length) {
    lines.push('// ─── Term Types ────────────────────────────────────────────────────\n')
    for (const type of termTypes) {
      lines.push(`export interface ${type.name} extends DrupalTerm {`)
      lines.push(`  __typename: '${type.name}'`)
      for (const field of type.fields ?? []) {
        if (SKIP_FIELDS.has(field.name) || ['id', 'name', 'path', 'description'].includes(field.name)) continue
        const tsType = gqlTypeToTS(field.type, schema)
        lines.push(`  ${field.name}?: ${tsType}`)
      }
      lines.push('}\n')
    }
  }

  // ── Generate Union types ───────────────────────────────────────

  if (unionTypes.length) {
    lines.push('// ─── Union Types ───────────────────────────────────────────────────\n')
    for (const type of unionTypes) {
      const members = type.possibleTypes!
        .filter(pt => generatedNames.has(pt.name))
        .map(t => t.name)
        .join(' | ')
      if (members) {
        lines.push(`export type ${type.name} = ${members}\n`)
      }
    }
  }

  // ── Content type map ─────────────────────────────────────────

  const nodeNames = nodeTypes.map(t => t.name)

  lines.push('// ─── Content Type Map ───────────────────────────────────────────────\n')
  lines.push(`export type ContentNode = ${nodeNames.join(' | ')}\n`)
  lines.push(`export type ContentTypeName = ${nodeNames.map(n => `'${n}'`).join(' | ')}\n`)
  lines.push('export interface ContentTypeMap {')
  for (const name of nodeNames) {
    lines.push(`  ${name}: ${name}`)
  }
  lines.push('}\n')

  // ── Generate list/single queries per node type ─────────────────

  lines.push('// ─── Generated GraphQL Queries ──────────────────────────────────────\n')
  lines.push('export const QUERIES: Record<ContentTypeName, { list: string; single: string }> = {')

  for (const type of nodeTypes) {
    // Derive plural name: NodeArticleDetail → nodeArticleDetails, NodeBusiness → nodeBusinesses
    const base = `${type.name.charAt(0).toLowerCase()}${type.name.slice(1)}`
    const plural = base.endsWith('s') || base.endsWith('sh') || base.endsWith('ch') || base.endsWith('x') || base.endsWith('z')
      ? `${base}es`
      : `${base}s`

    const customFields = (type.fields ?? [])
      .filter(f => !SKIP_FIELDS.has(f.name) && !BASE_NODE_FIELDS.has(f.name))
      .filter(f => f.name !== 'content') // skip paragraph content in list queries
      .filter(f => !f.args?.length)
      .map(f => {
        if (isTermUnion(f.type, schema)) return `${f.name} { ... on TermInterface { name } }`
        if (isMediaUnion(f.type, schema)) return `${f.name} { ... on MediaImage { mediaImage { url } } }`
        return buildFieldSelection(f, schema, 0, 1)
      })
      .join(' ')

    const fragment = customFields ? `\n          ... on ${type.name} { ${customFields} }` : ''

    lines.push(`  ${type.name}: {`)
    lines.push(`    list: \`query ($first: Int, $after: Cursor, $sortKey: ConnectionSortKeys, $reverse: Boolean) {`)
    lines.push(`      ${plural}(first: $first, after: $after, sortKey: $sortKey, reverse: $reverse) {`)
    lines.push(`        nodes {`)
    lines.push(`          __typename id title path created { time } changed { time }${fragment}`)
    lines.push(`        }`)
    lines.push(`        pageInfo { hasNextPage endCursor }`)
    lines.push(`      }`)
    lines.push(`    }\`,`)
    lines.push(`    single: \`query ($id: ID!) {`)
    lines.push(`      node(id: $id) {`)
    lines.push(`        __typename id title path created { time } changed { time }${fragment}`)
    lines.push(`      }`)
    lines.push(`    }\`,`)
    lines.push(`  },`)
  }
  lines.push('} as const\n')

  // ── Route query (simple — no paragraphs) ──────────────────────

  lines.push('// ─── Route Query (simple entity resolution — no paragraph content) ──\n')
  lines.push('export const ROUTE_QUERY = `')
  lines.push('  query ($path: String!) {')
  lines.push('    route(path: $path) {')
  lines.push('      ... on RouteInternal {')
  lines.push('        entity {')
  for (const type of nodeTypes) {
    // Skip content/paragraph fields in route query — use PAGE_QUERY for those
    const customFields = (type.fields ?? [])
      .filter(f => !SKIP_FIELDS.has(f.name) && !BASE_NODE_FIELDS.has(f.name))
      .filter(f => f.name !== 'content') // skip paragraph content
      .filter(f => !f.args?.length)
      .map(f => {
        // Simplified: term → name, media → url, scalars only
        if (isTermUnion(f.type, schema)) return `${f.name} { ... on TermInterface { name } }`
        if (isMediaUnion(f.type, schema)) return `${f.name} { ... on MediaImage { mediaImage { url } } }`
        const tn = unwrapTypeName(f.type)
        const st = schema.types.find(t => t.name === tn)
        if (!st || st.kind === 'SCALAR' || st.kind === 'ENUM') return f.name
        if (st.kind === 'OBJECT' && (st.fields?.length ?? 0) <= 6) {
          const scalars = (st.fields ?? []).filter(sf => { const n = unwrapTypeName(sf.type); const t = schema.types.find(s => s.name === n); return !t || t.kind === 'SCALAR' }).map(sf => sf.name)
          return scalars.length ? `${f.name} { ${scalars.join(' ')} }` : f.name
        }
        return f.name
      })
      .join(' ')
    const allFields = customFields ? ` ${customFields}` : ''
    lines.push(`          ... on ${type.name} { __typename id title path created { time } changed { time }${allFields} }`)
  }
  lines.push('        }')
  lines.push('      }')
  lines.push('    }')
  lines.push('  }')
  lines.push('`\n')

  // ── Page query (deep — includes paragraph content) ──────────────

  // Find node types that have a "content" field (paragraph references)
  const pageTypes = nodeTypes.filter(t =>
    t.fields?.some(f => f.name === 'content')
  )

  if (pageTypes.length) {
    lines.push('// ─── Page Query (with full paragraph content) ──────────────────────\n')
    lines.push('export const PAGE_QUERY = `')
    lines.push('  query ($path: String!) {')
    lines.push('    route(path: $path) {')
    lines.push('      ... on RouteInternal {')
    lines.push('        entity {')

    for (const type of pageTypes) {
      const nonContentFields = (type.fields ?? [])
        .filter(f => f.name !== 'content' && !SKIP_FIELDS.has(f.name) && !BASE_NODE_FIELDS.has(f.name))
        .filter(f => !f.args?.length)
        .map(f => buildFieldSelection(f, schema, 0, 1))
        .join(' ')

      // Build content field with paragraph fragments — use shallow expansion
      // to avoid query explosion. Fieldset children get basic scalar fields only.
      const contentField = type.fields?.find(f => f.name === 'content')
      let contentSelection = 'content { __typename }'

      if (contentField) {
        const contentTypeName = unwrapTypeName(contentField.type)
        const contentUnion = schema.types.find(t => t.name === contentTypeName)

        if (contentUnion?.kind === 'UNION' && contentUnion.possibleTypes) {
          const fragments = contentUnion.possibleTypes.map(pt => {
            const pType = schema.types.find(t => t.name === pt.name)
            if (!pType?.fields) return `... on ${pt.name} { __typename id }`

            // Create alias prefix from type name: ParagraphCard → card, ParagraphBasic → basic
            const prefix = pt.name.replace('Paragraph', '').charAt(0).toLowerCase() + pt.name.replace('Paragraph', '').slice(1)

            const pFields = pType.fields
              .filter(f => !SKIP_FIELDS.has(f.name))
              .filter(f => !f.args?.length)
              .map(f => buildParagraphFieldSelection(f, schema, prefix))
              .join(' ')

            return `... on ${pt.name} { __typename ${pFields} }`
          })
          contentSelection = `content {\n              ${fragments.join('\n              ')}\n            }`
        }
      }

      const allFields = nonContentFields ? ` ${nonContentFields}` : ''
      lines.push(`          ... on ${type.name} { __typename id title path created { time } changed { time }${allFields} ${contentSelection} }`)
    }

    lines.push('        }')
    lines.push('      }')
    lines.push('    }')
    lines.push('  }')
    lines.push('`\n')
  }

  // ── Typed client interface + factory ──────────────────────────

  lines.push(TYPED_CLIENT_INTERFACE)
  lines.push(CREATE_TYPED_CLIENT)

  return lines.join('\n')
}
