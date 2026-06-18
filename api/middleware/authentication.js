// Validates the caller's identity and loads their authorization context.
// Extracts JWT/session token, resolves tenant, user, memberships, and effective permissions.
// Rejects with 401 (UNAUTHENTICATED) on any failure. Never reveals which step failed.
// Skipped for health endpoints. See directives/middleware-architecture.md section 3.

// TODO: Implement token extraction from Authorization header (Bearer scheme)
// TODO: Implement token signature, expiration, and issuer validation
// TODO: Resolve tenant from token claim against tenants table
// TODO: Resolve user from token sub/email within the resolved tenant
// TODO: Load memberships with joined roles and flatten effective permissions
// TODO: Populate req.tenantId, req.userId, req.memberships, req.effectivePermissions

function authentication(req, res, next) {
  next();
}

module.exports = authentication;
