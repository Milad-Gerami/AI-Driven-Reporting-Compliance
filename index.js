'use strict';

const createServer = require('./api/server');

// TODO: Wire real auth deps when IdP adapter and database queries are implemented
const app = createServer();

// TODO: Read port from environment/configuration
const PORT = 3000;

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`GovReport AI API listening on port ${PORT}`);
});
