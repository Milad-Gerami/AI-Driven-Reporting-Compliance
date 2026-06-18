const { Router } = require('express');

const router = Router();

router.get('/live', (req, res) => {
  res.status(200).json({
    status: 'ok',
    version: '0.1.0',
    api: 'v1',
  });
});

router.get('/ready', (req, res) => {
  // TODO: Replace with real PostgreSQL connectivity check (SELECT 1)
  const databaseStatus = 'ok';
  // TODO: Replace with real secrets-manager reachability check
  const secretsManagerStatus = 'ok';

  const allOk = databaseStatus === 'ok' && secretsManagerStatus === 'ok';

  res.status(allOk ? 200 : 503).json({
    status: allOk ? 'ok' : 'error',
    version: '0.1.0',
    api: 'v1',
    checks: {
      database: databaseStatus,
      secrets_manager: secretsManagerStatus,
    },
  });
});

module.exports = router;
