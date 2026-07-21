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

/** Smart Date occurrence (horizon_smart_date GraphQL exposure).
 *  Recurring events expose one entry per generated occurrence. */
export interface SmartDate {
  value?: number
  endValue?: number
  duration?: number
  timezone?: string
  rrule?: number
  rruleIndex?: number
}

/** Media image entity (from GraphQL Compose MediaImage type) */
export interface MediaImage {
  mediaImage?: {
    url: string
    alt?: string
    width?: number
    height?: number
  }
  /** Optional caption — only present when the schema exposes it (e.g. media.image.field_caption). */
  caption?: string
}

/** Media video entity */
export interface MediaVideo {
  mediaVideoFile?: {
    url: string
  }
  /** Optional WebM rendition — only present when the schema exposes field_media_video_webm. */
  mediaVideoWebm?: {
    url: string
  }
}
