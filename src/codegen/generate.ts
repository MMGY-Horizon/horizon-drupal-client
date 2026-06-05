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

// Term-only unions get simplified to `${termSpread()}` in queries
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

// ── Named-fragment registry ──────────────────────────────────────────
//
// The repeated leaf/card selections (`${termSpread()}`,
// media URLs, per-node "card" payloads) were previously INLINED at every
// occurrence — thousands of times across the generated queries, blowing
// PAGE_QUERY past 2.7 MB and timing out slow hosts. Instead we emit each
// repeated selection ONCE as a named fragment and reference it with
// `...FragName`; `fragmentClosure()` then appends only the fragments a given
// query (transitively) uses. Response shapes are identical, so the runtime
// `dealiasResponse()` is unaffected.
//
// Reset at the top of each generateClientCode() run.
let fragmentDefs = new Map<string, string>()

function registerFragment(name: string, def: string): string {
  if (!fragmentDefs.has(name)) fragmentDefs.set(name, def)
  return `...${name}`
}

/** `...FragTermName` — `fragment FragTermName on TermInterface { name }` */
function termSpread(): string {
  return registerFragment(
    'FragTermName',
    'fragment FragTermName on TermInterface { name }',
  )
}

/**
 * Spread the media fragments for the media types present in this union, e.g.
 * `...FragMediaImage ...FragMediaVideo`. Replaces the old inlined
 * buildMediaFragments() body; same emitted selection, deduped.
 */
function buildMediaFragments(type: TypeRef, schema: IntrospectionSchema): string {
  const name = unwrapTypeName(type)
  const t = schema.types.find(s => s.name === name)
  const spreads: string[] = []
  const present = new Set((t?.possibleTypes ?? []).map(p => p.name))
  if (present.has('MediaImage')) {
    spreads.push(registerFragment('FragMediaImage', 'fragment FragMediaImage on MediaImage { mediaImage { url } }'))
  }
  if (present.has('MediaVideo')) {
    spreads.push(registerFragment('FragMediaVideo', 'fragment FragMediaVideo on MediaVideo { mediaVideoFile { url } }'))
  }
  // Fallback if union type not found (shouldn't happen if isMediaUnion passed)
  return spreads.length > 0
    ? spreads.join(' ')
    : registerFragment('FragMediaImage', 'fragment FragMediaImage on MediaImage { mediaImage { url } }')
}

/**
 * Compute the transitive set of `...FragName` references in a query body and
 * return their definitions (each once). Guarantees a document defines exactly
 * the fragments it uses — satisfying GraphQL's KnownFragmentNames AND
 * NoUnusedFragments validation rules.
 */
function fragmentClosure(queryBody: string): string {
  const used = new Set<string>()
  const stack: string[] = []
  const scan = (s: string) => {
    for (const m of s.matchAll(/\.\.\.(Frag\w+)/g)) {
      if (!used.has(m[1])) {
        used.add(m[1])
        stack.push(m[1])
      }
    }
  }
  scan(queryBody)
  while (stack.length) {
    const def = fragmentDefs.get(stack.pop()!)
    if (def) scan(def)
  }
  return [...used]
    .map(n => fragmentDefs.get(n))
    .filter((d): d is string => !!d)
    .join('\n')
}

/** Append a query body's transitive fragment defs (if any) below it. */
function withFragments(queryBody: string): string {
  const frags = fragmentClosure(queryBody)
  return frags ? `${queryBody}\n\n${frags}\n` : queryBody
}

const BASE_NODE_FIELDS = new Set(['id', 'title', 'path', 'created', 'changed'])

