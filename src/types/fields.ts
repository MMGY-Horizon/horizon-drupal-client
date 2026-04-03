/**
 * Drupal field types as they appear in GraphQL Compose responses.
 * Used by generated code and for manual type authoring.
 */

/** Formatted text field */
export interface Text {
  value: string
}

/** Formatted text with summary */
export interface TextSummary {
  value: string
  processed?: string
  summary?: string
}

/** Media image (via MediaImage → mediaImage) */
export interface Image {
  url: string
  alt?: string
  width?: number
  height?: number
  variations?: ImageVariation[]
}

/** Image style variation */
export interface ImageVariation {
  name: string
  url: string
  width: number
  height: number
}

/** Link field */
export interface Link {
  uri?: string
  url?: string
  title?: string
}

/** DateTime field */
export interface DateTime {
  time: string
}

/** Address field */
export interface Address {
  addressLine1?: string
  addressLine2?: string
  locality?: string
  administrativeArea?: string
  postalCode?: string
  countryCode?: string
}

/** Geofield (lat/lon) */
export interface Geofield {
  lat: number
  lon: number
}

/** Date range field */
export interface DateRange {
  start?: { timestamp: number }
  end?: { timestamp: number }
}
