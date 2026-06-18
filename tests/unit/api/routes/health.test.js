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

describe('GET /api/v1/health/ready', () => {
  it('returns 200 status code', async () => {
    const res = await request(app).get('/api/v1/health/ready');

    expect(res.status).toBe(200);
  });

  it('returns the full expected response body', async () => {
    const res = await request(app).get('/api/v1/health/ready');

    expect(res.body).toEqual({
      status: 'ok',
      version: '0.1.0',
      api: 'v1',
      checks: {
        database: 'ok',
        secrets_manager: 'ok',
      },
    });
  });

  it('includes a checks object with database and secrets_manager', async () => {
    const res = await request(app).get('/api/v1/health/ready');

    expect(res.body).toHaveProperty('checks');
    expect(res.body.checks).toHaveProperty('database');
    expect(res.body.checks).toHaveProperty('secrets_manager');
  });

  it('does not require authentication', async () => {
    const res = await request(app).get('/api/v1/health/ready');

    expect(res.status).toBe(200);
  });

  it('returns Content-Type application/json', async () => {
    const res = await request(app).get('/api/v1/health/ready');

    expect(res.headers['content-type']).toMatch(/application\/json/);
  });
});
