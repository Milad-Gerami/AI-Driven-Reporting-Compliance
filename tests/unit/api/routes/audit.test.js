import { describe, it, expect } from 'vitest';
import request from 'supertest';
import express from 'express';
import createAuditRoutes from '../../../../api/routes/audit.js';
import requestId from '../../../../api/middleware/request-id.js';
import errorHandler from '../../../../api/middleware/error-handler.js';

const TENANT_ID = 'c0000000-0000-4000-a000-000000000001';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(requestId);

  app.use((req, _res, next) => {
    req.tenantId = TENANT_ID;
    req.effectivePermissions = new Set();
    next();
  });

  const auditRoutes = createAuditRoutes();
  app.use('/api/v1/audit', auditRoutes);
  app.use(errorHandler);

  return app;
}

// ───── Factory validation ─────

describe('audit routes — factory validation', () => {
  it('returns a router when called with no arguments', () => {
    const router = createAuditRoutes();
    expect(typeof router).toBe('function');
  });
});

// ───── Route registration ─────

describe('audit routes — route registration', () => {
  it('mounts at /api/v1/audit', async () => {
    const app = createApp();
    const res = await request(app).get('/api/v1/audit');

    expect(res.status).not.toBe(404);
  });
});

// ───── GET /api/v1/audit ─────

describe('GET /api/v1/audit', () => {
  it('returns 200', async () => {
    const app = createApp();
    const res = await request(app).get('/api/v1/audit');

    expect(res.status).toBe(200);
  });

  it('returns the placeholder payload', async () => {
    const app = createApp();
    const res = await request(app).get('/api/v1/audit');

    expect(res.body).toEqual({ status: 'not_implemented' });
  });

  it('responds with content-type application/json', async () => {
    const app = createApp();
    const res = await request(app).get('/api/v1/audit');

    expect(res.headers['content-type']).toMatch(/application\/json/);
  });
});

// ───── Unsupported methods ─────

describe('audit routes — unsupported methods', () => {
  it('returns 404 for POST /api/v1/audit', async () => {
    const app = createApp();
    const res = await request(app)
      .post('/api/v1/audit')
      .send({});

    expect([404, 405]).toContain(res.status);
  });

  it('returns 404 for PATCH /api/v1/audit', async () => {
    const app = createApp();
    const res = await request(app)
      .patch('/api/v1/audit')
      .send({});

    expect([404, 405]).toContain(res.status);
  });

  it('returns 404 for DELETE /api/v1/audit', async () => {
    const app = createApp();
    const res = await request(app).delete('/api/v1/audit');

    expect([404, 405]).toContain(res.status);
  });
});
