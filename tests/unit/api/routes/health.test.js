import { describe, it, expect } from 'vitest';
import request from 'supertest';
import app from '../../../../api/server.js';

describe('GET /api/v1/health/live', () => {
  it('returns 200 with status, version, and api fields', async () => {
    const res = await request(app).get('/api/v1/health/live');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: 'ok',
      version: '0.1.0',
      api: 'v1',
    });
  });

  it('returns Content-Type application/json', async () => {
    const res = await request(app).get('/api/v1/health/live');

    expect(res.headers['content-type']).toMatch(/application\/json/);
  });

  it('does not require authentication', async () => {
    const res = await request(app).get('/api/v1/health/live');

    expect(res.status).toBe(200);
  });
});
