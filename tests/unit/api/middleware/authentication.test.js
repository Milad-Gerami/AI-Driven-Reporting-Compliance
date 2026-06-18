import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import createAuthenticationMiddleware from '../../../../api/middleware/authentication.js';
import requestId from '../../../../api/middleware/request-id.js';

const VALID_CLAIMS = {
  tenantIdentifier: 'acme-gov',
  userSubject: 'idp|user-001',
  userEmail: 'analyst@acme.gov',
};

const VALID_TENANT = {
  id: 'c0000000-0000-4000-a000-000000000001',
  name: 'ACME Government',
  slug: 'acme-gov',
  status: 'active',
};

const VALID_USER = {
  id: 'u0000000-0000-4000-a000-000000000001',
  email: 'analyst@acme.gov',
  display_name: 'Jane Analyst',
  status: 'active',
};

const VALID_MEMBERSHIPS = [
  {
    id: 'm0000000-0000-4000-a000-000000000001',
    agency_id: 'a0000000-0000-4000-a000-000000000001',
    agency_name: 'Department of Testing',
    role_id: 'r0000000-0000-4000-a000-000000000001',
    role_name: 'analyst',
    permissions: { 'reports.create': true, 'reports.read': true, 'data_sources.read': true },
  },
  {
    id: 'm0000000-0000-4000-a000-000000000002',
    agency_id: null,
    agency_name: null,
    role_id: 'r0000000-0000-4000-a000-000000000002',
    role_name: 'auditor',
    permissions: { 'reports.read': true, 'audit_logs.read': true },
  },
];

function successDeps(overrides = {}) {
  return {
    verifyToken: vi.fn().mockResolvedValue(VALID_CLAIMS),
    resolveTenant: vi.fn().mockResolvedValue(VALID_TENANT),
    resolveUser: vi.fn().mockResolvedValue(VALID_USER),
    loadMemberships: vi.fn().mockResolvedValue(VALID_MEMBERSHIPS),
    ...overrides,
  };
}

function createApp(deps) {
  const app = express();
  app.use(requestId);
  app.use(createAuthenticationMiddleware(deps));
  app.get('/test', (req, res) => {
    res.json({
      tenantId: req.tenantId,
      userId: req.userId,
      memberships: req.memberships,
      effectivePermissions: [...req.effectivePermissions],
      user: req.user,
      tenant: req.tenant,
    });
  });
  return app;
}

function authRequest(app, token) {
  const r = request(app).get('/test');
  if (token !== undefined) r.set('Authorization', token);
  return r;
}

// ───── Category 1: Token extraction ─────

describe('authentication middleware — token extraction', () => {
  it('rejects when Authorization header is missing', async () => {
    const deps = successDeps();
    const res = await authRequest(createApp(deps));

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
    expect(res.body.error.message).toBe('Authentication required.');
    expect(deps.verifyToken).not.toHaveBeenCalled();
  });

  it('rejects when Authorization scheme is not Bearer', async () => {
    const deps = successDeps();
    const res = await authRequest(createApp(deps), 'Basic abc123');

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
    expect(deps.verifyToken).not.toHaveBeenCalled();
  });

  it('rejects when token is empty after Bearer', async () => {
    const deps = successDeps();
    const res = await authRequest(createApp(deps), 'Bearer ');

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
    expect(deps.verifyToken).not.toHaveBeenCalled();
  });

  it('rejects when token is whitespace only', async () => {
    const deps = successDeps();
    const res = await authRequest(createApp(deps), 'Bearer    ');

    expect(res.status).toBe(401);
    expect(deps.verifyToken).not.toHaveBeenCalled();
  });

  it('accepts case-insensitive Bearer scheme', async () => {
    const deps = successDeps();
    const res = await authRequest(createApp(deps), 'bearer valid-token');

    expect(res.status).toBe(200);
    expect(deps.verifyToken).toHaveBeenCalledWith('valid-token');
  });

  it('trims whitespace from token', async () => {
    const deps = successDeps();
    const res = await authRequest(createApp(deps), 'Bearer  my-token  ');

    expect(res.status).toBe(200);
    expect(deps.verifyToken).toHaveBeenCalledWith('my-token');
  });

  it('rejects empty Authorization header', async () => {
    const deps = successDeps();
    const res = await authRequest(createApp(deps), '');

    expect(res.status).toBe(401);
    expect(deps.verifyToken).not.toHaveBeenCalled();
  });
});

// ───── Category 2: Token verification failure ─────

describe('authentication middleware — token verification failure', () => {
  it('rejects when verifyToken throws', async () => {
    const deps = successDeps({
      verifyToken: vi.fn().mockRejectedValue(new Error('signature invalid')),
    });
    const res = await authRequest(createApp(deps), 'Bearer bad-token');

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
    expect(deps.resolveTenant).not.toHaveBeenCalled();
  });

  it('does not leak verification error details in response', async () => {
    const deps = successDeps({
      verifyToken: vi.fn().mockRejectedValue(new Error('token expired at 2025-01-01')),
    });
    const res = await authRequest(createApp(deps), 'Bearer expired-token');

    expect(res.body.error.message).toBe('Authentication required.');
    expect(JSON.stringify(res.body)).not.toContain('expired');
  });
});

