// Assigns a unique request ID to every inbound request for log correlation.
// Adopts X-Request-ID from the caller if present and valid; otherwise generates a new UUID v4.
// Sets the X-Request-ID response header. Never rejects. Runs on every request including health endpoints.

const crypto = require('crypto');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function requestId(req, res, next) {
  const incoming = req.headers['x-request-id'];
  req.requestId = (incoming && UUID_RE.test(incoming)) ? incoming : crypto.randomUUID();
  res.setHeader('X-Request-ID', req.requestId);
  next();
}

module.exports = requestId;