// Field names denied inside NodeCard fragments. Categorized to make the
// boundary maintainable as the schema evolves.
//
// The principle: a NodeCard fragment is a node payload sized for CARD
// rendering — a brief, scannable presentation of an entity. Fields used
// only by full DETAIL-PAGE rendering live on the parent node via
// `_source` and should not be re-fetched inside every paragraph node-ref.
// Including them here would multiply query size linearly across every
// route query × every paragraph × every member-node type, which we saw
// blow the generated client past 7 MB in one experiment.
//
// Add a field here ONLY when it's verified to be (a) non-card-relevant
// for every known consumer and (b) reachable through the detail page's
// `_source` path. Err toward inclusion (smaller deny list) when in
// doubt — a missing card field is a render bug, a slightly-larger query
// is just bytes.
const NODE_CARD_DENY_FIELD_NAMES = new Set([
  // Recursion risk — loops back into the paragraph union we came from.
  'paragraphs',

  // Long-form authored content — heavy and never rendered on a card.
  'body',
  'terms',
  'parking',
  'reservations',

  // Detail-page contact/operational data — surfaced by BusinessOverview,
  // EventOverview, etc., via `_source`. Never rendered on a card.
  'mainPhone',
  'mainWebsite',
  'bookingWebsite',
  'email',
  'hours',
  'paymentMethods',
  'accessibility',
  'redeemUrl',

  // Detail-page review data — surfaced by Reviews block via `_source`.
  'rating',
  'noOfReviews',
  'googleReviews',
  'placeId',

  // Internal admin / import id — never displayed.
  'csvId',
])

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

/** Convert PascalCase GraphQL type name to UPPER_SNAKE_CASE for constant suffix.
 *  e.g. "NodeArticleDetail" → "NODE_ARTICLE_DETAIL". */