// ───── Category 3: Tenant resolution failure ─────

describe('authentication middleware — tenant resolution failure', () => {
  it('rejects when resolveTenant returns null', async () => {
    const deps = successDeps({
      resolveTenant: vi.fn().mockResolvedValue(null),
    });
    const res = await authRequest(createApp(deps), 'Bearer valid-token');

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
    expect(deps.resolveUser).not.toHaveBeenCalled();
  });

  it('rejects when resolveTenant throws', async () => {
    const deps = successDeps({
      resolveTenant: vi.fn().mockRejectedValue(new Error('db connection lost')),
    });
    const res = await authRequest(createApp(deps), 'Bearer valid-token');

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
    expect(deps.resolveUser).not.toHaveBeenCalled();
  });
});

// ───── Category 4: User resolution failure ─────

describe('authentication middleware — user resolution failure', () => {
  it('rejects when resolveUser returns null', async () => {
    const deps = successDeps({
      resolveUser: vi.fn().mockResolvedValue(null),
    });
    const res = await authRequest(createApp(deps), 'Bearer valid-token');

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
    expect(deps.loadMemberships).not.toHaveBeenCalled();
  });

  it('rejects when user status is not active', async () => {
    const deps = successDeps({
      resolveUser: vi.fn().mockResolvedValue({ ...VALID_USER, status: 'disabled' }),
    });
    const res = await authRequest(createApp(deps), 'Bearer valid-token');

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
    expect(deps.loadMemberships).not.toHaveBeenCalled();
  });

  it('rejects when resolveUser throws', async () => {
    const deps = successDeps({
      resolveUser: vi.fn().mockRejectedValue(new Error('db error')),
    });
    const res = await authRequest(createApp(deps), 'Bearer valid-token');

    expect(res.status).toBe(401);
    expect(deps.loadMemberships).not.toHaveBeenCalled();
  });
});

// ───── Category 5: Membership loading failure ─────

describe('authentication middleware — membership loading failure', () => {
  it('rejects when loadMemberships throws', async () => {
    const deps = successDeps({
      loadMemberships: vi.fn().mockRejectedValue(new Error('db error')),
    });
    const res = await authRequest(createApp(deps), 'Bearer valid-token');

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });
});

// ───── Category 6: Successful authentication ─────

describe('authentication middleware — successful authentication', () => {
  it('populates full request context on success', async () => {
    const deps = successDeps();
    const res = await authRequest(createApp(deps), 'Bearer valid-token');

    expect(res.status).toBe(200);
    expect(res.body.tenantId).toBe(VALID_TENANT.id);
    expect(res.body.userId).toBe(VALID_USER.id);
    expect(res.body.memberships).toEqual(VALID_MEMBERSHIPS);
    expect(res.body.effectivePermissions).toEqual(
      expect.arrayContaining(['reports.create', 'reports.read', 'data_sources.read', 'audit_logs.read']),
    );
    expect(res.body.effectivePermissions).toHaveLength(4);
  });

  it('populates req.user and req.tenant profile fields', async () => {
    const deps = successDeps();
    const res = await authRequest(createApp(deps), 'Bearer valid-token');

    expect(res.body.user).toEqual({
      id: VALID_USER.id,
      email: VALID_USER.email,
      display_name: VALID_USER.display_name,
      status: VALID_USER.status,
    });
    expect(res.body.tenant).toEqual({
      id: VALID_TENANT.id,
      name: VALID_TENANT.name,
      slug: VALID_TENANT.slug,
      status: VALID_TENANT.status,
    });
  });

  it('calls dependencies in order with correct arguments', async () => {
    const deps = successDeps();
    await authRequest(createApp(deps), 'Bearer my-token');

    expect(deps.verifyToken).toHaveBeenCalledWith('my-token');
    expect(deps.resolveTenant).toHaveBeenCalledWith(VALID_CLAIMS.tenantIdentifier);
    expect(deps.resolveUser).toHaveBeenCalledWith(
      VALID_TENANT.id,
      VALID_CLAIMS.userSubject,
      VALID_CLAIMS.userEmail,
    );
    expect(deps.loadMemberships).toHaveBeenCalledWith(VALID_TENANT.id, VALID_USER.id);
  });

  it('handles empty memberships array', async () => {
    const deps = successDeps({
      loadMemberships: vi.fn().mockResolvedValue([]),
    });
    const res = await authRequest(createApp(deps), 'Bearer valid-token');

    expect(res.status).toBe(200);
    expect(res.body.memberships).toEqual([]);
    expect(res.body.effectivePermissions).toEqual([]);
  });

  it('includes request_id in 401 responses', async () => {
    const deps = successDeps({
      verifyToken: vi.fn().mockRejectedValue(new Error('bad')),
    });
    const res = await authRequest(createApp(deps), 'Bearer bad');

    expect(res.body.error.request_id).toBeDefined();
    expect(typeof res.body.error.request_id).toBe('string');
  });
});

