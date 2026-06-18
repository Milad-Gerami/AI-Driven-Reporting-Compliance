'use strict';

const { Router } = require('express');

const router = Router();

router.get('/', (req, res) => {
  res.status(200).json({
    id: req.user.id,
    email: req.user.email,
    display_name: req.user.display_name,
    status: req.user.status,
    tenant: {
      id: req.tenant.id,
      name: req.tenant.name,
      slug: req.tenant.slug,
    },
    memberships: req.memberships.map(m => ({
      id: m.id,
      agency_id: m.agency_id,
      agency_name: m.agency_name,
      role_id: m.role_id,
      role_name: m.role_name,
    })),
    permissions: [...req.effectivePermissions].sort(),
  });
});

module.exports = router;
