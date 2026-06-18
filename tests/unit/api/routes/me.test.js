import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import createServer from '../../../../api/server.js';
import createAuthenticationMiddleware from '../../../../api/middleware/authentication.js';
import createTenantContextMiddleware from '../../../../api/middleware/tenant-context.js';

const TENANT = {
  id: 'c0000000-0000-4000-a000-000000000001',
  name: 'ACME Government',
  slug: 'acme-gov',
  status: 'active',
};

const USER = {
  id: 'u0000000-0000-4000-a000-000000000001',
  email: 'analyst@acme.gov',
  display_name: 'Jane Analyst',
  status: 'active',
};

const MEMBERSHIPS = [
  {
    id: 'm0000000-0000-4000-a000-000000000001',
    agency_id: 'a0000000-0000-4000-a000-000000000001',
    agency_name: 'Department of Testing',
    role_id: 'r0000000-0000-4000-a000-000000000001',
    role_name: 'analyst',
    permissions: { 'reports.create': true, 'reports.read': true, 'data_sources.read': false },
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

function createApp(overrides = {}) {
  const deps = {
    verifyToken: vi.fn().mockResolvedValue({
      tenantIdentifier: 'acme-gov',
      userSubject: 'idp|user-001',
      userEmail: 'analyst@acme.gov',
    }),
    resolveTenant: vi.fn().mockResolvedValue(TENANT),
    resolveUser: vi.fn().mockResolvedValue(USER),
    loadMemberships: vi.fn().mockResolvedValue(
      overrides.memberships !== undefined ? overrides.memberships : MEMBERSHIPS,
    ),
  };

  return createServer({
    authentication: createAuthenticationMiddleware(deps),
    tenantContext: createTenantContextMiddleware({
      withTenantContext: vi.fn().mockImplementation(async (_tenantId, cb) => {
        await cb({ connection: 'mock' });
      }),
    }),
  });
}

describe('GET /api/v1/me', () => {
  it('returns 401 when unauthenticated', async () => {
    const app = createApp();
    const res = await request(app).get('/api/v1/me');

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('returns 200 with correct response shape when authenticated', async () => {
    const app = createApp();
    const res = await request(app)
      .get('/api/v1/me')
      .set('Authorization', 'Bearer valid-token');

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('id', USER.id);
    expect(res.body).toHaveProperty('email', USER.email);
    expect(res.body).toHaveProperty('display_name', USER.display_name);
    expect(res.body).toHaveProperty('status', USER.status);
    expect(res.body).toHaveProperty('tenant');
    expect(res.body).toHaveProperty('memberships');
    expect(res.body).toHaveProperty('permissions');
  });

  it('returns tenant information correctly', async () => {
    const app = createApp();
    const res = await request(app)
      .get('/api/v1/me')
      .set('Authorization', 'Bearer valid-token');

    expect(res.body.tenant).toEqual({
      id: TENANT.id,
      name: TENANT.name,
      slug: TENANT.slug,
    });
  });

  it('returns permissions as a flattened sorted array', async () => {
    const app = createApp();
    const res = await request(app)
      .get('/api/v1/me')
      .set('Authorization', 'Bearer valid-token');

    expect(Array.isArray(res.body.permissions)).toBe(true);
    expect(res.body.permissions).toEqual([
      'audit_logs.read',
      'reports.create',
      'reports.read',
    ]);
    const sorted = [...res.body.permissions].sort();
    expect(res.body.permissions).toEqual(sorted);
  });

  it('returns empty memberships and permissions for user with no memberships', async () => {
    const app = createApp({ memberships: [] });
    const res = await request(app)
      .get('/api/v1/me')
      .set('Authorization', 'Bearer valid-token');

    expect(res.status).toBe(200);
    expect(res.body.memberships).toEqual([]);
    expect(res.body.permissions).toEqual([]);
  });

  it('does not expose internal permission maps on membership objects', async () => {
    const app = createApp();
    const res = await request(app)
      .get('/api/v1/me')
      .set('Authorization', 'Bearer valid-token');

    for (const membership of res.body.memberships) {
      expect(membership).not.toHaveProperty('permissions');
      expect(Object.keys(membership)).toEqual(
        expect.arrayContaining(['id', 'agency_id', 'agency_name', 'role_id', 'role_name']),
      );
      expect(Object.keys(membership)).toHaveLength(5);
    }
  });

  it('returns correct membership shape with agency-scoped and tenant-wide entries', async () => {
    const app = createApp();
    const res = await request(app)
      .get('/api/v1/me')
      .set('Authorization', 'Bearer valid-token');

    expect(res.body.memberships).toHaveLength(2);

    const agencyScoped = res.body.memberships[0];
    expect(agencyScoped.agency_id).toBe('a0000000-0000-4000-a000-000000000001');
    expect(agencyScoped.agency_name).toBe('Department of Testing');

    const tenantWide = res.body.memberships[1];
    expect(tenantWide.agency_id).toBeNull();
    expect(tenantWide.agency_name).toBeNull();
  });

  it('does not include auth_provider_id or created_at', async () => {
    const app = createApp();
    const res = await request(app)
      .get('/api/v1/me')
      .set('Authorization', 'Bearer valid-token');

    expect(res.body).not.toHaveProperty('auth_provider_id');
    expect(res.body).not.toHaveProperty('created_at');
  });

  it('does not include tenant status', async () => {
    const app = createApp();
    const res = await request(app)
      .get('/api/v1/me')
      .set('Authorization', 'Bearer valid-token');

    expect(res.body.tenant).not.toHaveProperty('status');
  });
});
