// Catches errors from upstream middleware and route handlers.
// Formats them into the standard error response shape defined in directives/api-contract.md.
// Sanitizes 5xx errors to a generic message. Never exposes stack traces, connection strings,
// hostnames, or secrets. Includes req.requestId for correlation.
// Runs on every request. See directives/middleware-architecture.md section 8.

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  const status = err.status || err.statusCode || 500;
  const isServerError = status >= 500;

  // TODO: Log full error details (including stack) to application logs for debugging

  res.status(status).json({
    error: {
      code: isServerError ? 'INTERNAL_ERROR' : (err.code || 'UNKNOWN_ERROR'),
      message: isServerError ? 'Internal server error' : (err.message || 'An error occurred'),
      request_id: req.requestId,
    },
  });
}

module.exports = errorHandler;
