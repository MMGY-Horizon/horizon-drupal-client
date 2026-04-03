/**
 * Base types for Drupal content entities.
 * Generated code extends these at runtime.
 */

/** Base interface for all Drupal nodes */
export interface DrupalNode {
  __typename: string
  id: string
  title: string
  path: string
  created: { time: string }
  changed: { time: string }
}

/** Base interface for Drupal paragraph entities */
export interface DrupalParagraph {
  __typename: string
  id: string
}

/** Base interface for Drupal taxonomy terms */
export interface DrupalTerm {
  __typename: string
  id: string
  name: string
  path?: string
  description?: { processed: string }
}
