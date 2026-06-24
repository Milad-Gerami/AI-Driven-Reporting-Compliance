'use strict';

const { Router } = require('express');

function createAgencyRoutes({
  authorize,
  validate,
  listAgencies,
  getAgency,
  createAgency,
  createAuditEvent,
  updateAgency,
  deleteAgency,
}) {
  const deps = { authorize, validate, listAgencies, getAgency, createAgency, createAuditEvent, updateAgency, deleteAgency };
  for (const [name, dep] of Object.entries(deps)) {
    if (typeof dep !== 'function') {
      throw new Error(`createAgencyRoutes: ${name} must be a function`);
    }
  }

  const router = Router();

  router.get('/', async (req, res, next) => {
    try {
      const agencies = await listAgencies(req.tenantContext, req.tenantId);
      res.status(200).json(agencies);
    } catch (err) {
      next(err);
    }
  });

  router.get('/:agency_id', async (req, res, next) => {
    try {
      const agency = await getAgency(req.tenantContext, req.tenantId, req.params.agency_id);
      if (!agency) {
        return res.status(404).json({
          error: {
            code: 'NOT_FOUND',
            message: 'Agency not found.',
            request_id: req.requestId,
          },
        });
      }
      res.status(200).json(agency);
    } catch (err) {
      next(err);
    }
  });

  router.post(
    '/',
    authorize('agencies.create'),
    validate,
    async (req, res, next) => {
      try {
        const agency = await createAgency(req.tenantContext, req.tenantId, req.validated.body);
        await createAuditEvent(req.tenantContext, {
          tenant_id: req.tenantId,
          actor_id: req.userId,
          actor_type: 'user',
          action: 'agency.created',
          resource_type: 'agencies',
          resource_id: agency.id,
          metadata: {
            ip_address: req.auditContext.ipAddress,
            user_agent: req.auditContext.userAgent,
            request_method: req.auditContext.requestMethod,
            request_path: req.auditContext.requestPath,
            after: agency,
          },
        });
        res.status(201).json(agency);
      } catch (err) {
        next(err);
      }
    },
  );

  router.patch(
    '/:agency_id',
    authorize('agencies.update'),
    validate,
    async (req, res, next) => {
      try {
        const before = await getAgency(req.tenantContext, req.tenantId, req.params.agency_id);
        if (!before) {
          return res.status(404).json({
            error: {
              code: 'NOT_FOUND',
              message: 'Agency not found.',
              request_id: req.requestId,
            },
          });
        }
        const agency = await updateAgency(
          req.tenantContext,
          req.tenantId,
          req.params.agency_id,
          req.validated.body,
        );
        if (!agency) {
          return res.status(404).json({
            error: {
              code: 'NOT_FOUND',
              message: 'Agency not found.',
              request_id: req.requestId,
            },
          });
        }
        await createAuditEvent(req.tenantContext, {
          tenant_id: req.tenantId,
          actor_id: req.userId,
          actor_type: 'user',
          action: 'agency.updated',
          resource_type: 'agencies',
          resource_id: agency.id,
          metadata: {
            ip_address: req.auditContext.ipAddress,
            user_agent: req.auditContext.userAgent,
            request_method: req.auditContext.requestMethod,
            request_path: req.auditContext.requestPath,
            before,
            after: agency,
          },
        });
        res.status(200).json(agency);
      } catch (err) {
        next(err);
      }
    },
  );

  router.delete(
    '/:agency_id',
    authorize('agencies.delete'),
    async (req, res, next) => {
      try {
        const before = await getAgency(req.tenantContext, req.tenantId, req.params.agency_id);
        if (!before) {
          return res.status(404).json({
            error: {
              code: 'NOT_FOUND',
              message: 'Agency not found.',
              request_id: req.requestId,
            },
          });
        }
        const deleted = await deleteAgency(
          req.tenantContext,
          req.tenantId,
          req.params.agency_id,
        );
        if (!deleted) {
          return res.status(404).json({
            error: {
              code: 'NOT_FOUND',
              message: 'Agency not found.',
              request_id: req.requestId,
            },
          });
        }
        await createAuditEvent(req.tenantContext, {
          tenant_id: req.tenantId,
          actor_id: req.userId,
          actor_type: 'user',
          action: 'agency.deleted',
          resource_type: 'agencies',
          resource_id: before.id,
          metadata: {
            ip_address: req.auditContext.ipAddress,
            user_agent: req.auditContext.userAgent,
            request_method: req.auditContext.requestMethod,
            request_path: req.auditContext.requestPath,
            before,
          },
        });
        res.status(204).end();
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}

module.exports = createAgencyRoutes;
