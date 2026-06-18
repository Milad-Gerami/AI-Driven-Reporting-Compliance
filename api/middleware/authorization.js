'use strict';

function createAuthorizationMiddleware(deps) {
  if (!deps || typeof deps.verifyAgency !== 'function') {
    throw new Error('createAuthorizationMiddleware: verifyAgency must be a function');
  }

  const { verifyAgency } = deps;

  function requirePermission(permission) {
    if (typeof permission !== 'string' || permission.length === 0) {
      throw new Error('createAuthorizationMiddleware: permission must be a non-empty string');
    }

    return function permissionCheck(req, res, next) {
      if (
        !req.effectivePermissions
        || typeof req.effectivePermissions.has !== 'function'
        || !req.effectivePermissions.has(permission)
      ) {
        return res.status(403).json({
          error: {
            code: 'FORBIDDEN',
            message: 'Insufficient permissions.',
            request_id: req.requestId,
          },
        });
      }
      next();
    };
  }

  function requireAgency() {
    return async function agencyCheck(req, res, next) {
      const agencyId = req.params.agency_id;

      let agency;
      try {
        agency = await verifyAgency(req.tenantId, agencyId);
      } catch (err) {
        return next(err);
      }

      if (!agency) {
        return res.status(404).json({
          error: {
            code: 'NOT_FOUND',
            message: 'Agency not found.',
            request_id: req.requestId,
          },
        });
      }

      const hasAccess = req.memberships && req.memberships.some(
        (m) => m.agency_id === agencyId || m.agency_id === null,
      );

      if (!hasAccess) {
        return res.status(403).json({
          error: {
            code: 'FORBIDDEN',
            message: 'Insufficient permissions.',
            request_id: req.requestId,
          },
        });
      }

      req.agencyId = agencyId;
      next();
    };
  }

  return { requirePermission, requireAgency };
}

module.exports = createAuthorizationMiddleware;
