import { describe, it, expect } from 'vitest';
import request from 'supertest';
import express from 'express';
import requestId from '../../../../api/middleware/request-id.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function createApp() {
  const app = express();
  app.use(requestId);
  app.get('/test', (req, res) => {
    res.json({ requestId: req.requestId });
  });
  return app;
}

describe('request-id middleware', () => {
  it('generates a UUID v4 when X-Request-ID header is missing', async () => {
    const res = await request(createApp()).get('/test');

    expect(res.status).toBe(200);
    expect(res.body.requestId).toMatch(UUID_RE);
  });

  it('preserves a valid X-Request-ID header', async () => {
    const id = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
    const res = await request(createApp())
      .get('/test')
      .set('X-Request-ID', id);

    expect(res.body.requestId).toBe(id);
  });

  it('replaces an invalid X-Request-ID with a generated UUID', async () => {
    const res = await request(createApp())
      .get('/test')
      .set('X-Request-ID', 'not-a-uuid');

    expect(res.body.requestId).toMatch(UUID_RE);
    expect(res.body.requestId).not.toBe('not-a-uuid');
  });

  it('sets the X-Request-ID response header', async () => {
    const res = await request(createApp()).get('/test');

    expect(res.headers['x-request-id']).toBeDefined();
    expect(res.headers['x-request-id']).toMatch(UUID_RE);
    expect(res.headers['x-request-id']).toBe(res.body.requestId);
  });

  it('populates req.requestId', async () => {
    const res = await request(createApp()).get('/test');

    expect(res.body.requestId).toBeDefined();
    expect(typeof res.body.requestId).toBe('string');
    expect(res.body.requestId).toMatch(UUID_RE);
  });

  it('never returns an error', async () => {
    const app = createApp();

    const withoutHeader = await request(app).get('/test');
    expect(withoutHeader.status).toBe(200);

    const withValid = await request(app)
      .get('/test')
      .set('X-Request-ID', 'f47ac10b-58cc-4372-a567-0e02b2c3d479');
    expect(withValid.status).toBe(200);

    const withInvalid = await request(app)
      .get('/test')
      .set('X-Request-ID', '');
    expect(withInvalid.status).toBe(200);

    const withGarbage = await request(app)
      .get('/test')
      .set('X-Request-ID', '123');
    expect(withGarbage.status).toBe(200);
  });
});
