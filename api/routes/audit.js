'use strict';

const { Router } = require('express');

function createAuditRoutes() {
  const router = Router();

  router.get('/', (_req, res) => {
    res.status(200).json({ status: 'not_implemented' });
  });

  return router;
}

module.exports = createAuditRoutes;
