import { describe, it, expect } from 'vitest';
import request from 'supertest';
import express from 'express';
import auditContext from '../../../../api/middleware/audit-context.js';

function createApp() {
  const app = express();
  app.use(auditContext);
  app.get('/test', (req, res) => {
    res.json({ auditContext: req.auditContext });
  });
  app.post('/test', (req, res) => {
    res.json({ auditContext: req.auditContext });
  });
  app.patch('/test/:id', (req, res) => {
    res.json({ auditContext: req.auditContext });
  });
  app.delete('/test/:id', (req, res) => {
    res.json({ auditContext: req.auditContext });
  });
  return app;
}

// ───── Context creation ─────

describe('audit-context middleware — context creation', () => {
  it('attaches auditContext to the request', async () => {
    const res = await request(createApp()).get('/test');

    expect(res.status).toBe(200);
    expect(res.body.auditContext).toBeDefined();
    expect(typeof res.body.auditContext).toBe('object');
  });

  it('includes exactly four fields', async () => {
    const res = await request(createApp()).get('/test');

    const keys = Object.keys(res.body.auditContext);
    expect(keys).toHaveLength(4);
    expect(keys).toEqual(expect.arrayContaining(['ipAddress', 'userAgent', 'requestMethod', 'requestPath']));
  });
});

// ───── Header extraction ─────

describe('audit-context middleware — header extraction', () => {
  it('captures the User-Agent header', async () => {
    const res = await request(createApp())
      .get('/test')
      .set('User-Agent', 'GovReport/1.0');

    expect(res.body.auditContext.userAgent).toBe('GovReport/1.0');
  });

  it('captures the IP address as a string', async () => {
    const res = await request(createApp()).get('/test');

    expect(typeof res.body.auditContext.ipAddress).toBe('string');
    expect(res.body.auditContext.ipAddress.length).toBeGreaterThan(0);
  });
});

// ───── Missing User-Agent ─────

describe('audit-context middleware — missing User-Agent', () => {
  it('sets userAgent to null when User-Agent header is absent', async () => {
    const res = await request(createApp())
      .get('/test')
      .unset('User-Agent');

    expect(res.body.auditContext.userAgent).toBeNull();
  });

  it('still creates the full context when User-Agent is absent', async () => {
    const res = await request(createApp())
      .get('/test')
      .unset('User-Agent');

    expect(res.body.auditContext.ipAddress).toBeDefined();
    expect(res.body.auditContext.requestMethod).toBe('GET');
    expect(res.body.auditContext.requestPath).toBe('/test');
  });
});

// ───── Request method capture ─────

describe('audit-context middleware — request method', () => {
  it('captures GET method', async () => {
    const res = await request(createApp()).get('/test');

    expect(res.body.auditContext.requestMethod).toBe('GET');
  });

  it('captures POST method', async () => {
    const res = await request(createApp()).post('/test');

    expect(res.body.auditContext.requestMethod).toBe('POST');
  });

  it('captures PATCH method', async () => {
    const res = await request(createApp()).patch('/test/abc');

    expect(res.body.auditContext.requestMethod).toBe('PATCH');
  });

  it('captures DELETE method', async () => {
    const res = await request(createApp()).delete('/test/abc');

    expect(res.body.auditContext.requestMethod).toBe('DELETE');
  });
});

// ───── Request path capture ─────

describe('audit-context middleware — request path', () => {
  it('captures the full request path', async () => {
    const res = await request(createApp()).get('/test');

    expect(res.body.auditContext.requestPath).toBe('/test');
  });

  it('captures path with parameters', async () => {
    const res = await request(createApp()).patch('/test/some-id');

    expect(res.body.auditContext.requestPath).toBe('/test/some-id');
  });

  it('captures path with query string', async () => {
    const res = await request(createApp()).get('/test?page=2&limit=10');

    expect(res.body.auditContext.requestPath).toBe('/test?page=2&limit=10');
  });
});

// ───── next() invocation ─────

describe('audit-context middleware — next() invocation', () => {
  it('calls next and the route handler executes', async () => {
    const res = await request(createApp()).get('/test');

    expect(res.status).toBe(200);
    expect(res.body.auditContext).toBeDefined();
  });

  it('does not modify the response status', async () => {
    const app = express();
    app.use(auditContext);
    app.get('/custom', (req, res) => {
      res.status(201).json({ ok: true });
    });

    const res = await request(app).get('/custom');

    expect(res.status).toBe(201);
  });

  it('does not interfere with downstream middleware', async () => {
    const app = express();
    app.use(auditContext);
    app.use((req, res, next) => {
      req.downstream = true;
      next();
    });
    app.get('/test', (req, res) => {
      res.json({ auditContext: req.auditContext, downstream: req.downstream });
    });

    const res = await request(app).get('/test');

    expect(res.body.auditContext).toBeDefined();
    expect(res.body.downstream).toBe(true);
  });
});

// ───── Deterministic output shape ─────

describe('audit-context middleware — deterministic output shape', () => {
  it('produces the same shape across multiple requests', async () => {
    const app = createApp();

    const res1 = await request(app).get('/test');
    const res2 = await request(app).post('/test');
    const res3 = await request(app).delete('/test/xyz');

    const keys1 = Object.keys(res1.body.auditContext).sort();
    const keys2 = Object.keys(res2.body.auditContext).sort();
    const keys3 = Object.keys(res3.body.auditContext).sort();

    expect(keys1).toEqual(keys2);
    expect(keys2).toEqual(keys3);
  });

  it('ipAddress is always a string', async () => {
    const res = await request(createApp()).get('/test');

    expect(typeof res.body.auditContext.ipAddress).toBe('string');
  });

  it('userAgent is a string or null', async () => {
    const withAgent = await request(createApp())
      .get('/test')
      .set('User-Agent', 'test');
    expect(typeof withAgent.body.auditContext.userAgent).toBe('string');

    const withoutAgent = await request(createApp())
      .get('/test')
      .unset('User-Agent');
    expect(withoutAgent.body.auditContext.userAgent).toBeNull();
  });

  it('requestMethod is always a string', async () => {
    const res = await request(createApp()).get('/test');

    expect(typeof res.body.auditContext.requestMethod).toBe('string');
  });

  it('requestPath is always a string', async () => {
    const res = await request(createApp()).get('/test');

    expect(typeof res.body.auditContext.requestPath).toBe('string');
  });
});
