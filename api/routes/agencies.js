'use strict';

const { Router } = require('express');

function createAgencyRoutes({
  authorize,
  validate,
  listAgencies,
  getAgency,
  createAgency,
  updateAgency,
  deleteAgency,
}) {
  const deps = { authorize, validate, listAgencies, getAgency, createAgency, updateAgency, deleteAgency };
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
        res.status(204).end();
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}

module.exports = createAgencyRoutes;
