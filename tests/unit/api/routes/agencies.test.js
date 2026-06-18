import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import createAgencyRoutes from '../../../../api/routes/agencies.js';
import createAuthorizationMiddleware from '../../../../api/middleware/authorization.js';
import requestId from '../../../../api/middleware/request-id.js';
import errorHandler from '../../../../api/middleware/error-handler.js';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const TENANT_ID = 'c0000000-0000-4000-a000-000000000001';
const AGENCY_ID = 'a0000000-0000-4000-a000-000000000001';
const MOCK_CLIENT = { query: vi.fn() };

const MOCK_AGENCY = {
  id: AGENCY_ID,
  tenant_id: TENANT_ID,
  name: 'Department of Testing',
  slug: 'dept-testing',
  status: 'active',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

const MOCK_AGENCY_B = {
  id: 'a0000000-0000-4000-a000-000000000002',
  tenant_id: TENANT_ID,
  name: 'Department of Transportation',
  slug: 'dept-transportation',
  status: 'active',
  created_at: '2026-02-01T00:00:00Z',
  updated_at: '2026-02-01T00:00:00Z',
};

function passthrough(req, _res, next) {
  req.validated = { body: req.body };
  next();
}

function defaultMocks() {
  return {
    listAgenciesFn: vi.fn().mockResolvedValue([MOCK_AGENCY, MOCK_AGENCY_B]),
    getAgencyFn: vi.fn().mockResolvedValue(MOCK_AGENCY),
    createAgencyFn: vi.fn().mockResolvedValue(MOCK_AGENCY),
    updateAgencyFn: vi.fn().mockResolvedValue(MOCK_AGENCY),
    deleteAgencyFn: vi.fn().mockResolvedValue(true),
  };
}

function createApp({
  permissions = new Set(),
  tenantId = TENANT_ID,
  tenantContext = MOCK_CLIENT,
  validateFn = passthrough,
  listAgenciesFn,
  getAgencyFn,
  createAgencyFn,
  updateAgencyFn,
  deleteAgencyFn,
} = {}) {
  const mocks = defaultMocks();
  const app = express();
  app.use(express.json());
  app.use(requestId);

  app.use((req, _res, next) => {
    req.tenantId = tenantId;
    req.tenantContext = tenantContext;
    req.effectivePermissions = permissions;
    next();
  });

  const { requirePermission } = createAuthorizationMiddleware({ verifyAgency: async () => null });

  const agencyRoutes = createAgencyRoutes({
    authorize: requirePermission,
    validate: validateFn,
    listAgencies: listAgenciesFn || mocks.listAgenciesFn,
    getAgency: getAgencyFn || mocks.getAgencyFn,
    createAgency: createAgencyFn || mocks.createAgencyFn,
    updateAgency: updateAgencyFn || mocks.updateAgencyFn,
    deleteAgency: deleteAgencyFn || mocks.deleteAgencyFn,
  });

  app.use('/api/v1/agencies', agencyRoutes);
  app.use(errorHandler);

  return app;
}

// ───── Factory validation ─────

describe('agency routes — factory validation', () => {
  const validDeps = {
    authorize: () => (_req, _res, next) => next(),
    validate: (_req, _res, next) => next(),
    listAgencies: async () => [],
    getAgency: async () => ({}),
    createAgency: async () => ({}),
    updateAgency: async () => ({}),
    deleteAgency: async () => true,
  };

  it('returns a router when all deps are valid', () => {
    const router = createAgencyRoutes(validDeps);
    expect(typeof router).toBe('function');
  });

  it('throws when authorize is missing', () => {
    expect(() => createAgencyRoutes({ ...validDeps, authorize: null })).toThrow(
      'authorize must be a function',
    );
  });

  it('throws when validate is not a function', () => {
    expect(() => createAgencyRoutes({ ...validDeps, validate: 'bad' })).toThrow(
      'validate must be a function',
    );
  });

  it('throws when listAgencies is missing', () => {
    expect(() => createAgencyRoutes({ ...validDeps, listAgencies: undefined })).toThrow(
      'listAgencies must be a function',
    );
  });

  it('throws when getAgency is not a function', () => {
    expect(() => createAgencyRoutes({ ...validDeps, getAgency: 42 })).toThrow(
      'getAgency must be a function',
    );
  });

  it('throws when createAgency is missing', () => {
    expect(() => createAgencyRoutes({ ...validDeps, createAgency: null })).toThrow(
      'createAgency must be a function',
    );
  });

  it('throws when updateAgency is missing', () => {
    expect(() => createAgencyRoutes({ ...validDeps, updateAgency: null })).toThrow(
      'updateAgency must be a function',
    );
  });

  it('throws when deleteAgency is missing', () => {
    expect(() => createAgencyRoutes({ ...validDeps, deleteAgency: null })).toThrow(
      'deleteAgency must be a function',
    );
  });
});

// ───── GET / ─────

describe('GET /api/v1/agencies', () => {
  it('returns 200', async () => {
    const app = createApp();
    const res = await request(app).get('/api/v1/agencies');

    expect(res.status).toBe(200);
  });

  it('returns an agency array', async () => {
    const app = createApp();
    const res = await request(app).get('/api/v1/agencies');

    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(2);
    expect(res.body[0]).toEqual(MOCK_AGENCY);
  });

  it('calls listAgencies with client and tenantId', async () => {
    const listAgenciesFn = vi.fn().mockResolvedValue([]);
    const app = createApp({ listAgenciesFn });

    await request(app).get('/api/v1/agencies');

    expect(listAgenciesFn).toHaveBeenCalledOnce();
    expect(listAgenciesFn).toHaveBeenCalledWith(MOCK_CLIENT, TENANT_ID);
  });

  it('returns empty array when no agencies exist', async () => {
    const listAgenciesFn = vi.fn().mockResolvedValue([]);
    const app = createApp({ listAgenciesFn });

    const res = await request(app).get('/api/v1/agencies');

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('returns 500 when listAgencies throws', async () => {
    const listAgenciesFn = vi.fn().mockRejectedValue(new Error('DB down'));
    const app = createApp({ listAgenciesFn });

    const res = await request(app).get('/api/v1/agencies');

    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL_ERROR');
  });
});

// ───── GET /:agency_id ─────

describe('GET /api/v1/agencies/:agency_id', () => {
  it('returns 200 when found', async () => {
    const app = createApp();
    const res = await request(app).get(`/api/v1/agencies/${AGENCY_ID}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual(MOCK_AGENCY);
  });

  it('returns 404 when null', async () => {
    const getAgencyFn = vi.fn().mockResolvedValue(null);
    const app = createApp({ getAgencyFn });

    const res = await request(app).get(`/api/v1/agencies/${AGENCY_ID}`);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('calls getAgency with client, tenantId, and agencyId', async () => {
    const getAgencyFn = vi.fn().mockResolvedValue(MOCK_AGENCY);
    const app = createApp({ getAgencyFn });

    await request(app).get(`/api/v1/agencies/${AGENCY_ID}`);

    expect(getAgencyFn).toHaveBeenCalledOnce();
    expect(getAgencyFn).toHaveBeenCalledWith(MOCK_CLIENT, TENANT_ID, AGENCY_ID);
  });

  it('returns 500 when getAgency throws', async () => {
    const getAgencyFn = vi.fn().mockRejectedValue(new Error('DB down'));
    const app = createApp({ getAgencyFn });

    const res = await request(app).get(`/api/v1/agencies/${AGENCY_ID}`);

    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL_ERROR');
  });
});

// ───── POST / ─────

describe('POST /api/v1/agencies', () => {
  it('returns 201 with created agency', async () => {
    const app = createApp({ permissions: new Set(['agencies.create']) });
    const res = await request(app)
      .post('/api/v1/agencies')
      .send({ name: 'Department of Testing', slug: 'dept-testing' });

    expect(res.status).toBe(201);
    expect(res.body).toEqual(MOCK_AGENCY);
  });

  it('calls createAgency with client, tenantId, and validated body', async () => {
    const createAgencyFn = vi.fn().mockResolvedValue(MOCK_AGENCY);
    const app = createApp({ permissions: new Set(['agencies.create']), createAgencyFn });

    await request(app)
      .post('/api/v1/agencies')
      .send({ name: 'New Agency', slug: 'new-agency' });

    expect(createAgencyFn).toHaveBeenCalledOnce();
    expect(createAgencyFn).toHaveBeenCalledWith(
      MOCK_CLIENT,
      TENANT_ID,
      { name: 'New Agency', slug: 'new-agency' },
    );
  });

  it('returns 403 without agencies.create permission', async () => {
    const app = createApp({ permissions: new Set() });
    const res = await request(app)
      .post('/api/v1/agencies')
      .send({ name: 'test', slug: 'test' });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('returns 500 when createAgency throws', async () => {
    const createAgencyFn = vi.fn().mockRejectedValue(new Error('DB down'));
    const app = createApp({ permissions: new Set(['agencies.create']), createAgencyFn });

    const res = await request(app)
      .post('/api/v1/agencies')
      .send({ name: 'test', slug: 'test' });

    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL_ERROR');
  });
});

// ───── PATCH /:agency_id ─────

describe('PATCH /api/v1/agencies/:agency_id', () => {
  it('returns 200 when updated', async () => {
    const updated = { ...MOCK_AGENCY, name: 'Renamed', updated_at: '2026-06-18T00:00:00Z' };
    const updateAgencyFn = vi.fn().mockResolvedValue(updated);
    const app = createApp({ permissions: new Set(['agencies.update']), updateAgencyFn });

    const res = await request(app)
      .patch(`/api/v1/agencies/${AGENCY_ID}`)
      .send({ name: 'Renamed' });

    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Renamed');
  });

  it('returns 404 when null', async () => {
    const updateAgencyFn = vi.fn().mockResolvedValue(null);
    const app = createApp({ permissions: new Set(['agencies.update']), updateAgencyFn });

    const res = await request(app)
      .patch(`/api/v1/agencies/${AGENCY_ID}`)
      .send({ name: 'Ghost' });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('calls updateAgency with client, tenantId, agencyId, and validated body', async () => {
    const updateAgencyFn = vi.fn().mockResolvedValue(MOCK_AGENCY);
    const app = createApp({ permissions: new Set(['agencies.update']), updateAgencyFn });

    await request(app)
      .patch(`/api/v1/agencies/${AGENCY_ID}`)
      .send({ name: 'Updated' });

    expect(updateAgencyFn).toHaveBeenCalledOnce();
    expect(updateAgencyFn).toHaveBeenCalledWith(
      MOCK_CLIENT,
      TENANT_ID,
      AGENCY_ID,
      { name: 'Updated' },
    );
  });

  it('returns 403 without agencies.update permission', async () => {
    const app = createApp({ permissions: new Set() });
    const res = await request(app)
      .patch(`/api/v1/agencies/${AGENCY_ID}`)
      .send({ name: 'test' });

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('returns 500 when updateAgency throws', async () => {
    const updateAgencyFn = vi.fn().mockRejectedValue(new Error('DB down'));
    const app = createApp({ permissions: new Set(['agencies.update']), updateAgencyFn });

    const res = await request(app)
      .patch(`/api/v1/agencies/${AGENCY_ID}`)
      .send({ name: 'test' });

    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL_ERROR');
  });
});

// ───── DELETE /:agency_id ─────

describe('DELETE /api/v1/agencies/:agency_id', () => {
  it('returns 204 when true', async () => {
    const deleteAgencyFn = vi.fn().mockResolvedValue(true);
    const app = createApp({ permissions: new Set(['agencies.delete']), deleteAgencyFn });

    const res = await request(app).delete(`/api/v1/agencies/${AGENCY_ID}`);

    expect(res.status).toBe(204);
  });

  it('returns 404 when false', async () => {
    const deleteAgencyFn = vi.fn().mockResolvedValue(false);
    const app = createApp({ permissions: new Set(['agencies.delete']), deleteAgencyFn });

    const res = await request(app).delete(`/api/v1/agencies/${AGENCY_ID}`);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('calls deleteAgency with client, tenantId, and agencyId', async () => {
    const deleteAgencyFn = vi.fn().mockResolvedValue(true);
    const app = createApp({ permissions: new Set(['agencies.delete']), deleteAgencyFn });

    await request(app).delete(`/api/v1/agencies/${AGENCY_ID}`);

    expect(deleteAgencyFn).toHaveBeenCalledOnce();
    expect(deleteAgencyFn).toHaveBeenCalledWith(MOCK_CLIENT, TENANT_ID, AGENCY_ID);
  });

  it('returns 403 without agencies.delete permission', async () => {
    const app = createApp({ permissions: new Set() });
    const res = await request(app).delete(`/api/v1/agencies/${AGENCY_ID}`);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('returns 500 when deleteAgency throws', async () => {
    const deleteAgencyFn = vi.fn().mockRejectedValue(new Error('FK violation'));
    const app = createApp({ permissions: new Set(['agencies.delete']), deleteAgencyFn });

    const res = await request(app).delete(`/api/v1/agencies/${AGENCY_ID}`);

    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL_ERROR');
  });
});

// ───── Client propagation ─────

describe('agency routes — client propagation', () => {
  it('passes req.tenantContext as first argument to listAgencies', async () => {
    const specificClient = { query: vi.fn(), _marker: 'list' };
    const listAgenciesFn = vi.fn().mockResolvedValue([]);
    const app = createApp({ tenantContext: specificClient, listAgenciesFn });

    await request(app).get('/api/v1/agencies');

    expect(listAgenciesFn.mock.calls[0][0]).toBe(specificClient);
  });

  it('passes req.tenantContext as first argument to getAgency', async () => {
    const specificClient = { query: vi.fn(), _marker: 'get' };
    const getAgencyFn = vi.fn().mockResolvedValue(MOCK_AGENCY);
    const app = createApp({ tenantContext: specificClient, getAgencyFn });

    await request(app).get(`/api/v1/agencies/${AGENCY_ID}`);

    expect(getAgencyFn.mock.calls[0][0]).toBe(specificClient);
  });

  it('passes req.tenantContext as first argument to createAgency', async () => {
    const specificClient = { query: vi.fn(), _marker: 'create' };
    const createAgencyFn = vi.fn().mockResolvedValue(MOCK_AGENCY);
    const app = createApp({
      permissions: new Set(['agencies.create']),
      tenantContext: specificClient,
      createAgencyFn,
    });

    await request(app).post('/api/v1/agencies').send({ name: 'X', slug: 'x' });

    expect(createAgencyFn.mock.calls[0][0]).toBe(specificClient);
  });

  it('passes req.tenantContext as first argument to updateAgency', async () => {
    const specificClient = { query: vi.fn(), _marker: 'update' };
    const updateAgencyFn = vi.fn().mockResolvedValue(MOCK_AGENCY);
    const app = createApp({
      permissions: new Set(['agencies.update']),
      tenantContext: specificClient,
      updateAgencyFn,
    });

    await request(app).patch(`/api/v1/agencies/${AGENCY_ID}`).send({ name: 'X' });

    expect(updateAgencyFn.mock.calls[0][0]).toBe(specificClient);
  });

  it('passes req.tenantContext as first argument to deleteAgency', async () => {
    const specificClient = { query: vi.fn(), _marker: 'delete' };
    const deleteAgencyFn = vi.fn().mockResolvedValue(true);
    const app = createApp({
      permissions: new Set(['agencies.delete']),
      tenantContext: specificClient,
      deleteAgencyFn,
    });

    await request(app).delete(`/api/v1/agencies/${AGENCY_ID}`);

    expect(deleteAgencyFn.mock.calls[0][0]).toBe(specificClient);
  });

  it('passes req.tenantId correctly to all execution functions', async () => {
    const customTenantId = 'c9999999-9999-4000-a000-999999999999';
    const listAgenciesFn = vi.fn().mockResolvedValue([]);
    const getAgencyFn = vi.fn().mockResolvedValue(MOCK_AGENCY);
    const app = createApp({ tenantId: customTenantId, listAgenciesFn, getAgencyFn });

    await request(app).get('/api/v1/agencies');
    expect(listAgenciesFn).toHaveBeenCalledWith(MOCK_CLIENT, customTenantId);

    await request(app).get(`/api/v1/agencies/${AGENCY_ID}`);
    expect(getAgencyFn).toHaveBeenCalledWith(MOCK_CLIENT, customTenantId, AGENCY_ID);
  });
});

// ───── Authorization wiring ─────

describe('agency routes — authorization wiring', () => {
  it('wires authorize with agencies.create for POST', () => {
    const authorizeSpy = vi.fn().mockReturnValue((_req, _res, next) => next());
    createAgencyRoutes({
      authorize: authorizeSpy,
      validate: passthrough,
      listAgencies: async () => [],
      getAgency: async () => ({}),
      createAgency: async () => ({}),
      updateAgency: async () => ({}),
      deleteAgency: async () => true,
    });

    expect(authorizeSpy).toHaveBeenCalledWith('agencies.create');
  });

  it('wires authorize with agencies.update for PATCH', () => {
    const authorizeSpy = vi.fn().mockReturnValue((_req, _res, next) => next());
    createAgencyRoutes({
      authorize: authorizeSpy,
      validate: passthrough,
      listAgencies: async () => [],
      getAgency: async () => ({}),
      createAgency: async () => ({}),
      updateAgency: async () => ({}),
      deleteAgency: async () => true,
    });

    expect(authorizeSpy).toHaveBeenCalledWith('agencies.update');
  });

  it('wires authorize with agencies.delete for DELETE', () => {
    const authorizeSpy = vi.fn().mockReturnValue((_req, _res, next) => next());
    createAgencyRoutes({
      authorize: authorizeSpy,
      validate: passthrough,
      listAgencies: async () => [],
      getAgency: async () => ({}),
      createAgency: async () => ({}),
      updateAgency: async () => ({}),
      deleteAgency: async () => true,
    });

    expect(authorizeSpy).toHaveBeenCalledWith('agencies.delete');
  });

  it('does not require permission for GET /', async () => {
    const app = createApp({ permissions: new Set() });
    const res = await request(app).get('/api/v1/agencies');

    expect(res.status).toBe(200);
  });

  it('does not require permission for GET /:agency_id', async () => {
    const app = createApp({ permissions: new Set() });
    const res = await request(app).get(`/api/v1/agencies/${AGENCY_ID}`);

    expect(res.status).toBe(200);
  });
});

// ───── Validation wiring ─────

describe('agency routes — validation wiring', () => {
  const blockingValidate = (_req, res) => {
    res.status(418).json({ error: { code: 'BLOCKED_BY_VALIDATE' } });
  };

  it('attaches validate middleware to POST', async () => {
    const app = createApp({
      permissions: new Set(['agencies.create']),
      validateFn: blockingValidate,
    });
    const res = await request(app)
      .post('/api/v1/agencies')
      .send({ name: 'test' });

    expect(res.status).toBe(418);
    expect(res.body.error.code).toBe('BLOCKED_BY_VALIDATE');
  });

  it('attaches validate middleware to PATCH', async () => {
    const app = createApp({
      permissions: new Set(['agencies.update']),
      validateFn: blockingValidate,
    });
    const res = await request(app)
      .patch(`/api/v1/agencies/${AGENCY_ID}`)
      .send({ name: 'test' });

    expect(res.status).toBe(418);
    expect(res.body.error.code).toBe('BLOCKED_BY_VALIDATE');
  });

  it('does not attach validate middleware to GET /', async () => {
    const app = createApp({ validateFn: blockingValidate });
    const res = await request(app).get('/api/v1/agencies');

    expect(res.status).toBe(200);
  });

  it('does not attach validate middleware to GET /:agency_id', async () => {
    const app = createApp({ validateFn: blockingValidate });
    const res = await request(app).get(`/api/v1/agencies/${AGENCY_ID}`);

    expect(res.status).toBe(200);
  });

  it('does not attach validate middleware to DELETE', async () => {
    const app = createApp({
      permissions: new Set(['agencies.delete']),
      validateFn: blockingValidate,
    });
    const res = await request(app).delete(`/api/v1/agencies/${AGENCY_ID}`);

    expect(res.status).toBe(204);
  });
});

// ───── Response behavior ─────

describe('agency routes — response behavior', () => {
  it('204 has no response body', async () => {
    const deleteAgencyFn = vi.fn().mockResolvedValue(true);
    const app = createApp({ permissions: new Set(['agencies.delete']), deleteAgencyFn });

    const res = await request(app).delete(`/api/v1/agencies/${AGENCY_ID}`);

    expect(res.status).toBe(204);
    expect(res.text).toBe('');
  });

  it('includes request_id in 404 error responses for GET', async () => {
    const getAgencyFn = vi.fn().mockResolvedValue(null);
    const app = createApp({ getAgencyFn });

    const res = await request(app).get(`/api/v1/agencies/${AGENCY_ID}`);

    expect(res.status).toBe(404);
    expect(res.body.error.request_id).toMatch(UUID_REGEX);
  });

  it('includes request_id in 404 error responses for PATCH', async () => {
    const updateAgencyFn = vi.fn().mockResolvedValue(null);
    const app = createApp({ permissions: new Set(['agencies.update']), updateAgencyFn });

    const res = await request(app)
      .patch(`/api/v1/agencies/${AGENCY_ID}`)
      .send({ name: 'Ghost' });

    expect(res.status).toBe(404);
    expect(res.body.error.request_id).toMatch(UUID_REGEX);
  });

  it('includes request_id in 404 error responses for DELETE', async () => {
    const deleteAgencyFn = vi.fn().mockResolvedValue(false);
    const app = createApp({ permissions: new Set(['agencies.delete']), deleteAgencyFn });

    const res = await request(app).delete(`/api/v1/agencies/${AGENCY_ID}`);

    expect(res.status).toBe(404);
    expect(res.body.error.request_id).toMatch(UUID_REGEX);
  });
});
