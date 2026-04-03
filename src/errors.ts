/**
 * Error types for the Horizon Drupal client.
 */

export class HorizonError extends Error {
  public readonly graphqlErrors: Array<{ message: string; path?: string[] }>

  constructor(errors: Array<{ message: string; path?: string[] }>) {
    const message = errors.map((e) => e.message).join('; ')
    super(message)
    this.name = 'HorizonError'
    this.graphqlErrors = errors
  }
}

export class NotFoundError extends Error {
  public readonly path: string

  constructor(path: string) {
    super(`No content found at path: ${path}`)
    this.name = 'NotFoundError'
    this.path = path
  }
}
