export class AppError extends Error {
  constructor(message, { status = 500, code = 'INTERNAL_ERROR', expose = false, details } = {}) {
    super(message);
    this.name = this.constructor.name;
    this.status = status;
    this.code = code;
    this.expose = expose;
    this.details = details;
  }
}

export class ValidationError extends AppError {
  constructor(message, details) {
    super(message, { status: 400, code: 'VALIDATION_ERROR', expose: true, details });
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Resource not found') {
    super(message, { status: 404, code: 'NOT_FOUND', expose: true });
  }
}

export class ConflictError extends AppError {
  constructor(message) {
    super(message, { status: 409, code: 'CONFLICT', expose: true });
  }
}

export class ServiceUnavailableError extends AppError {
  constructor(message, code = 'SERVICE_UNAVAILABLE') {
    super(message, { status: 503, code, expose: true });
  }
}

export class QueryDeadlineError extends AppError {
  constructor(message = 'Search took too long. Narrow the query with a more specific from:, to:, subject:, after:, or phrase and try again.') {
    super(message, { status: 408, code: 'QUERY_DEADLINE', expose: true });
  }
}