// ───── Category 7: Permission flattening ─────

describe('authentication middleware — permission flattening', () => {
  const { flattenPermissions } = createAuthenticationMiddleware;

  it('collects true permissions from a single membership', () => {
    const result = flattenPermissions([
      { permissions: { 'a.b': true, 'c.d': true } },
    ]);
    expect(result).toEqual(new Set(['a.b', 'c.d']));
  });

  it('excludes false permissions', () => {
    const result = flattenPermissions([
      { permissions: { 'a.b': true, 'c.d': false } },
    ]);
    expect(result).toEqual(new Set(['a.b']));
  });

  it('deduplicates overlapping permissions across memberships', () => {
    const result = flattenPermissions([
      { permissions: { 'a.b': true } },
      { permissions: { 'a.b': true, 'c.d': true } },
    ]);
    expect(result).toEqual(new Set(['a.b', 'c.d']));
  });

  it('returns empty Set for empty memberships array', () => {
    const result = flattenPermissions([]);
    expect(result).toEqual(new Set());
  });

  it('returns empty Set for membership with empty permissions', () => {
    const result = flattenPermissions([{ permissions: {} }]);
    expect(result).toEqual(new Set());
  });

  it('rejects truthy-but-not-true values (strict boolean)', () => {
    const result = flattenPermissions([
      { permissions: { 'a.b': 1, 'c.d': 'true', 'e.f': true } },
    ]);
    expect(result).toEqual(new Set(['e.f']));
  });

  it('rejects null permission values', () => {
    const result = flattenPermissions([
      { permissions: { 'a.b': null } },
    ]);
    expect(result).toEqual(new Set());
  });

  it('handles membership with missing permissions property', () => {
    const result = flattenPermissions([{ permissions: null }]);
    expect(result).toEqual(new Set());
  });
});

// ───── Category 8: Response format ─────

describe('authentication middleware — response format', () => {
  it('401 response matches the exact contract shape', async () => {
    const deps = successDeps({
      verifyToken: vi.fn().mockRejectedValue(new Error('bad')),
    });
    const res = await authRequest(createApp(deps), 'Bearer bad');

    expect(res.status).toBe(401);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body).toHaveProperty('error');
    expect(res.body.error).toHaveProperty('code', 'UNAUTHENTICATED');
    expect(res.body.error).toHaveProperty('message', 'Authentication required.');
    expect(res.body.error).toHaveProperty('request_id');
    expect(Object.keys(res.body.error)).toEqual(
      expect.arrayContaining(['code', 'message', 'request_id']),
    );
  });

  it('does not include stack traces or internal reasons in 401 body', async () => {
    const deps = successDeps({
      verifyToken: vi.fn().mockRejectedValue(new Error('JWT verification failed: key mismatch')),
    });
    const res = await authRequest(createApp(deps), 'Bearer bad');
    const body = JSON.stringify(res.body);

    expect(body).not.toContain('stack');
    expect(body).not.toContain('JWT');
    expect(body).not.toContain('key mismatch');
    expect(body).not.toContain('verification failed');
  });
});

// ───── Category 9: Factory validation ─────

describe('authentication middleware — factory validation', () => {
  it('returns a function when all dependencies are provided', () => {
    const middleware = createAuthenticationMiddleware(successDeps());
    expect(typeof middleware).toBe('function');
  });

  it('throws when verifyToken is missing', () => {
    const deps = successDeps();
    delete deps.verifyToken;
    expect(() => createAuthenticationMiddleware(deps)).toThrow('verifyToken must be a function');
  });

  it('throws when resolveTenant is missing', () => {
    const deps = successDeps();
    delete deps.resolveTenant;
    expect(() => createAuthenticationMiddleware(deps)).toThrow('resolveTenant must be a function');
  });

  it('throws when resolveUser is missing', () => {
    const deps = successDeps();
    delete deps.resolveUser;
    expect(() => createAuthenticationMiddleware(deps)).toThrow('resolveUser must be a function');
  });

  it('throws when loadMemberships is missing', () => {
    const deps = successDeps();
    delete deps.loadMemberships;
    expect(() => createAuthenticationMiddleware(deps)).toThrow('loadMemberships must be a function');
  });

  it('throws when a dependency is not a function', () => {
    expect(() => createAuthenticationMiddleware({
      verifyToken: 'not a function',
      resolveTenant: vi.fn(),
      resolveUser: vi.fn(),
      loadMemberships: vi.fn(),
    })).toThrow('verifyToken must be a function');
  });

  it('throws when dependencies object is empty', () => {
    expect(() => createAuthenticationMiddleware({})).toThrow('must be a function');
  });
});
