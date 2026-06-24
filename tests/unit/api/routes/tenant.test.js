import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import createTenantRoutes from '../../../../api/routes/tenant.js';
import createAuthorizationMiddleware from '../../../../api/middleware/authorization.js';
import requestId from '../../../../api/middleware/request-id.js';
import auditContextMiddleware from '../../../../api/middleware/audit-context.js';
import errorHandler from '../../../../api/middleware/error-handler.js';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const TENANT_ID = 'c0000000-0000-4000-a000-000000000001';
const USER_ID = 'u0000000-0000-4000-a000-000000000001';
const MOCK_CLIENT = { query: vi.fn() };

const MOCK_TENANT = {
  id: TENANT_ID,
  name: 'ACME Government',
  slug: 'acme-gov',
  status: 'active',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

function createApp({
  permissions = new Set(),
  tenantId = TENANT_ID,
  userId = USER_ID,
  tenantContext = MOCK_CLIENT,
  getTenantFn,
  updateTenantFn,
  createAuditEventFn,
} = {}) {
  const app = express();
  app.use(express.json());
  app.use(requestId);
  app.use(auditContextMiddleware);

  app.use((req, _res, next) => {
    req.tenantId = tenantId;
    req.userId = userId;
    req.tenantContext = tenantContext;
    req.effectivePermissions = permissions;
    next();
  });

  const authorize = createAuthorizationMiddleware({ verifyAgency: async () => null });
  const tenantRoutes = createTenantRoutes({
    authorize,
    getTenant: getTenantFn || vi.fn().mockResolvedValue(MOCK_TENANT),
    updateTenant: updateTenantFn || vi.fn().mockResolvedValue(MOCK_TENANT),
    createAuditEvent: createAuditEventFn || vi.fn().mockResolvedValue({ id: 'audit-1' }),
  });

  app.use('/api/v1/tenant', tenantRoutes);
  app.use(errorHandler);

  return app;
}

// ───── Factory validation ─────

describe('tenant routes — factory validation', () => {
  const validDeps = {
    authorize: { requirePermission: () => (_req, _res, next) => next() },
    getTenant: async () => ({}),
    updateTenant: async () => ({}),
    createAuditEvent: async () => ({}),
  };

  it('returns a router when all deps are valid', () => {
    const router = createTenantRoutes(validDeps);
    expect(typeof router).toBe('function');
  });

  it('throws when authorize is missing', () => {
    expect(() => createTenantRoutes({ ...validDeps, authorize: null })).toThrow(
      'authorize.requirePermission must be a function',
    );
  });

  it('throws when authorize.requirePermission is not a function', () => {
    expect(() => createTenantRoutes({ ...validDeps, authorize: { requirePermission: 'nope' } })).toThrow(
      'authorize.requirePermission must be a function',
    );
  });

  it('throws when getTenant is not a function', () => {
    expect(() => createTenantRoutes({ ...validDeps, getTenant: null })).toThrow(
      'getTenant must be a function',
    );
  });

  it('throws when updateTenant is not a function', () => {
    expect(() => createTenantRoutes({ ...validDeps, updateTenant: null })).toThrow(
      'updateTenant must be a function',
    );
  });

  it('throws when createAuditEvent is not a function', () => {
    expect(() => createTenantRoutes({ ...validDeps, createAuditEvent: null })).toThrow(
      'createAuditEvent must be a function',
    );
  });
});

// ───── GET /api/v1/tenant ─────

describe('GET /api/v1/tenant', () => {
  it('returns 200 with tenant data for any authenticated user', async () => {
    const app = createApp();
    const res = await request(app).get('/api/v1/tenant');

    expect(res.status).toBe(200);
    expect(res.body).toEqual(MOCK_TENANT);
  });

  it('does not require tenant.admin permission', async () => {
    const app = createApp({ permissions: new Set() });
    const res = await request(app).get('/api/v1/tenant');

    expect(res.status).toBe(200);
  });

  it('calls getTenant with the client and tenantId', async () => {
    const getTenantFn = vi.fn().mockResolvedValue(MOCK_TENANT);
    const app = createApp({ getTenantFn });

    await request(app).get('/api/v1/tenant');

    expect(getTenantFn).toHaveBeenCalledOnce();
    expect(getTenantFn).toHaveBeenCalledWith(MOCK_CLIENT, TENANT_ID);
  });

  it('returns the full response shape: id, name, slug, status, created_at, updated_at', async () => {
    const app = createApp();
    const res = await request(app).get('/api/v1/tenant');

    expect(res.body).toHaveProperty('id');
    expect(res.body).toHaveProperty('name');
    expect(res.body).toHaveProperty('slug');
    expect(res.body).toHaveProperty('status');
    expect(res.body).toHaveProperty('created_at');
    expect(res.body).toHaveProperty('updated_at');
  });

  it('returns 500 when getTenant throws', async () => {
    const getTenantFn = vi.fn().mockRejectedValue(new Error('DB connection lost'));
    const app = createApp({ getTenantFn });

    const res = await request(app).get('/api/v1/tenant');

    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL_ERROR');
  });

  it('propagates the tenantId from the authenticated context', async () => {
    const customTenantId = 'c9999999-9999-4000-a000-999999999999';
    const getTenantFn = vi.fn().mockResolvedValue({ ...MOCK_TENANT, id: customTenantId });
    const app = createApp({ tenantId: customTenantId, getTenantFn });

    await request(app).get('/api/v1/tenant');

    expect(getTenantFn).toHaveBeenCalledWith(MOCK_CLIENT, customTenantId);
  });

  it('passes the tenantContext client from the request', async () => {
    const specificClient = { query: vi.fn(), _marker: 'specific' };
    const getTenantFn = vi.fn().mockResolvedValue(MOCK_TENANT);
    const app = createApp({ tenantContext: specificClient, getTenantFn });

    await request(app).get('/api/v1/tenant');

    expect(getTenantFn.mock.calls[0][0]).toBe(specificClient);
  });
});

// ───── PATCH /api/v1/tenant — authorization ─────

describe('PATCH /api/v1/tenant — authorization', () => {
  it('returns 403 when user lacks tenant.admin permission', async () => {
    const app = createApp({ permissions: new Set(['reports.read']) });
    const res = await request(app)
      .patch('/api/v1/tenant')
      .send({ name: 'New Name' });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('returns 403 when user has no permissions at all', async () => {
    const app = createApp({ permissions: new Set() });
    const res = await request(app)
      .patch('/api/v1/tenant')
      .send({ name: 'New Name' });

    expect(res.status).toBe(403);
  });

  it('allows access when user has tenant.admin permission', async () => {
    const app = createApp({ permissions: new Set(['tenant.admin']) });
    const res = await request(app)
      .patch('/api/v1/tenant')
      .send({ name: 'New Name' });

    expect(res.status).toBe(200);
  });
});

// ───── PATCH /api/v1/tenant — validation ─────

describe('PATCH /api/v1/tenant — validation', () => {
  function adminApp(overrides = {}) {
    return createApp({ permissions: new Set(['tenant.admin']), ...overrides });
  }

  it('returns 400 for empty body', async () => {
    const app = adminApp();
    const res = await request(app)
      .patch('/api/v1/tenant')
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details[0].message).toMatch(/at least one field/i);
  });

  it('returns 400 when name is empty string', async () => {
    const app = adminApp();
    const res = await request(app)
      .patch('/api/v1/tenant')
      .send({ name: '' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details[0].source).toBe('body');
  });

  it('returns 400 when name exceeds 255 characters', async () => {
    const app = adminApp();
    const res = await request(app)
      .patch('/api/v1/tenant')
      .send({ name: 'a'.repeat(256) });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 when slug starts with a digit', async () => {
    const app = adminApp();
    const res = await request(app)
      .patch('/api/v1/tenant')
      .send({ slug: '1invalid' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 when slug contains uppercase letters', async () => {
    const app = adminApp();
    const res = await request(app)
      .patch('/api/v1/tenant')
      .send({ slug: 'Invalid-Slug' });

    expect(res.status).toBe(400);
  });

  it('returns 400 when slug is too short (less than 3 characters)', async () => {
    const app = adminApp();
    const res = await request(app)
      .patch('/api/v1/tenant')
      .send({ slug: 'ab' });

    expect(res.status).toBe(400);
  });

  it('returns 400 when slug is too long (more than 63 characters)', async () => {
    const app = adminApp();
    const res = await request(app)
      .patch('/api/v1/tenant')
      .send({ slug: 'a' + 'b'.repeat(63) });

    expect(res.status).toBe(400);
  });

  it('returns 400 when name is not a string', async () => {
    const app = adminApp();
    const res = await request(app)
      .patch('/api/v1/tenant')
      .send({ name: 123 });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 400 when slug is not a string', async () => {
    const app = adminApp();
    const res = await request(app)
      .patch('/api/v1/tenant')
      .send({ slug: 42 });

    expect(res.status).toBe(400);
  });

  it('accepts valid slug at minimum length (3 characters)', async () => {
    const app = adminApp();
    const res = await request(app)
      .patch('/api/v1/tenant')
      .send({ slug: 'abc' });

    expect(res.status).toBe(200);
  });

  it('accepts valid slug at maximum length (63 characters)', async () => {
    const app = adminApp();
    const res = await request(app)
      .patch('/api/v1/tenant')
      .send({ slug: 'a' + 'b'.repeat(62) });

    expect(res.status).toBe(200);
  });

  it('accepts slug with hyphens and digits', async () => {
    const app = adminApp();
    const res = await request(app)
      .patch('/api/v1/tenant')
      .send({ slug: 'acme-gov-2026' });

    expect(res.status).toBe(200);
  });

  it('strips unknown fields from body', async () => {
    const updateTenantFn = vi.fn().mockResolvedValue(MOCK_TENANT);
    const app = adminApp({ updateTenantFn });

    await request(app)
      .patch('/api/v1/tenant')
      .send({ name: 'Valid Name', malicious: 'field', __proto__: 'attack' });

    expect(updateTenantFn).toHaveBeenCalledWith(MOCK_CLIENT, TENANT_ID, { name: 'Valid Name' });
  });

  it('includes request_id in validation error responses', async () => {
    const app = adminApp();
    const res = await request(app)
      .patch('/api/v1/tenant')
      .send({});

    expect(res.body.error.request_id).toMatch(UUID_REGEX);
  });
});

// ───── PATCH /api/v1/tenant — success ─────

describe('PATCH /api/v1/tenant — success', () => {
  function adminApp(overrides = {}) {
    return createApp({ permissions: new Set(['tenant.admin']), ...overrides });
  }

  it('returns 200 with updated tenant when updating name only', async () => {
    const updated = { ...MOCK_TENANT, name: 'New Gov Name', updated_at: '2026-06-18T00:00:00Z' };
    const updateTenantFn = vi.fn().mockResolvedValue(updated);
    const app = adminApp({ updateTenantFn });

    const res = await request(app)
      .patch('/api/v1/tenant')
      .send({ name: 'New Gov Name' });

    expect(res.status).toBe(200);
    expect(res.body.name).toBe('New Gov Name');
  });

  it('returns 200 with updated tenant when updating slug only', async () => {
    const updated = { ...MOCK_TENANT, slug: 'new-gov', updated_at: '2026-06-18T00:00:00Z' };
    const updateTenantFn = vi.fn().mockResolvedValue(updated);
    const app = adminApp({ updateTenantFn });

    const res = await request(app)
      .patch('/api/v1/tenant')
      .send({ slug: 'new-gov' });

    expect(res.status).toBe(200);
    expect(res.body.slug).toBe('new-gov');
  });

  it('returns 200 with updated tenant when updating both name and slug', async () => {
    const updated = { ...MOCK_TENANT, name: 'New Name', slug: 'new-slug', updated_at: '2026-06-18T00:00:00Z' };
    const updateTenantFn = vi.fn().mockResolvedValue(updated);
    const app = adminApp({ updateTenantFn });

    const res = await request(app)
      .patch('/api/v1/tenant')
      .send({ name: 'New Name', slug: 'new-slug' });

    expect(res.status).toBe(200);
    expect(res.body.name).toBe('New Name');
    expect(res.body.slug).toBe('new-slug');
  });

  it('calls updateTenant with client, tenantId, and validated body', async () => {
    const updateTenantFn = vi.fn().mockResolvedValue(MOCK_TENANT);
    const app = adminApp({ updateTenantFn });

    await request(app)
      .patch('/api/v1/tenant')
      .send({ name: 'Updated' });

    expect(updateTenantFn).toHaveBeenCalledOnce();
    expect(updateTenantFn).toHaveBeenCalledWith(MOCK_CLIENT, TENANT_ID, { name: 'Updated' });
  });

  it('returns the full response shape from updateTenant', async () => {
    const app = adminApp();
    const res = await request(app)
      .patch('/api/v1/tenant')
      .send({ name: 'Test' });

    expect(res.body).toHaveProperty('id');
    expect(res.body).toHaveProperty('name');
    expect(res.body).toHaveProperty('slug');
    expect(res.body).toHaveProperty('status');
    expect(res.body).toHaveProperty('created_at');
    expect(res.body).toHaveProperty('updated_at');
  });

  it('returns 500 when updateTenant throws', async () => {
    const updateTenantFn = vi.fn().mockRejectedValue(new Error('DB write failed'));
    const app = adminApp({ updateTenantFn });

    const res = await request(app)
      .patch('/api/v1/tenant')
      .send({ name: 'Will Fail' });

    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL_ERROR');
  });

  it('propagates the tenantId from the authenticated context', async () => {
    const customTenantId = 'c9999999-9999-4000-a000-999999999999';
    const updateTenantFn = vi.fn().mockResolvedValue(MOCK_TENANT);
    const app = createApp({
      permissions: new Set(['tenant.admin']),
      tenantId: customTenantId,
      updateTenantFn,
    });

    await request(app)
      .patch('/api/v1/tenant')
      .send({ name: 'Test' });

    expect(updateTenantFn).toHaveBeenCalledWith(MOCK_CLIENT, customTenantId, { name: 'Test' });
  });

  it('accepts name at maximum length (255 characters)', async () => {
    const longName = 'a'.repeat(255);
    const updateTenantFn = vi.fn().mockResolvedValue({ ...MOCK_TENANT, name: longName });
    const app = adminApp({ updateTenantFn });

    const res = await request(app)
      .patch('/api/v1/tenant')
      .send({ name: longName });

    expect(res.status).toBe(200);
    expect(updateTenantFn).toHaveBeenCalledWith(MOCK_CLIENT, TENANT_ID, { name: longName });
  });

  it('passes the tenantContext client from the request', async () => {
    const specificClient = { query: vi.fn(), _marker: 'specific' };
    const updateTenantFn = vi.fn().mockResolvedValue(MOCK_TENANT);
    const app = createApp({
      permissions: new Set(['tenant.admin']),
      tenantContext: specificClient,
      updateTenantFn,
    });

    await request(app)
      .patch('/api/v1/tenant')
      .send({ name: 'Test' });

    expect(updateTenantFn.mock.calls[0][0]).toBe(specificClient);
  });

  it('passes validated body as third argument, not raw body', async () => {
    const updateTenantFn = vi.fn().mockResolvedValue(MOCK_TENANT);
    const app = adminApp({ updateTenantFn });

    await request(app)
      .patch('/api/v1/tenant')
      .send({ name: 'Clean', extra: 'stripped' });

    const updates = updateTenantFn.mock.calls[0][2];
    expect(updates).toEqual({ name: 'Clean' });
    expect(updates).not.toHaveProperty('extra');
  });
});

// ───── Audit event on tenant update ─────

const UPDATED_MOCK_TENANT = {
  ...MOCK_TENANT,
  name: 'Renamed Government',
  slug: 'renamed-gov',
  updated_at: '2026-06-23T00:00:00Z',
};

describe('PATCH /api/v1/tenant — audit event', () => {
  it('calls createAuditEvent after successful update', async () => {
    const createAuditEventFn = vi.fn().mockResolvedValue({ id: 'audit-1' });
    const updateTenantFn = vi.fn().mockResolvedValue(UPDATED_MOCK_TENANT);
    const app = createApp({
      permissions: new Set(['tenant.admin']),
      updateTenantFn,
      createAuditEventFn,
    });

    const res = await request(app)
      .patch('/api/v1/tenant')
      .send({ name: 'Renamed Government' });

    expect(res.status).toBe(200);
    expect(createAuditEventFn).toHaveBeenCalledOnce();
  });

  it('passes tenant.updated as the action', async () => {
    const createAuditEventFn = vi.fn().mockResolvedValue({ id: 'audit-1' });
    const updateTenantFn = vi.fn().mockResolvedValue(UPDATED_MOCK_TENANT);
    const app = createApp({
      permissions: new Set(['tenant.admin']),
      updateTenantFn,
      createAuditEventFn,
    });

    await request(app)
      .patch('/api/v1/tenant')
      .send({ name: 'Renamed Government' });

    const [, event] = createAuditEventFn.mock.calls[0];
    expect(event.action).toBe('tenant.updated');
  });

  it('passes tenants as the resource_type', async () => {
    const createAuditEventFn = vi.fn().mockResolvedValue({ id: 'audit-1' });
    const updateTenantFn = vi.fn().mockResolvedValue(UPDATED_MOCK_TENANT);
    const app = createApp({
      permissions: new Set(['tenant.admin']),
      updateTenantFn,
      createAuditEventFn,
    });

    await request(app)
      .patch('/api/v1/tenant')
      .send({ name: 'Renamed Government' });

    const [, event] = createAuditEventFn.mock.calls[0];
    expect(event.resource_type).toBe('tenants');
  });

  it('passes the updated tenant id as resource_id', async () => {
    const createAuditEventFn = vi.fn().mockResolvedValue({ id: 'audit-1' });
    const updateTenantFn = vi.fn().mockResolvedValue(UPDATED_MOCK_TENANT);
    const app = createApp({
      permissions: new Set(['tenant.admin']),
      updateTenantFn,
      createAuditEventFn,
    });

    await request(app)
      .patch('/api/v1/tenant')
      .send({ name: 'Renamed Government' });

    const [, event] = createAuditEventFn.mock.calls[0];
    expect(event.resource_id).toBe(TENANT_ID);
  });

  it('includes the before snapshot in metadata', async () => {
    const createAuditEventFn = vi.fn().mockResolvedValue({ id: 'audit-1' });
    const updateTenantFn = vi.fn().mockResolvedValue(UPDATED_MOCK_TENANT);
    const app = createApp({
      permissions: new Set(['tenant.admin']),
      updateTenantFn,
      createAuditEventFn,
    });

    await request(app)
      .patch('/api/v1/tenant')
      .send({ name: 'Renamed Government' });

    const [, event] = createAuditEventFn.mock.calls[0];
    expect(event.metadata.before).toEqual(MOCK_TENANT);
  });

  it('includes the after snapshot in metadata', async () => {
    const createAuditEventFn = vi.fn().mockResolvedValue({ id: 'audit-1' });
    const updateTenantFn = vi.fn().mockResolvedValue(UPDATED_MOCK_TENANT);
    const app = createApp({
      permissions: new Set(['tenant.admin']),
      updateTenantFn,
      createAuditEventFn,
    });

    await request(app)
      .patch('/api/v1/tenant')
      .set('User-Agent', 'GovReport/1.0')
      .send({ name: 'Renamed Government' });

    const [, event] = createAuditEventFn.mock.calls[0];
    expect(event.tenant_id).toBe(TENANT_ID);
    expect(event.actor_id).toBe(USER_ID);
    expect(event.actor_type).toBe('user');
    expect(event.metadata.ip_address).toBeDefined();
    expect(event.metadata.user_agent).toBe('GovReport/1.0');
    expect(event.metadata.request_method).toBe('PATCH');
    expect(event.metadata.request_path).toBe('/api/v1/tenant');
    expect(event.metadata.after).toEqual(UPDATED_MOCK_TENANT);
  });

  it('does not call createAuditEvent when updateTenant fails', async () => {
    const updateTenantFn = vi.fn().mockRejectedValue(new Error('DB down'));
    const createAuditEventFn = vi.fn().mockResolvedValue({ id: 'audit-1' });
    const app = createApp({
      permissions: new Set(['tenant.admin']),
      updateTenantFn,
      createAuditEventFn,
    });

    const res = await request(app)
      .patch('/api/v1/tenant')
      .send({ name: 'Will Fail' });

    expect(res.status).toBe(500);
    expect(createAuditEventFn).not.toHaveBeenCalled();
  });

  it('propagates audit event failures as 500 errors', async () => {
    const updateTenantFn = vi.fn().mockResolvedValue(UPDATED_MOCK_TENANT);
    const createAuditEventFn = vi.fn().mockRejectedValue(new Error('audit write failed'));
    const app = createApp({
      permissions: new Set(['tenant.admin']),
      updateTenantFn,
      createAuditEventFn,
    });

    const res = await request(app)
      .patch('/api/v1/tenant')
      .send({ name: 'Renamed Government' });

    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL_ERROR');
  });
});

// ───── Unsupported methods ─────

describe('tenant routes — unsupported methods', () => {
  it('returns 404 for POST /api/v1/tenant', async () => {
    const app = createApp({ permissions: new Set(['tenant.admin']) });
    const res = await request(app)
      .post('/api/v1/tenant')
      .send({ name: 'test' });

    expect([404, 405]).toContain(res.status);
  });

  it('returns 404 for DELETE /api/v1/tenant', async () => {
    const app = createApp({ permissions: new Set(['tenant.admin']) });
    const res = await request(app).delete('/api/v1/tenant');

    expect([404, 405]).toContain(res.status);
  });
});