function typeNameToSnakeUpper(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase()
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

/**
 * Always-valid scalar expansion for a composite OBJECT type. Recurses into
 * nested OBJECTs so composite scalar types like DateRange (start/end are
 * DateTime OBJECTs, whose fields are scalars) still produce a valid
 * sub-selection no matter the caller's depth budget.
 *
 * This is the fallback used when the primary buildFieldSelection logic would
 * otherwise emit a bare composite field name — which is invalid GraphQL.
 */
function buildCompositeSubselection(
  type: IntrospectionType,
  schema: IntrospectionSchema,
  visited: Set<string> = new Set(),
): string[] {
  if (!type.fields || visited.has(type.name)) return []
  visited.add(type.name)

  const parts: string[] = []
  for (const f of type.fields) {
    if (SKIP_FIELDS.has(f.name) || f.args?.length) continue
    const fTypeName = unwrapTypeName(f.type)
    const fType = schema.types.find(t => t.name === fTypeName)

    if (!fType || fType.kind === 'SCALAR' || fType.kind === 'ENUM') {
      parts.push(f.name)
      continue
    }

    if (fType.kind === 'OBJECT') {
      const nested = buildCompositeSubselection(fType, schema, visited)
      if (nested.length) parts.push(`${f.name} { ${nested.join(' ')} }`)
      continue
    }

    // Handle common unions inline so Address/Media fields still resolve.
    if (fType.kind === 'UNION' && isTermUnion(f.type, schema)) {
      parts.push(`${f.name} { ${termSpread()} }`)
      continue
    }
    if (fType.kind === 'UNION' && isMediaUnion(f.type, schema)) {
      parts.push(`${f.name} { ${buildMediaFragments(f.type, schema)} }`)
      continue
    }
    // Other unions: skip in fallback rather than blow up the query.
  }

  visited.delete(type.name)
  return parts
}

function buildFieldSelection(
  field: IntrospectionField,
  schema: IntrospectionSchema,
  depth = 0,
  maxDepth = 2,
): string {
  const typeName = unwrapTypeName(field.type)
  const schemaType = schema.types.find(t => t.name === typeName)

  if (!schemaType || schemaType.kind === 'SCALAR' || schemaType.kind === 'ENUM') {
    return field.name
  }

  // Past the depth budget, composites still need a sub-selection. Fall back
  // to a scalar-only expansion rather than emitting a bare composite name
  // (which is invalid GraphQL).
  if (depth > maxDepth) {
    if (schemaType.kind === 'OBJECT') {
      const fallback = buildCompositeSubselection(schemaType, schema)
      return fallback.length
        ? `${field.name} { ${fallback.join(' ')} }`
        : `${field.name} { __typename }`
    }
    // Non-OBJECT composites (UNION/INTERFACE): minimum-valid selection.
    return `${field.name} { __typename }`
  }

  // Object type — recurse into fields. Composite types ALWAYS need a
  // sub-selection, so we can't fall back to returning `field.name` bare
  // when the depth gate filters everything out. Scalars are cheap and
  // always valid, so admit them regardless of depth; gate composites
  // via isExpandable as before.
  if (schemaType.kind === 'OBJECT') {
    const subFields = (schemaType.fields ?? [])
      .filter(f => !SKIP_FIELDS.has(f.name))
      .filter(f => !f.args?.length)
      .filter(f => {
        const n = unwrapTypeName(f.type)
        const t = schema.types.find(s => s.name === n)
        if (!t || t.kind === 'SCALAR' || t.kind === 'ENUM') return true
        return isExpandable(f.type, schema, depth + 1, maxDepth)
      })
      .map(f => buildFieldSelection(f, schema, depth + 1, maxDepth))

    if (subFields.length > 0) {
      return `${field.name} { ${subFields.join(' ')} }`
    }
    // Depth gate stripped every child. Emit scalars-only fallback so the
    // composite still has a valid sub-selection.
    const fallback = buildCompositeSubselection(schemaType, schema)
    return fallback.length
      ? `${field.name} { ${fallback.join(' ')} }`
      : `${field.name} { __typename }`
  }

  // Term union — simplified to TermInterface
  if (schemaType.kind === 'UNION' && isTermUnion(field.type, schema)) {
    return `${field.name} { ${termSpread()} }`
  }

  // Media union — simplified to MediaImage/MediaVideo
  if (schemaType.kind === 'UNION' && isMediaUnion(field.type, schema)) {
    return `${field.name} { ${buildMediaFragments(field.type, schema)} }`
  }

  // Paragraph union — always use the full aliased shape so that same-named
  // fields across bundles with different nullability can coexist, and so that
  // composite subfields (Text, Link, DateRange, …) get proper subselections.
  // Pass through buildFieldSelection's depth: if we're already inside a
  // node-union-expansion chain (depth > 0), the nested paragraph body emits
  // sparse node refs to bound query size.
  if (isParagraphUnion(schemaType)) {
    return `${field.name} { ${buildParagraphUnionBody(schemaType, schema, depth)} }`
  }

  // Node-reference union — only expand members at the top level. Nested
  // node references (e.g. NodeDealDetail.business → NodeArticleDetail.business)
  // collapse to a shallow NodeInterface selection: following them recursively
  // blows up query size and forces composite subfields past the depth limit,
  // which leaves them without the required sub-selection.
  const isNodeUnion = schemaType.kind === 'UNION'
    && !!schemaType.possibleTypes?.length
    && schemaType.possibleTypes.every(pt => pt.name.startsWith('Node'))
  if (isNodeUnion && depth > 0) {
    return `${field.name} { ... on NodeInterface { id title path } }`
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

/**
 * Build the selection body for a paragraph union field.
 *
 * Always emits the full aliased shape: `... on ParagraphFoo { __typename foo_body: body { value processed format } ... }`.
 * Per-type aliases sidestep GraphQL's field-merge rule (same unaliased name across
 * inline fragments must return identical types), and the full subselections satisfy
 * the "composite types require a selection set" rule.
 *
 * This is the ONLY shape we emit for paragraph unions, at any depth. The runtime
 * dealiasResponse() walks the response recursively and strips the per-type prefixes.
 */
/**
 * @param depth   Paragraph-body depth in the surrounding query. `0` for the
 *                top-level body (e.g. `NodeLanding.content`); `>0` when the
 *                body is reached transitively through a node-union field's
 *                full expansion (e.g. `NodeDealDetail.business.<NodeX>.content`).
 *                Used to gate NodeCard fragment emission — only the top-level
 *                body gets rich node selections; deeper bodies fall back to
 *                sparse refs to keep per-bundle query size bounded.
 */
function buildParagraphUnionBody(
  unionType: IntrospectionType,
  schema: IntrospectionSchema,
  depth = 0,
): string {
  const fragments = (unionType.possibleTypes ?? []).map(pt => {
    const pType = schema.types.find(t => t.name === pt.name)
    if (!pType?.fields) return `... on ${pt.name} { __typename id }`

    const base = pt.name.replace('Paragraph', '')
    const prefix = base.charAt(0).toLowerCase() + base.slice(1)

    const pFields = pType.fields
      .filter(f => !SKIP_FIELDS.has(f.name))
      .filter(f => !f.args?.length)
      .map(f => buildParagraphFieldSelection(f, schema, prefix, depth))
      .join(' ')

    return `... on ${pt.name} { __typename ${pFields} }`
  })
  return fragments.join(' ')
}

function isParagraphUnion(type: IntrospectionType): boolean {
  return type.kind === 'UNION'
    && !!type.possibleTypes?.length
    && type.possibleTypes.every(pt => pt.name.startsWith('Paragraph'))
}

// ── NodeCard fragment (rich nested-node selection inside paragraphs) ─

/**
 * Build inline fragments for each possible NodeX in a node-union, emitting
 * a "card fragment" per node type: every safe scalar + one-level composite
 * expansion (media, term, address, geofield, date-range, …), bounded so the
 * query stays finite and recursion-free.
 *
 * Used for node-union references that appear inside paragraph fields. The
 * prior selection here was `{ ... on NodeInterface { id title path } }`,
 * which left card-rendering paragraph adapters with sparse stubs and no
 * way to render image, excerpt, geo, taxonomy, or any other rich field
 * the consumer's mappers depend on.
 *
 * Safety rails:
 *   - Walks each NodeX in the union via introspection — new node types pick
 *     up coverage automatically with no codegen edit.
 *   - One-hop guard on nested node unions: if a Node field is itself a node
 *     union, collapse to sparse `{ id title path }` to terminate recursion.
 *   - Deny paragraph unions entirely — would otherwise loop Node→Paragraph→Node.
 *   - Composite objects expand one level deep (matching the existing
 *     pattern in buildParagraphFieldSelection for sibling fields like
 *     Address/Geofield/DateRange), enough for DateRange.start.timestamp
 *     but not enough for runaway expansion.
 *   - Skip fields with required args and the small NODE_CARD_DENY_FIELD_NAMES
 *     list (paragraphs, body).
 */
function buildNodeCardFragments(unionType: IntrospectionType, schema: IntrospectionSchema): string {
  // Each node type's card selection is constant (no aliases, no depth variance —
  // emitted at depth 0 only), so register one named fragment per node type and
  // spread it. The same `FragCard_NodeX` is reused everywhere this node type
  // appears as a card ref, which is where most of the per-bundle query bloat was.
  const spreads = (unionType.possibleTypes ?? []).map(pt => {
    const fragName = `FragCard_${pt.name}`
    if (!fragmentDefs.has(fragName)) {
      const memberType = schema.types.find(t => t.name === pt.name)
      const body = !memberType?.fields
        ? '__typename id'
        : `__typename ${memberType.fields
            .filter(f => !SKIP_FIELDS.has(f.name))
            .filter(f => !NODE_CARD_DENY_FIELD_NAMES.has(f.name))
            .filter(f => !f.args?.length)
            .map(f => buildNodeCardFieldSelection(f, schema))
            .filter((s): s is string => !!s)
            .join(' ')}`
      fragmentDefs.set(fragName, `fragment ${fragName} on ${pt.name} { ${body} }`)
    }
    return `...${fragName}`
  })
  return spreads.join(' ')
}

/**
 * Field selection inside a NodeCard fragment. Mirrors the composite-handling
 * of buildParagraphFieldSelection (one-level scalar/composite expansion for
 * common Drupal object types) but with hard stops on anything that could
 * recurse: paragraph unions return null (skipped), nested node unions
 * collapse to the sparse selection.
 *
 * Returns null when the field can't be safely expanded; callers filter
 * nulls from the resulting selection.
 */
function buildNodeCardFieldSelection(field: IntrospectionField, schema: IntrospectionSchema): string | null {
  const typeName = unwrapTypeName(field.type)
  const schemaType = schema.types.find(t => t.name === typeName)

  // Scalar / enum
  if (!schemaType || schemaType.kind === 'SCALAR' || schemaType.kind === 'ENUM') {
    return field.name
  }

  // Term union → name only
  if (isTermUnion(field.type, schema)) {
    return `${field.name} { ${termSpread()} }`
  }

  // Media union → image url / video url
  if (isMediaUnion(field.type, schema)) {
    return `${field.name} { ${buildMediaFragments(field.type, schema)} }`
  }

  // Paragraph union → DENY. Would re-enter the paragraph machinery.
  if (schemaType.kind === 'UNION' && schemaType.possibleTypes?.some(pt => pt.name.startsWith('Paragraph'))) {
    return null
  }

  // Nested node union → one-hop guard. Sparse selection only.
  if (schemaType.kind === 'UNION' && schemaType.possibleTypes?.some(pt => pt.name.startsWith('Node'))) {
    return `${field.name} { ... on NodeInterface { id title path } }`
  }

  // OBJECT (Address, Geofield, DateRange, Text, Image, …) — one-level scalar
  // expansion, with one nested OBJECT level to cover DateRange.start →
  // DateTime { timestamp } pattern.
  if (schemaType.kind === 'OBJECT') {
    const scalars = (schemaType.fields ?? [])
      .filter(f => !SKIP_FIELDS.has(f.name) && !f.args?.length)
      .map(f => {
        const n = unwrapTypeName(f.type)
        const t = schema.types.find(s => s.name === n)
        if (!t || t.kind === 'SCALAR' || t.kind === 'ENUM') return f.name
        if (t.kind === 'OBJECT') {
          const inner = (t.fields ?? [])
            .filter(sf => !SKIP_FIELDS.has(sf.name) && !sf.args?.length)
            .filter(sf => {
              const sn = unwrapTypeName(sf.type)
              const st = schema.types.find(s => s.name === sn)
              return !st || st.kind === 'SCALAR' || st.kind === 'ENUM'
            })
            .map(sf => sf.name)
          return inner.length > 0 ? `${f.name} { ${inner.join(' ')} }` : null
        }
        // Media/term unions inside the object — keep them simple.
        if (t.kind === 'UNION' && isTermUnion(f.type, schema)) {
          return `${f.name} { ${termSpread()} }`
        }
        if (t.kind === 'UNION' && isMediaUnion(f.type, schema)) {
          return `${f.name} { ${buildMediaFragments(f.type, schema)} }`
        }
        return null
      })
      .filter((s): s is string => !!s)
    return scalars.length > 0 ? `${field.name} { ${scalars.join(' ')} }` : null
  }

  return null
}

// ── Paragraph-specific field builder (conservative) ──────────────────

/**
 * Build field selection for paragraph content fields.
 * Uses a flat strategy: expands fieldset children with scalar fields only,
 * uses simplified patterns for media/term unions.
 */
/**
 * @param depth   Paragraph-body depth in the surrounding query (see
 *                buildParagraphUnionBody). Threaded through so that the
 *                node-union case below can switch between the rich
 *                NodeCard fragment expansion (top-level body, depth 0)
 *                and the sparse `{ id title path }` selection (nested
 *                bodies, depth > 0) — bounding query size without
 *                losing card-rendering data where it matters most.
 */
function buildParagraphFieldSelection(
  field: IntrospectionField,
  schema: IntrospectionSchema,
  aliasPrefix?: string,
  depth = 0,
): string {
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

  // Node union inside a paragraph → emit a rich NodeCard fragment per
  // possible Node type AT THE TOP-LEVEL paragraph body only. Deeper bodies
  // (reached when an outer node-union field at depth 0 expanded its members,
  // each of which has its own `content` paragraphs field — e.g.
  // NodeDealDetail.business.NodeX.content) fall back to the sparse
  // `{ id title path }` selection. Rich expansion at every nesting level
  // multiplies query size 7-10× per level; the top-level body is where the
  // card-rendering adapters actually consume the data.
  if (schemaType.kind === 'UNION' && schemaType.possibleTypes?.some(pt => pt.name.startsWith('Node'))) {
    if (depth > 0) {
      return `${alias}${field.name} { ... on NodeInterface { id title path } }`
    }
    return `${alias}${field.name} { ${buildNodeCardFragments(schemaType, schema)} }`
  }

  // Term union → simple name
  if (isTermUnion(field.type, schema)) {
    return `${alias}${field.name} { ${termSpread()} }`
  }

  // Media union → image url
  if (isMediaUnion(field.type, schema)) {
    return `${alias}${field.name} { ${buildMediaFragments(field.type, schema)} }`
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
            if (isTermUnion(f.type, schema)) return `${f.name} { ${termSpread()} }`
            if (isMediaUnion(f.type, schema)) return `${f.name} { ${buildMediaFragments(f.type, schema)} }`
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
  // Fresh named-fragment registry per run (the module-level map persists across
  // calls otherwise — harmless for a one-shot CLI, but keeps repeat calls clean).
  fragmentDefs = new Map()

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
        if (isTermUnion(f.type, schema)) return `${f.name} { ${termSpread()} }`
        if (isMediaUnion(f.type, schema)) return `${f.name} { ${buildMediaFragments(f.type, schema)} }`
        return buildFieldSelection(f, schema, 0, 2)
      })
      .join(' ')

    const fragment = customFields ? `\n          ... on ${type.name} { ${customFields} }` : ''

    const listQuery = `query ($first: Int, $after: Cursor, $sortKey: ConnectionSortKeys, $reverse: Boolean) {
      ${plural}(first: $first, after: $after, sortKey: $sortKey, reverse: $reverse) {
        nodes {
          __typename id title path created { time } changed { time }${fragment}
        }
        pageInfo { hasNextPage endCursor }
      }
    }`
    const singleQuery = `query ($id: ID!) {
      node(id: $id) {
        __typename id title path created { time } changed { time }${fragment}
      }
    }`

    lines.push(`  ${type.name}: {`)
    lines.push(`    list: \`${withFragments(listQuery)}\`,`)
    lines.push(`    single: \`${withFragments(singleQuery)}\`,`)
    lines.push(`  },`)
  }
  lines.push('} as const\n')

  // ── Route query (simple — no paragraphs) ──────────────────────

  lines.push('// ─── Route Query (simple entity resolution — no paragraph content) ──\n')
  const routeEntityFragments = nodeTypes
    .map(type => {
      // Skip content/paragraph fields in route query — use PAGE_QUERY for those
      const customFields = (type.fields ?? [])
        .filter(f => !SKIP_FIELDS.has(f.name) && !BASE_NODE_FIELDS.has(f.name))
        .filter(f => f.name !== 'content') // skip paragraph content
        .filter(f => !f.args?.length)
        .map(f => {
          // Simplified: term → name, media → url, scalars only
          if (isTermUnion(f.type, schema)) return `${f.name} { ${termSpread()} }`
          if (isMediaUnion(f.type, schema)) return `${f.name} { ${buildMediaFragments(f.type, schema)} }`
          const tn = unwrapTypeName(f.type)
          const st = schema.types.find(t => t.name === tn)
          if (!st || st.kind === 'SCALAR' || st.kind === 'ENUM') return f.name
          // Use buildFieldSelection for proper recursion (handles DateRange → DateTime → timestamp etc.)
          return buildFieldSelection(f, schema, 0, 2)
        })
        .join(' ')
      const allFields = customFields ? ` ${customFields}` : ''
      return `          ... on ${type.name} { __typename id title path created { time } changed { time }${allFields} }`
    })
    .join('\n')
  const routeBody = `  query ($path: String!) {
    route(path: $path) {
      ... on RouteInternal {
        entity {
${routeEntityFragments}
        }
      }
    }
  }`
  lines.push('export const ROUTE_QUERY = `')
  lines.push(withFragments(routeBody))
  lines.push('`\n')

  // ── Page query (deep — includes paragraph content) ──────────────

  // Find node types that have a "content" field (paragraph references)
  const pageTypes = nodeTypes.filter(t =>
    t.fields?.some(f => f.name === 'content')
  )

  if (pageTypes.length) {
    // Build per-bundle entity fragments once — reused for both the legacy
    // mega-PAGE_QUERY and the new per-bundle PAGE_QUERY_* variants.
    const perBundleFragments: Array<{ type: typeof pageTypes[number]; fragment: string }> = []
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

        if (contentUnion && isParagraphUnion(contentUnion)) {
          const body = buildParagraphUnionBody(contentUnion, schema)
            .split(' ... on ')
            .join('\n              ... on ')
          contentSelection = `content {\n              ${body}\n            }`
        }
      }

      const allFields = nonContentFields ? ` ${nonContentFields}` : ''
      perBundleFragments.push({
        type,
        fragment: `... on ${type.name} { __typename id title path created { time } changed { time }${allFields} ${contentSelection} }`,
      })
    }

    // Per-bundle slim queries — Drupal's GraphQL resolver still walks every
    // fragment in the entity { ... } selection, even ones that don't match the
    // resolved node type, so the legacy single PAGE_QUERY (containing all 8
    // bundles' paragraph trees) can take 10× longer than necessary on slow
    // hosting like Pantheon multidev. Emit one slim query per bundle so the
    // typed client can route to the variant that matches the page's type.
    lines.push('// ─── Per-bundle Page Queries (slim — one fragment each) ──────────────\n')
    for (const { type, fragment } of perBundleFragments) {
      const constName = `PAGE_QUERY_${typeNameToSnakeUpper(type.name)}`
      const body = `  query ($path: String!) {
    route(path: $path) {
      ... on RouteInternal {
        entity {
          ${fragment}
        }
      }
    }
  }`
      lines.push(`export const ${constName} = \``)
      lines.push(withFragments(body))
      lines.push('`\n')
    }

    // Lookup map: __typename → slim query. getPage() probes the type with a
    // tiny query, then runs the matching slim variant. Falls back to the
    // legacy mega-query if the type isn't recognized.
    lines.push('export const PAGE_QUERY_BY_TYPE: Record<string, string> = {')
    for (const { type } of perBundleFragments) {
      lines.push(`  ${JSON.stringify(type.name)}: PAGE_QUERY_${typeNameToSnakeUpper(type.name)},`)
    }
    lines.push('}\n')

    // Tiny probe query — used to discover the entity's __typename in ~50ms
    // before running the heavier per-bundle slim query.
    lines.push('export const PAGE_TYPE_PROBE = `')
    lines.push('  query ($path: String!) {')
    lines.push('    route(path: $path) {')
    lines.push('      ... on RouteInternal {')
    lines.push('        entity { __typename }')
    lines.push('      }')
    lines.push('    }')
    lines.push('  }')
    lines.push('`\n')

    // Legacy mega-PAGE_QUERY — kept for backwards compatibility with code
    // that imports PAGE_QUERY directly. New callers should prefer the typed
    // client's getPage() which uses the slim per-bundle variants.
    lines.push('// ─── Page Query (legacy — single mega-query, all bundles) ────────────\n')
    const pageBody = `  query ($path: String!) {
    route(path: $path) {
      ... on RouteInternal {
        entity {
${perBundleFragments.map(({ fragment }) => `          ${fragment}`).join('\n')}
        }
      }
    }
  }`
    lines.push('export const PAGE_QUERY = `')
    lines.push(withFragments(pageBody))
    lines.push('`\n')
  }

  // ── Typed client interface + factory ──────────────────────────

  lines.push(TYPED_CLIENT_INTERFACE)
  lines.push(CREATE_TYPED_CLIENT)

  return lines.join('\n')
}
