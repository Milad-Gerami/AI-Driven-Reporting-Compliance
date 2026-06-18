'use strict';

const { Router } = require('express');
const { z } = require('zod');
const createValidationMiddleware = require('../middleware/validation');

const patchTenantBody = z.object({
  name: z.string().min(1).max(255).optional(),
  slug: z.string().regex(/^[a-z][a-z0-9-]{2,62}$/).optional(),
}).refine(
  (data) => data.name !== undefined || data.slug !== undefined,
  { message: 'At least one field (name or slug) must be provided' },
);

function createTenantRoutes({ authorize, getTenant, updateTenant }) {
  if (!authorize || typeof authorize.requirePermission !== 'function') {
    throw new Error('createTenantRoutes: authorize.requirePermission must be a function');
  }
  if (typeof getTenant !== 'function') {
    throw new Error('createTenantRoutes: getTenant must be a function');
  }
  if (typeof updateTenant !== 'function') {
    throw new Error('createTenantRoutes: updateTenant must be a function');
  }

  const router = Router();

  router.get('/', async (req, res, next) => {
    try {
      const tenant = await getTenant(req.tenantContext, req.tenantId);
      res.status(200).json(tenant);
    } catch (err) {
      next(err);
    }
  });

  router.patch(
    '/',
    authorize.requirePermission('tenant.admin'),
    createValidationMiddleware({ body: patchTenantBody }),
    async (req, res, next) => {
      try {
        const tenant = await updateTenant(req.tenantContext, req.tenantId, req.validated.body);
        res.status(200).json(tenant);
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}

module.exports = createTenantRoutes;
