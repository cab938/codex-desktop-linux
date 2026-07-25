export class BrokerError extends Error {
  constructor(code, message, options = {}) {
    super(message, { cause: options.cause })
    this.name = 'BrokerError'
    this.code = code
    this.retryable = options.retryable ?? false
    this.details = options.details ?? {}
    this.httpStatus = options.httpStatus ?? 400
  }
}

export function assertBroker(condition, code, message, options) {
  if (!condition) throw new BrokerError(code, message, options)
}

export function toSafeError(error) {
  if (error instanceof BrokerError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      details: error.details,
    }
  }
  return {
    code: 'INTERNAL',
    message: 'The collaborative Markdown broker failed unexpectedly.',
    retryable: false,
    details: {},
  }
}
