import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import createTenantContextMiddleware from '../../../../api/middleware/tenant-context.js';
import requestId from '../../../../api/middleware/request-id.js';
import errorHandler from '../../../../api/middleware/error-handler.js';

const TENANT_ID = 'c0000000-0000-4000-a000-000000000001';
const TENANT = { id: TENANT_ID, name: 'ACME Government', slug: 'acme-gov', status: 'active' };
const MOCK_CTX = { connection: 'mock-tenant-scoped-connection' };

function successDeps(overrides = {}) {
  return {
    withTenantContext: vi.fn().mockImplementation(async (_tenantId, callback) => {
      await callback(MOCK_CTX);
    }),
    ...overrides,
  };
}

function createApp(deps, { setTenant = true, tenant = TENANT } = {}) {
  const app = express();
  app.use(requestId);
  if (setTenant) {
    app.use((req, _res, next) => {
      req.tenantId = tenant.id;
      req.tenant = tenant;
      next();
    });
  }
  app.use(createTenantContextMiddleware(deps));
  app.get('/test', (req, res) => {
    res.json({
      tenantId: req.tenantId,
      tenantContext: req.tenantContext,
    });
  });
  app.use(errorHandler);
  return app;
}

// ───── Factory validation ─────

describe('tenant-context middleware — factory validation', () => {
  it('returns a function when withTenantContext is provided', () => {
    const middleware = createTenantContextMiddleware(successDeps());
    expect(typeof middleware).toBe('function');
  });

  it('throws when withTenantContext is missing', () => {
    expect(() => createTenantContextMiddleware({})).toThrow(
      'withTenantContext must be a function',
    );
  });

  it('throws when withTenantContext is not a function', () => {
    expect(() => createTenantContextMiddleware({ withTenantContext: 'string' })).toThrow(
      'withTenantContext must be a function',
    );
  });

  it('throws when deps is null', () => {
    expect(() => createTenantContextMiddleware(null)).toThrow(
      'withTenantContext must be a function',
    );
  });

  it('throws when deps is undefined', () => {
    expect(() => createTenantContextMiddleware()).toThrow(
      'withTenantContext must be a function',
    );
  });
});

// ───── Active tenant success path ─────

describe('tenant-context middleware — active tenant', () => {
  it('returns 200 and populates req.tenantContext for an active tenant', async () => {
    const deps = successDeps();
    const res = await request(createApp(deps)).get('/test');

    expect(res.status).toBe(200);
    expect(res.body.tenantContext).toEqual(MOCK_CTX);
  });

  it('calls withTenantContext with req.tenantId', async () => {
    const deps = successDeps();
    await request(createApp(deps)).get('/test');

    expect(deps.withTenantContext).toHaveBeenCalledWith(TENANT_ID, expect.any(Function));
  });

  it('calls withTenantContext exactly once per request', async () => {
    const deps = successDeps();
    await request(createApp(deps)).get('/test');

    expect(deps.withTenantContext).toHaveBeenCalledOnce();
  });
});

// ───── Suspended tenant rejection ─────

