import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import createAuthorizationMiddleware from '../../../../api/middleware/authorization.js';
import requestId from '../../../../api/middleware/request-id.js';
import errorHandler from '../../../../api/middleware/error-handler.js';

const TENANT_ID = 'c0000000-0000-4000-a000-000000000001';
const AGENCY_A = 'a0000000-0000-4000-a000-000000000001';
const AGENCY_B = 'a0000000-0000-4000-a000-000000000002';

const AGENCY_A_OBJ = { id: AGENCY_A, name: 'Department of Testing' };

function defaultDeps(overrides = {}) {
  return {
    verifyAgency: vi.fn().mockResolvedValue(AGENCY_A_OBJ),
    ...overrides,
  };
}

function permissionApp(authz, permission, { permissions = new Set() } = {}) {
  const app = express();
  app.use(requestId);
  app.use((req, _res, next) => {
    req.tenantId = TENANT_ID;
    req.effectivePermissions = permissions;
    next();
  });
  app.get('/test', authz.requirePermission(permission), (req, res) => {
    res.json({ ok: true });
  });
  app.use(errorHandler);
  return app;
}

function agencyApp(authz, { memberships = [], verifyResult } = {}) {
  if (verifyResult !== undefined) {
    authz = createAuthorizationMiddleware(defaultDeps({
      verifyAgency: vi.fn().mockResolvedValue(verifyResult),
    }));
  }
  const app = express();
  app.use(requestId);
  app.use((req, _res, next) => {
    req.tenantId = TENANT_ID;
    req.memberships = memberships;
    req.effectivePermissions = new Set();
    next();
  });
  app.get(
    '/agencies/:agency_id/test',
    authz.requireAgency(),
    (req, res) => {
      res.json({ agencyId: req.agencyId });
    },
  );
  app.use(errorHandler);
  return app;
}

// ───── Factory validation ─────

describe('authorization middleware — factory validation', () => {
  it('returns an object with requirePermission and requireAgency', () => {
    const authz = createAuthorizationMiddleware(defaultDeps());
    expect(typeof authz.requirePermission).toBe('function');
    expect(typeof authz.requireAgency).toBe('function');
  });

  it('throws when verifyAgency is missing', () => {
    expect(() => createAuthorizationMiddleware({})).toThrow(
      'verifyAgency must be a function',
    );
  });

  it('throws when verifyAgency is not a function', () => {
    expect(() => createAuthorizationMiddleware({ verifyAgency: 'string' })).toThrow(
      'verifyAgency must be a function',
    );
  });

  it('throws when deps is null', () => {
    expect(() => createAuthorizationMiddleware(null)).toThrow(
      'verifyAgency must be a function',
    );
  });

  it('throws when deps is undefined', () => {
    expect(() => createAuthorizationMiddleware()).toThrow(
      'verifyAgency must be a function',
    );
  });

  it('throws when requirePermission is called with an empty string', () => {
    const authz = createAuthorizationMiddleware(defaultDeps());
    expect(() => authz.requirePermission('')).toThrow('permission must be a non-empty string');
  });

  it('throws when requirePermission is called with a non-string', () => {
    const authz = createAuthorizationMiddleware(defaultDeps());
    expect(() => authz.requirePermission(42)).toThrow('permission must be a non-empty string');
  });

  it('requirePermission returns a function', () => {
    const authz = createAuthorizationMiddleware(defaultDeps());
    expect(typeof authz.requirePermission('reports.read')).toBe('function');
  });

  it('requireAgency returns a function', () => {
    const authz = createAuthorizationMiddleware(defaultDeps());
    expect(typeof authz.requireAgency()).toBe('function');
  });
});

// ───── Authenticated pass-through ─────

