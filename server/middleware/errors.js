import { AppError } from '../errors.js';

export function notFound(request, response) {
  response.status(404).json({ error: { code: 'NOT_FOUND', message: 'Endpoint not found.' } });
}

export function errorHandler(logger) {
  return (error, request, response, _next) => {
    const appError = error instanceof AppError ? error : null;
    const status = appError?.status || 500;
    // `request.path` deliberately excludes the query string; route params are
    // opaque ids. Together with the request id that is all a bug report needs.
    // A locked harness answering 503 is expected state, not a failure.
    const expectedState = ['HARNESS_LOCKED', 'HARNESS_UNINITIALIZED'].includes(appError?.code);
    if (status >= 500 && !expectedState) logger.error({ err: error, path: request.path, status, reqId: request.id }, 'Request failed');
    response.status(status).json({
      error: {
        code: appError?.code || 'INTERNAL_ERROR',
        message: appError?.expose ? appError.message : 'An unexpected server error occurred.',
        ...(appError?.details ? { details: appError.details } : {}),
      },
    });
  };
}
