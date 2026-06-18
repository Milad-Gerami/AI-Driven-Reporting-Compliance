'use strict';

const REQUIRED_DEPS = ['verifyToken', 'resolveTenant', 'resolveUser', 'loadMemberships'];

function extractToken(authHeader) {
  if (!authHeader) return null;

  const spaceIndex = authHeader.indexOf(' ');
  if (spaceIndex === -1) return null;

  const scheme = authHeader.slice(0, spaceIndex);
  if (scheme.toLowerCase() !== 'bearer') return null;

  const token = authHeader.slice(spaceIndex + 1).trim();
  if (!token) return null;

  return token;
}

function flattenPermissions(memberships) {
  const permissions = new Set();
  for (const membership of memberships) {
    const map = membership.permissions;
    if (!map || typeof map !== 'object') continue;
    for (const [key, value] of Object.entries(map)) {
      if (value === true) permissions.add(key);
    }
  }
  return permissions;
}

function reject(req, res, internalReason) {
  // eslint-disable-next-line no-console
  console.warn(`auth_failure request_id=${req.requestId} reason=${internalReason}`);
  res.status(401).json({
    error: {
      code: 'UNAUTHENTICATED',
      message: 'Authentication required.',
      request_id: req.requestId,
    },
  });
}

function createAuthenticationMiddleware(deps) {
  for (const name of REQUIRED_DEPS) {
    if (typeof deps[name] !== 'function') {
      throw new Error(`createAuthenticationMiddleware: ${name} must be a function`);
    }
  }

  const { verifyToken, resolveTenant, resolveUser, loadMemberships } = deps;

  return async function authentication(req, res, next) {
    const token = extractToken(req.headers['authorization']);
    if (!token) {
      return reject(req, res, 'auth.token_missing');
    }

    let claims;
    try {
      claims = await verifyToken(token);
    } catch {
      return reject(req, res, 'auth.token_verification_failed');
    }

    let tenant;
    try {
      tenant = await resolveTenant(claims.tenantIdentifier);
    } catch {
      return reject(req, res, 'auth.tenant_resolution_error');
    }
    if (!tenant) {
      return reject(req, res, 'auth.tenant_not_found');
    }

    let user;
    try {
      user = await resolveUser(tenant.id, claims.userSubject, claims.userEmail);
    } catch {
      return reject(req, res, 'auth.user_resolution_error');
    }
    if (!user) {
      return reject(req, res, 'auth.user_not_found');
    }
    if (user.status !== 'active') {
      return reject(req, res, 'auth.user_inactive');
    }

    let memberships;
    try {
      memberships = await loadMemberships(tenant.id, user.id);
    } catch {
      return reject(req, res, 'auth.membership_loading_error');
    }

    req.tenantId = tenant.id;
    req.userId = user.id;
    req.memberships = memberships;
    req.effectivePermissions = flattenPermissions(memberships);
    req.user = { id: user.id, email: user.email, display_name: user.display_name, status: user.status };
    req.tenant = { id: tenant.id, name: tenant.name, slug: tenant.slug, status: tenant.status };

    next();
  };
}

createAuthenticationMiddleware.flattenPermissions = flattenPermissions;

module.exports = createAuthenticationMiddleware;
