'use strict';

function createTenantContextMiddleware(deps) {
  if (!deps || typeof deps.withTenantContext !== 'function') {
    throw new Error('createTenantContextMiddleware: withTenantContext must be a function');
  }

  const { withTenantContext } = deps;

  return async function tenantContext(req, res, next) {
    if (!req.tenantId || !req.tenant) {
      return res.status(401).json({
        error: {
          code: 'UNAUTHENTICATED',
          message: 'Authentication required.',
          request_id: req.requestId,
        },
      });
    }

    if (req.tenant.status !== 'active') {
      return res.status(401).json({
        error: {
          code: 'UNAUTHENTICATED',
          message: 'Authentication required.',
          request_id: req.requestId,
        },
      });
    }

    try {
      await withTenantContext(req.tenantId, async (ctx) => {
        req.tenantContext = ctx;
        next();
      });
    } catch (err) {
      next(err);
    }
  };
}

module.exports = createTenantContextMiddleware;
