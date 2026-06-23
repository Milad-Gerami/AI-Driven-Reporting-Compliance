'use strict';

const express = require('express');
const requestId = require('./middleware/request-id');
const auditContext = require('./middleware/audit-context');
const errorHandler = require('./middleware/error-handler');
const healthRoutes = require('./routes/health');
const meRoutes = require('./routes/me');

// Middleware execution order (see directives/middleware-architecture.md section 1):
//   1. request-id          — all routes
//   2. auth                — skipped for health (bypass via registration order)
//   3. tenant-context      — skipped for health
//   4. authorization       — per-route (applied by route files, not global)
//   5. validation          (route-specific, not global)
//   6. route handlers
//   7. audit-writer        — skipped for health
//   8. error-handler       — all routes

function createServer({ authentication, tenantContext, tenantRoutes, agencyRoutes, auditRoutes } = {}) {
  const app = express();

  app.use(express.json());
  app.use(requestId);

  // Health routes registered BEFORE the auth chain — they bypass
  // authentication, tenant-context, authorization, and audit-context.
  // See directives/middleware-architecture.md section 10.
  app.use('/api/v1/health', healthRoutes);

  // Authenticated middleware chain — only reached by non-health routes
  if (authentication) {
    app.use(authentication);
  }
  if (tenantContext) {
    app.use(tenantContext);
  }

  // /me requires auth + tenant-context but skips authorization and audit-context.
  // See directives/middleware-architecture.md section 10.
  app.use('/api/v1/me', meRoutes);

  app.use(auditContext);

  if (tenantRoutes) {
    app.use('/api/v1/tenant', tenantRoutes);
  }
  if (agencyRoutes) {
    app.use('/api/v1/agencies', agencyRoutes);
  }
  if (auditRoutes) {
    app.use('/api/v1/audit', auditRoutes);
  }

  app.use(errorHandler);

  return app;
}

module.exports = createServer;
