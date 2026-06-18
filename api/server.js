const express = require('express');
const requestId = require('./middleware/request-id');
const authentication = require('./middleware/authentication');
const tenantContext = require('./middleware/tenant-context');
const authorization = require('./middleware/authorization');
const auditContext = require('./middleware/audit-context');
const errorHandler = require('./middleware/error-handler');
const healthRoutes = require('./routes/health');

const app = express();

app.use(express.json());

// Middleware execution order (see directives/middleware-architecture.md section 1):
//   1. request-id
//   2. auth
//   3. tenant-context
//   4. authorization
//   5. validation        (route-specific, not global)
//   6. route handlers
//   7. audit-writer      (post-handler, pre-commit)
//   8. error-handler     (Express error middleware, registered last)

app.use(requestId);
app.use(authentication);
app.use(tenantContext);
app.use(authorization);

app.use('/api/v1/health', healthRoutes);

app.use(auditContext);
app.use(errorHandler);

module.exports = app;
