'use strict';

const { Router } = require('express');

function createAuditRoutes({ listAuditEvents }) {
  const deps = { listAuditEvents };
  for (const [name, dep] of Object.entries(deps)) {
    if (typeof dep !== 'function') {
      throw new Error(`createAuditRoutes: ${name} must be a function`);
    }
  }

  const router = Router();

  router.get('/', async (req, res, next) => {
    try {
      const auditEvents = await listAuditEvents(req.tenantContext, req.tenantId);
      res.status(200).json({ data: auditEvents });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = createAuditRoutes;
