import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import createServer from '../../../../api/server.js';
import createAuthenticationMiddleware from '../../../../api/middleware/authentication.js';

function createAuthenticatedServer() {
  const deps = {
    verifyToken: vi.fn().mockResolvedValue({
      tenantIdentifier: 'test-tenant',
      userSubject: 'user-001',
      userEmail: 'test@test.gov',
    }),
    resolveTenant: vi.fn().mockResolvedValue({
      id: 't0000000-0000-4000-a000-000000000001',
      name: 'Test Tenant',
      slug: 'test-tenant',
      status: 'active',
    }),
    resolveUser: vi.fn().mockResolvedValue({
      id: 'u0000000-0000-4000-a000-000000000001',
      email: 'test@test.gov',
      display_name: 'Test User',
      status: 'active',
    }),
    loadMemberships: vi.fn().mockResolvedValue([]),
  };

  const app = createServer({
    authentication: createAuthenticationMiddleware(deps),
  });

  return { app, deps };
}

describe('middleware bypass — health endpoints', () => {
  it('/health/live succeeds without Authorization header', async () => {
    const { app } = createAuthenticatedServer();
    const res = await request(app).get('/api/v1/health/live');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  it('/health/ready succeeds without Authorization header', async () => {
    const { app } = createAuthenticatedServer();
    const res = await request(app).get('/api/v1/health/ready');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  it('authentication middleware is not executed for /health/live', async () => {
    const { app, deps } = createAuthenticatedServer();
    await request(app).get('/api/v1/health/live');

    expect(deps.verifyToken).not.toHaveBeenCalled();
    expect(deps.resolveTenant).not.toHaveBeenCalled();
    expect(deps.resolveUser).not.toHaveBeenCalled();
    expect(deps.loadMemberships).not.toHaveBeenCalled();
  });

  it('authentication middleware is not executed for /health/ready', async () => {
    const { app, deps } = createAuthenticatedServer();
    await request(app).get('/api/v1/health/ready');

    expect(deps.verifyToken).not.toHaveBeenCalled();
    expect(deps.resolveTenant).not.toHaveBeenCalled();
    expect(deps.resolveUser).not.toHaveBeenCalled();
    expect(deps.loadMemberships).not.toHaveBeenCalled();
  });

  it('non-health routes still flow through authentication', async () => {
    const { app } = createAuthenticatedServer();
    const res = await request(app).get('/api/v1/agencies');

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('non-health POST routes still flow through authentication', async () => {
    const { app } = createAuthenticatedServer();
    const res = await request(app).post('/api/v1/users');

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });
});
