'use strict';

function auditContext(req, res, next) {
  req.auditContext = {
    ipAddress: req.ip,
    userAgent: req.headers['user-agent'] || null,
    requestMethod: req.method,
    requestPath: req.originalUrl,
  };
  next();
}

module.exports = auditContext;
