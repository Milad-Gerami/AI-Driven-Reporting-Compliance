const { Router } = require('express');

const router = Router();

router.get('/live', (req, res) => {
  res.status(200).json({
    status: 'ok',
    version: '0.1.0',
    api: 'v1',
  });
});

module.exports = router;
