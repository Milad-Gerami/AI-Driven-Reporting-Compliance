import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import createAuditRoutes from '../../../../api/routes/audit.js';
import requestId from '../../../../api/middleware/request-id.js';
import errorHandler from '../../../../api/middleware/error-handler.js';

const TENANT_ID = 'c0000000-0000-4000-a000-000000000001';
const MOCK_CLIENT = { query: vi.fn() };

const AUDIT_EVENT_A = {
  id: 'e0000000-0000-4000-a000-000000000001',
  tenant_id: TENANT_ID,
  actor_id: 'u0000000-0000-4000-a000-000000000001',
  actor_type: 'user',
  action: 'agency.created',
  resource_type: 'agencies',
  resource_id: 'a0000000-0000-4000-a000-000000000001',
  metadata: { ip_address: '127.0.0.1', user_agent: 'test' },
  occurred_at: '2026-06-22T12:00:00Z',
};

const AUDIT_EVENT_B = {
  id: 'e0000000-0000-4000-a000-000000000002',
  tenant_id: TENANT_ID,
  actor_id: null,
  actor_type: 'system',
  action: 'ingestion_run.started',
  resource_type: 'ingestion_runs',
  resource_id: 'r0000000-0000-4000-a000-000000000002',
  metadata: { worker_name: 'ingestion-runner', job_id: 'job-1' },
  occurred_at: '2026-06-22T11:00:00Z',
};

function createApp({
  tenantId = TENANT_ID,
  tenantContext = MOCK_CLIENT,
  listAuditEventsFn,
} = {}) {
  const app = express();
  app.use(express.json());
  app.use(requestId);

  app.use((req, _res, next) => {
    req.tenantId = tenantId;
    req.tenantContext = tenantContext;
    req.effectivePermissions = new Set();
    next();
  });

  const auditRoutes = createAuditRoutes({
    listAuditEvents: listAuditEventsFn || vi.fn().mockResolvedValue([AUDIT_EVENT_A, AUDIT_EVENT_B]),
  });
  app.use('/api/v1/audit', auditRoutes);
  app.use(errorHandler);

  return app;
}

// ───── Factory validation ─────

describe('audit routes — factory validation', () => {
  it('returns a router when all deps are valid', () => {
    const router = createAuditRoutes({ listAuditEvents: async () => [] });
    expect(typeof router).toBe('function');
  });

  it('throws when listAuditEvents is missing', () => {
    expect(() => createAuditRoutes({ listAuditEvents: null })).toThrow(
      'listAuditEvents must be a function',
    );
  });

  it('throws when listAuditEvents is not a function', () => {
    expect(() => createAuditRoutes({ listAuditEvents: 'bad' })).toThrow(
      'listAuditEvents must be a function',
    );
  });
});

// ───── GET /api/v1/audit — successful retrieval ─────

describe('GET /api/v1/audit — successful retrieval', () => {
  it('returns 200', async () => {
    const app = createApp();
    const res = await request(app).get('/api/v1/audit');

    expect(res.status).toBe(200);
  });

  it('returns audit events in data field', async () => {
    const app = createApp();
    const res = await request(app).get('/api/v1/audit');

    expect(res.body.data).toEqual([AUDIT_EVENT_A, AUDIT_EVENT_B]);
  });

  it('calls listAuditEvents with client and tenantId', async () => {
    const listAuditEventsFn = vi.fn().mockResolvedValue([]);
    const app = createApp({ listAuditEventsFn });

    await request(app).get('/api/v1/audit');

    expect(listAuditEventsFn).toHaveBeenCalledOnce();
    expect(listAuditEventsFn).toHaveBeenCalledWith(MOCK_CLIENT, TENANT_ID);
  });

  it('responds with content-type application/json', async () => {
    const app = createApp();
    const res = await request(app).get('/api/v1/audit');

    expect(res.headers['content-type']).toMatch(/application\/json/);
  });
});

// ───── GET /api/v1/audit — empty result set ─────

describe('GET /api/v1/audit — empty result set', () => {
  it('returns 200 with empty data array', async () => {
    const listAuditEventsFn = vi.fn().mockResolvedValue([]);
    const app = createApp({ listAuditEventsFn });

    const res = await request(app).get('/api/v1/audit');

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  it('returns an array, not null or undefined', async () => {
    const listAuditEventsFn = vi.fn().mockResolvedValue([]);
    const app = createApp({ listAuditEventsFn });

    const res = await request(app).get('/api/v1/audit');

    expect(Array.isArray(res.body.data)).toBe(true);
  });
});

// ───── GET /api/v1/audit — tenant ID passed correctly ─────

describe('GET /api/v1/audit — tenant isolation', () => {
  it('passes the correct tenantId to listAuditEvents', async () => {
    const customTenantId = 'c9999999-9999-4000-a000-999999999999';
    const listAuditEventsFn = vi.fn().mockResolvedValue([]);
    const app = createApp({ tenantId: customTenantId, listAuditEventsFn });

    await request(app).get('/api/v1/audit');

    expect(listAuditEventsFn).toHaveBeenCalledWith(MOCK_CLIENT, customTenantId);
  });

  it('passes req.tenantContext as first argument', async () => {
    const specificClient = { query: vi.fn(), _marker: 'audit' };
    const listAuditEventsFn = vi.fn().mockResolvedValue([]);
    const app = createApp({ tenantContext: specificClient, listAuditEventsFn });

    await request(app).get('/api/v1/audit');

    expect(listAuditEventsFn.mock.calls[0][0]).toBe(specificClient);
  });
});

// ───── GET /api/v1/audit — response shape ─────

describe('GET /api/v1/audit — response shape', () => {
  it('wraps results in a data property', async () => {
    const app = createApp();
    const res = await request(app).get('/api/v1/audit');

    expect(res.body).toHaveProperty('data');
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it('does not include a top-level status field', async () => {
    const app = createApp();
    const res = await request(app).get('/api/v1/audit');

    expect(res.body).not.toHaveProperty('status');
  });

  it('returns audit events with expected columns', async () => {
    const listAuditEventsFn = vi.fn().mockResolvedValue([AUDIT_EVENT_A]);
    const app = createApp({ listAuditEventsFn });

    const res = await request(app).get('/api/v1/audit');

    const event = res.body.data[0];
    expect(event).toHaveProperty('id');
    expect(event).toHaveProperty('tenant_id');
    expect(event).toHaveProperty('actor_id');
    expect(event).toHaveProperty('actor_type');
    expect(event).toHaveProperty('action');
    expect(event).toHaveProperty('resource_type');
    expect(event).toHaveProperty('resource_id');
    expect(event).toHaveProperty('metadata');
    expect(event).toHaveProperty('occurred_at');
  });
});

// ───── GET /api/v1/audit — execution failure propagation ─────

describe('GET /api/v1/audit — error propagation', () => {
  it('returns 500 when listAuditEvents throws', async () => {
    const listAuditEventsFn = vi.fn().mockRejectedValue(new Error('DB down'));
    const app = createApp({ listAuditEventsFn });

    const res = await request(app).get('/api/v1/audit');

    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL_ERROR');
  });

  it('does not swallow database errors', async () => {
    const dbError = new Error('relation "audit_logs" does not exist');
    dbError.code = '42P01';
    const listAuditEventsFn = vi.fn().mockRejectedValue(dbError);
    const app = createApp({ listAuditEventsFn });

    const res = await request(app).get('/api/v1/audit');

    expect(res.status).toBe(500);
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