describe('tenant-context middleware — suspended tenant', () => {
  it('returns 401 UNAUTHENTICATED for suspended status', async () => {
    const deps = successDeps();
    const tenant = { ...TENANT, status: 'suspended' };
    const res = await request(createApp(deps, { tenant })).get('/test');

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
    expect(res.body.error.message).toBe('Authentication required.');
    expect(res.body.error).toHaveProperty('request_id');
  });

  it('returns 401 UNAUTHENTICATED for offboarded status', async () => {
    const deps = successDeps();
    const tenant = { ...TENANT, status: 'offboarded' };
    const res = await request(createApp(deps, { tenant })).get('/test');

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('does not call withTenantContext when tenant is not active', async () => {
    const deps = successDeps();
    const tenant = { ...TENANT, status: 'suspended' };
    await request(createApp(deps, { tenant })).get('/test');

    expect(deps.withTenantContext).not.toHaveBeenCalled();
  });

  it('uses the same error shape as the missing-auth rejection', async () => {
    const deps = successDeps();
    const suspendedTenant = { ...TENANT, status: 'suspended' };
    const suspendedRes = await request(createApp(deps, { tenant: suspendedTenant })).get('/test');
    const missingRes = await request(createApp(deps, { setTenant: false })).get('/test');

    expect(suspendedRes.body.error.code).toBe(missingRes.body.error.code);
    expect(suspendedRes.body.error.message).toBe(missingRes.body.error.message);
    expect(suspendedRes.status).toBe(missingRes.status);
  });
});

// ───── Missing tenant context ─────

describe('tenant-context middleware — missing tenant context', () => {
  it('returns 401 when req.tenantId and req.tenant are absent', async () => {
    const deps = successDeps();
    const res = await request(createApp(deps, { setTenant: false })).get('/test');

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
    expect(res.body.error.message).toBe('Authentication required.');
    expect(res.body.error).toHaveProperty('request_id');
  });

  it('returns 401 when req.tenant is absent but req.tenantId is set', async () => {
    const app = express();
    app.use(requestId);
    app.use((req, _res, next) => { req.tenantId = TENANT_ID; next(); });
    app.use(createTenantContextMiddleware(successDeps()));
    app.get('/test', (_req, res) => res.json({ ok: true }));
    app.use(errorHandler);

    const res = await request(app).get('/test');

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('returns 401 when req.tenantId is absent but req.tenant is set', async () => {
    const app = express();
    app.use(requestId);
    app.use((req, _res, next) => { req.tenant = TENANT; next(); });
    app.use(createTenantContextMiddleware(successDeps()));
    app.get('/test', (_req, res) => res.json({ ok: true }));
    app.use(errorHandler);

    const res = await request(app).get('/test');

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('does not call withTenantContext when context is missing', async () => {
    const deps = successDeps();
    await request(createApp(deps, { setTenant: false })).get('/test');

    expect(deps.withTenantContext).not.toHaveBeenCalled();
  });
});

// ───── Callback execution scope ─────

describe('tenant-context middleware — callback execution scope', () => {
  it('executes downstream handlers within the withTenantContext callback', async () => {
    const callOrder = [];
    const app = express();
    app.use(requestId);
    app.use((req, _res, next) => {
      req.tenantId = TENANT_ID;
      req.tenant = TENANT;
      next();
    });

    const deps = {
      withTenantContext: vi.fn().mockImplementation(async (_tenantId, callback) => {
        callOrder.push('scope:open');
        await callback(MOCK_CTX);
        callOrder.push('scope:close');
      }),
    };

    app.use(createTenantContextMiddleware(deps));
    app.get('/test', (_req, res) => {
      callOrder.push('handler');
      res.json({ ok: true });
    });
    app.use(errorHandler);

    const res = await request(app).get('/test');

    expect(res.status).toBe(200);
    expect(callOrder).toEqual(['scope:open', 'handler', 'scope:close']);
  });

  it('passes the context argument from withTenantContext to the callback', async () => {
    const deps = successDeps();
    const res = await request(createApp(deps)).get('/test');

    expect(res.body.tenantContext).toEqual(MOCK_CTX);
  });
});

// ───── Error propagation ─────

describe('tenant-context middleware — error propagation', () => {
  it('routes withTenantContext rejection to error handler as 500', async () => {
    const deps = successDeps({
      withTenantContext: vi.fn().mockRejectedValue(new Error('SET LOCAL failed')),
    });
    const res = await request(createApp(deps)).get('/test');

    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL_ERROR');
  });

  it('does not leak internal error details in response', async () => {
    const deps = successDeps({
      withTenantContext: vi.fn().mockRejectedValue(new Error('connection pool exhausted')),
    });
    const res = await request(createApp(deps)).get('/test');

    expect(res.body.error.message).toBe('Internal server error');
    expect(JSON.stringify(res.body)).not.toContain('connection pool');
  });

  it('routes errors thrown inside the callback to the error handler', async () => {
    const deps = successDeps();
    const app = express();
    app.use(requestId);
    app.use((req, _res, next) => {
      req.tenantId = TENANT_ID;
      req.tenant = TENANT;
      next();
    });
    app.use(createTenantContextMiddleware(deps));
    app.get('/test', () => { throw new Error('handler exploded'); });
    app.use(errorHandler);

    const res = await request(app).get('/test');

    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL_ERROR');
  });
});

// ───── tenantContext attachment ─────

describe('tenant-context middleware — tenantContext attachment', () => {
  it('attaches the callback context to req.tenantContext', async () => {
    const customCtx = { client: 'pg-client-42', schema: 'tenant_schema' };
    const deps = {
      withTenantContext: vi.fn().mockImplementation(async (_id, cb) => {
        await cb(customCtx);
      }),
    };
    const res = await request(createApp(deps)).get('/test');

    expect(res.status).toBe(200);
    expect(res.body.tenantContext).toEqual(customCtx);
  });

  it('does not set req.tenantContext when tenant is not active', async () => {
    const app = express();
    app.use(requestId);
    app.use((req, _res, next) => {
      req.tenantId = TENANT_ID;
      req.tenant = { ...TENANT, status: 'suspended' };
      next();
    });
    app.use(createTenantContextMiddleware(successDeps()));
    app.use((_req, res) => {
      res.json({ reached: true });
    });
    app.use(errorHandler);

    const res = await request(app).get('/test');

    expect(res.status).toBe(401);
  });
});

// ───── tenantId immutability ─────

describe('tenant-context middleware — tenantId immutability', () => {
  it('does not modify req.tenantId', async () => {
    const deps = successDeps();
    const res = await request(createApp(deps)).get('/test');

    expect(res.body.tenantId).toBe(TENANT_ID);
  });

  it('passes the original tenantId to withTenantContext', async () => {
    const deps = successDeps();
    await request(createApp(deps)).get('/test');

    expect(deps.withTenantContext).toHaveBeenCalledWith(TENANT_ID, expect.any(Function));
  });

  it('preserves req.tenantId after withTenantContext completes', async () => {
    const deps = {
      withTenantContext: vi.fn().mockImplementation(async (_id, cb) => {
        await cb(MOCK_CTX);
      }),
    };
    const res = await request(createApp(deps)).get('/test');

    expect(res.status).toBe(200);
    expect(res.body.tenantId).toBe(TENANT_ID);
  });
});
