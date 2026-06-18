// Activates PostgreSQL row-level security for the authenticated tenant.
// Verifies tenant status is active, then executes SET LOCAL app.current_tenant_id
// on the database connection. Rejects with 401 if tenant is suspended or offboarded.
// Once set, the tenant context must not change during request processing.
// Skipped for health endpoints. See directives/middleware-architecture.md section 4.

// TODO: Read req.tenantId (set by authentication middleware)
// TODO: Verify tenant status is 'active' against the database
// TODO: Execute SET LOCAL app.current_tenant_id on the DB connection

function tenantContext(req, res, next) {
  next();
}

module.exports = tenantContext;