describe('authorization middleware — authenticated pass-through', () => {
  it('passes through when user has the required permission', async () => {
    const authz = createAuthorizationMiddleware(defaultDeps());
    const app = permissionApp(authz, 'reports.read', {
      permissions: new Set(['reports.read']),
    });

    const res = await request(app).get('/test');

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('passes through agency check when user has direct membership', async () => {
    const authz = createAuthorizationMiddleware(defaultDeps());
    const app = agencyApp(authz, {
      memberships: [{ agency_id: AGENCY_A, role_name: 'analyst' }],
    });

    const res = await request(app).get(`/agencies/${AGENCY_A}/test`);

    expect(res.status).toBe(200);
  });
});

// ───── Permission success ─────

describe('authorization middleware — permission success', () => {
  it('allows access when effectivePermissions contains the required permission', async () => {
    const authz = createAuthorizationMiddleware(defaultDeps());
    const app = permissionApp(authz, 'data_sources.create', {
      permissions: new Set(['data_sources.create', 'data_sources.read']),
    });

    const res = await request(app).get('/test');

    expect(res.status).toBe(200);
  });

  it('calls next on successful permission check', async () => {
    const authz = createAuthorizationMiddleware(defaultDeps());
    const app = permissionApp(authz, 'reports.read', {
      permissions: new Set(['reports.read']),
    });

    const res = await request(app).get('/test');

    expect(res.body.ok).toBe(true);
  });

  it('works with a single permission in the set', async () => {
    const authz = createAuthorizationMiddleware(defaultDeps());
    const app = permissionApp(authz, 'audit_logs.read', {
      permissions: new Set(['audit_logs.read']),
    });

    const res = await request(app).get('/test');

    expect(res.status).toBe(200);
  });
});

// ───── Permission failure ─────

describe('authorization middleware — permission failure', () => {
  it('returns 403 FORBIDDEN when user lacks the required permission', async () => {
    const authz = createAuthorizationMiddleware(defaultDeps());
    const app = permissionApp(authz, 'reports.approve', {
      permissions: new Set(['reports.read', 'reports.create']),
    });

    const res = await request(app).get('/test');

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(res.body.error.message).toBe('Insufficient permissions.');
    expect(res.body.error).toHaveProperty('request_id');
  });

  it('returns 403 when effectivePermissions is empty', async () => {
    const authz = createAuthorizationMiddleware(defaultDeps());
    const app = permissionApp(authz, 'reports.read', {
      permissions: new Set(),
    });

    const res = await request(app).get('/test');

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('does not call the route handler on permission failure', async () => {
    const handler = vi.fn((_req, res) => res.json({ ok: true }));
    const authz = createAuthorizationMiddleware(defaultDeps());

    const app = express();
    app.use(requestId);
    app.use((req, _res, next) => {
      req.effectivePermissions = new Set();
      next();
    });
    app.get('/test', authz.requirePermission('reports.read'), handler);
    app.use(errorHandler);

    await request(app).get('/test');

    expect(handler).not.toHaveBeenCalled();
  });
});

// ───── Agency membership success ─────

describe('authorization middleware — agency membership success', () => {
  it('allows access when user has a direct membership in the agency', async () => {
    const authz = createAuthorizationMiddleware(defaultDeps());
    const app = agencyApp(authz, {
      memberships: [{ agency_id: AGENCY_A, role_name: 'analyst' }],
    });

    const res = await request(app).get(`/agencies/${AGENCY_A}/test`);

    expect(res.status).toBe(200);
  });

  it('sets req.agencyId on successful agency check', async () => {
    const authz = createAuthorizationMiddleware(defaultDeps());
    const app = agencyApp(authz, {
      memberships: [{ agency_id: AGENCY_A, role_name: 'analyst' }],
    });

    const res = await request(app).get(`/agencies/${AGENCY_A}/test`);

    expect(res.body.agencyId).toBe(AGENCY_A);
  });

  it('calls verifyAgency with tenantId and agencyId', async () => {
    const deps = defaultDeps();
    const authz = createAuthorizationMiddleware(deps);
    const app = agencyApp(authz, {
      memberships: [{ agency_id: AGENCY_A, role_name: 'analyst' }],
    });

    await request(app).get(`/agencies/${AGENCY_A}/test`);

    expect(deps.verifyAgency).toHaveBeenCalledWith(TENANT_ID, AGENCY_A);
  });

  it('allows access with multiple memberships including the target agency', async () => {
    const authz = createAuthorizationMiddleware(defaultDeps());
    const app = agencyApp(authz, {
      memberships: [
        { agency_id: AGENCY_B, role_name: 'auditor' },
        { agency_id: AGENCY_A, role_name: 'analyst' },
      ],
    });

    const res = await request(app).get(`/agencies/${AGENCY_A}/test`);

    expect(res.status).toBe(200);
  });
});

// ───── Agency membership failure ─────

describe('authorization middleware — agency membership failure', () => {
  it('returns 403 FORBIDDEN when user has no membership in the agency', async () => {
    const authz = createAuthorizationMiddleware(defaultDeps());
    const app = agencyApp(authz, {
      memberships: [{ agency_id: AGENCY_B, role_name: 'analyst' }],
    });

    const res = await request(app).get(`/agencies/${AGENCY_A}/test`);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(res.body.error.message).toBe('Insufficient permissions.');
    expect(res.body.error).toHaveProperty('request_id');
  });

  it('returns 403 when user has no memberships at all', async () => {
    const authz = createAuthorizationMiddleware(defaultDeps());
    const app = agencyApp(authz, { memberships: [] });

    const res = await request(app).get(`/agencies/${AGENCY_A}/test`);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('does not set req.agencyId on membership failure', async () => {
    const authz = createAuthorizationMiddleware(defaultDeps());

    const app = express();
    app.use(requestId);
    app.use((req, _res, next) => {
      req.tenantId = TENANT_ID;
      req.memberships = [{ agency_id: AGENCY_B, role_name: 'analyst' }];
      next();
    });
    app.get('/agencies/:agency_id/test', authz.requireAgency(), (_req, res) => {
      res.json({ reached: true });
    });
    app.use(errorHandler);

    const res = await request(app).get(`/agencies/${AGENCY_A}/test`);

    expect(res.status).toBe(403);
  });
});

// ───── Tenant-wide membership behavior ─────

describe('authorization middleware — tenant-wide membership', () => {
  it('grants access to any agency when user has agency_id null membership', async () => {
    const authz = createAuthorizationMiddleware(defaultDeps());
    const app = agencyApp(authz, {
      memberships: [{ agency_id: null, role_name: 'tenant_admin' }],
    });

    const res = await request(app).get(`/agencies/${AGENCY_A}/test`);

    expect(res.status).toBe(200);
    expect(res.body.agencyId).toBe(AGENCY_A);
  });

  it('grants access to a different agency with tenant-wide membership', async () => {
    const deps = defaultDeps({
      verifyAgency: vi.fn().mockResolvedValue({ id: AGENCY_B, name: 'Other Agency' }),
    });
    const authz = createAuthorizationMiddleware(deps);
    const app = agencyApp(authz, {
      memberships: [{ agency_id: null, role_name: 'tenant_admin' }],
    });

    const res = await request(app).get(`/agencies/${AGENCY_B}/test`);

    expect(res.status).toBe(200);
    expect(res.body.agencyId).toBe(AGENCY_B);
  });

  it('grants access when user has both direct and tenant-wide memberships', async () => {
    const authz = createAuthorizationMiddleware(defaultDeps());
    const app = agencyApp(authz, {
      memberships: [
        { agency_id: AGENCY_A, role_name: 'analyst' },
        { agency_id: null, role_name: 'tenant_admin' },
      ],
    });

    const res = await request(app).get(`/agencies/${AGENCY_A}/test`);

    expect(res.status).toBe(200);
  });

  it('still rejects if agency does not exist even with tenant-wide membership', async () => {
    const authz = createAuthorizationMiddleware(defaultDeps({
      verifyAgency: vi.fn().mockResolvedValue(null),
    }));
    const app = agencyApp(authz, {
      memberships: [{ agency_id: null, role_name: 'tenant_admin' }],
    });

    const res = await request(app).get(`/agencies/${AGENCY_A}/test`);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});

// ───── 404-before-403 behavior ─────

describe('authorization middleware — 404-before-403', () => {
  it('returns 404 NOT_FOUND when agency does not exist', async () => {
    const authz = createAuthorizationMiddleware(defaultDeps({
      verifyAgency: vi.fn().mockResolvedValue(null),
    }));
    const app = agencyApp(authz, {
      memberships: [{ agency_id: AGENCY_A, role_name: 'analyst' }],
    });

    const res = await request(app).get(`/agencies/${AGENCY_A}/test`);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(res.body.error.message).toBe('Agency not found.');
    expect(res.body.error).toHaveProperty('request_id');
  });

  it('returns 404 even when user would also lack membership', async () => {
    const authz = createAuthorizationMiddleware(defaultDeps({
      verifyAgency: vi.fn().mockResolvedValue(null),
    }));
    const app = agencyApp(authz, { memberships: [] });

    const res = await request(app).get(`/agencies/${AGENCY_A}/test`);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('does not check memberships when agency does not exist', async () => {
    const authz = createAuthorizationMiddleware(defaultDeps({
      verifyAgency: vi.fn().mockResolvedValue(null),
    }));

    const membershipChecked = vi.fn();
    const app = express();
    app.use(requestId);
    app.use((req, _res, next) => {
      req.tenantId = TENANT_ID;
      req.memberships = new Proxy([], {
        get(target, prop) {
          if (prop === 'some') membershipChecked();
          return Reflect.get(target, prop);
        },
      });
      next();
    });
    app.get('/agencies/:agency_id/test', authz.requireAgency(), (_req, res) => {
      res.json({ ok: true });
    });
    app.use(errorHandler);

    await request(app).get(`/agencies/${AGENCY_A}/test`);

    expect(membershipChecked).not.toHaveBeenCalled();
  });

  it('returns 403 only after confirming agency exists', async () => {
    const deps = defaultDeps();
    const authz = createAuthorizationMiddleware(deps);
    const app = agencyApp(authz, {
      memberships: [{ agency_id: AGENCY_B, role_name: 'analyst' }],
    });

    const res = await request(app).get(`/agencies/${AGENCY_A}/test`);

    expect(deps.verifyAgency).toHaveBeenCalledOnce();
    expect(res.status).toBe(403);
  });
});

// ───── Malformed request context handling ─────

describe('authorization middleware — malformed request context', () => {
  it('returns 403 when req.effectivePermissions is undefined', async () => {
    const authz = createAuthorizationMiddleware(defaultDeps());

    const app = express();
    app.use(requestId);
    app.get('/test', authz.requirePermission('reports.read'), (_req, res) => {
      res.json({ ok: true });
    });
    app.use(errorHandler);

    const res = await request(app).get('/test');

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('returns 403 when req.memberships is undefined for agency check', async () => {
    const authz = createAuthorizationMiddleware(defaultDeps());

    const app = express();
    app.use(requestId);
    app.use((req, _res, next) => {
      req.tenantId = TENANT_ID;
      next();
    });
    app.get('/agencies/:agency_id/test', authz.requireAgency(), (_req, res) => {
      res.json({ ok: true });
    });
    app.use(errorHandler);

    const res = await request(app).get(`/agencies/${AGENCY_A}/test`);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('routes verifyAgency errors to the error handler', async () => {
    const authz = createAuthorizationMiddleware(defaultDeps({
      verifyAgency: vi.fn().mockRejectedValue(new Error('db connection failed')),
    }));
    const app = agencyApp(authz, {
      memberships: [{ agency_id: AGENCY_A, role_name: 'analyst' }],
    });

    const res = await request(app).get(`/agencies/${AGENCY_A}/test`);

    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL_ERROR');
  });

  it('does not leak verifyAgency error details in response', async () => {
    const authz = createAuthorizationMiddleware(defaultDeps({
      verifyAgency: vi.fn().mockRejectedValue(new Error('connection pool exhausted')),
    }));
    const app = agencyApp(authz, {
      memberships: [{ agency_id: AGENCY_A, role_name: 'analyst' }],
    });

    const res = await request(app).get(`/agencies/${AGENCY_A}/test`);

    expect(res.body.error.message).toBe('Internal server error');
    expect(JSON.stringify(res.body)).not.toContain('connection pool');
  });

  it('returns 403 when req.effectivePermissions is not a Set', async () => {
    const authz = createAuthorizationMiddleware(defaultDeps());

    const app = express();
    app.use(requestId);
    app.use((req, _res, next) => {
      req.effectivePermissions = ['reports.read'];
      next();
    });
    app.get('/test', authz.requirePermission('reports.read'), (_req, res) => {
      res.json({ ok: true });
    });
    app.use(errorHandler);

    const res = await request(app).get('/test');

    expect(res.status).toBe(403);
  });
});

// ───── Combined agency + permission ─────

describe('authorization middleware — combined agency and permission checks', () => {
  it('passes when user has both agency membership and required permission', async () => {
    const authz = createAuthorizationMiddleware(defaultDeps());

    const app = express();
    app.use(requestId);
    app.use((req, _res, next) => {
      req.tenantId = TENANT_ID;
      req.memberships = [{ agency_id: AGENCY_A, role_name: 'analyst' }];
      req.effectivePermissions = new Set(['data_sources.read']);
      next();
    });
    app.get(
      '/agencies/:agency_id/data-sources',
      authz.requireAgency(),
      authz.requirePermission('data_sources.read'),
      (req, res) => { res.json({ agencyId: req.agencyId }); },
    );
    app.use(errorHandler);

    const res = await request(app).get(`/agencies/${AGENCY_A}/data-sources`);

    expect(res.status).toBe(200);
    expect(res.body.agencyId).toBe(AGENCY_A);
  });

  it('rejects with 403 when user has agency membership but lacks permission', async () => {
    const authz = createAuthorizationMiddleware(defaultDeps());

    const app = express();
    app.use(requestId);
    app.use((req, _res, next) => {
      req.tenantId = TENANT_ID;
      req.memberships = [{ agency_id: AGENCY_A, role_name: 'analyst' }];
      req.effectivePermissions = new Set(['reports.read']);
      next();
    });
    app.get(
      '/agencies/:agency_id/data-sources',
      authz.requireAgency(),
      authz.requirePermission('data_sources.create'),
      (_req, res) => { res.json({ ok: true }); },
    );
    app.use(errorHandler);

    const res = await request(app).get(`/agencies/${AGENCY_A}/data-sources`);

    expect(res.status).toBe(403);
  });

  it('rejects with 403 when user has permission but lacks agency membership', async () => {
    const authz = createAuthorizationMiddleware(defaultDeps());

    const app = express();
    app.use(requestId);
    app.use((req, _res, next) => {
      req.tenantId = TENANT_ID;
      req.memberships = [{ agency_id: AGENCY_B, role_name: 'analyst' }];
      req.effectivePermissions = new Set(['data_sources.read']);
      next();
    });
    app.get(
      '/agencies/:agency_id/data-sources',
      authz.requireAgency(),
      authz.requirePermission('data_sources.read'),
      (_req, res) => { res.json({ ok: true }); },
    );
    app.use(errorHandler);

    const res = await request(app).get(`/agencies/${AGENCY_A}/data-sources`);

    expect(res.status).toBe(403);
  });
});
