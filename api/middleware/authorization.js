// Enforces agency membership checks and permission checks.
// For agency-scoped routes: verifies agency exists (404) then verifies caller access (403).
// For permission-gated routes: checks req.effectivePermissions for the required string.
// Also enforces escalation prevention and separation of duties where applicable.
// Skipped for health endpoints and /me. See directives/middleware-architecture.md section 5.

// TODO: Implement agency existence check within current tenant
// TODO: Implement agency membership check (direct or tenant-wide membership)
// TODO: Implement permission string check against req.effectivePermissions
// TODO: Implement escalation prevention for membership management routes
// TODO: Implement separation of duties for report approval transitions
// TODO: Set req.agencyId after successful agency validation

function authorization(req, res, next) {
  next();
}

module.exports = authorization;
