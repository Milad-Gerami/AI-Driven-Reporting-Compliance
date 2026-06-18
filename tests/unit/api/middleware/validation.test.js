import { describe, it, expect } from 'vitest';
import request from 'supertest';
import express from 'express';
import { z } from 'zod';
import createValidationMiddleware from '../../../../api/middleware/validation.js';
import requestId from '../../../../api/middleware/request-id.js';
import errorHandler from '../../../../api/middleware/error-handler.js';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function createApp(schemas, { method = 'get', path = '/test' } = {}) {
  const app = express();
  app.use(express.json());
  app.use(requestId);

  const middleware = createValidationMiddleware(schemas);
  const handler = (req, res) => {
    res.json({
      validated: req.validated,
      originalParams: req.params,
      originalQuery: req.query,
      originalBody: req.body,
    });
  };

  if (method === 'get') {
    app.get(path, middleware, handler);
  } else if (method === 'post') {
    app.post(path, middleware, handler);
  }

  app.use(errorHandler);
  return app;
}

// ───── Factory validation ─────

describe('validation middleware — factory validation', () => {
  it('returns a function when at least one schema is provided', () => {
    const mw = createValidationMiddleware({ params: z.object({ id: z.string() }) });
    expect(typeof mw).toBe('function');
  });

  it('throws when schemas is null', () => {
    expect(() => createValidationMiddleware(null)).toThrow('schemas must be an object');
  });

  it('throws when schemas is undefined', () => {
    expect(() => createValidationMiddleware()).toThrow('schemas must be an object');
  });

  it('throws when no schemas are provided', () => {
    expect(() => createValidationMiddleware({})).toThrow('at least one schema');
  });

  it('throws when a schema lacks safeParse method', () => {
    expect(() => createValidationMiddleware({ params: { not: 'a schema' } })).toThrow(
      'schemas.params must be a Zod schema',
    );
  });

  it('throws when body schema is not a Zod schema', () => {
    expect(() => createValidationMiddleware({ body: 'invalid' })).toThrow(
      'schemas.body must be a Zod schema',
    );
  });
});

// ───── Params validation ─────

describe('validation middleware — params validation', () => {
  it('validates and attaches parsed params', async () => {
    const app = createApp(
      { params: z.object({ id: z.string().uuid() }) },
      { path: '/items/:id' },
    );

    const res = await request(app).get('/items/c0000000-0000-4000-a000-000000000001');

    expect(res.status).toBe(200);
    expect(res.body.validated.params.id).toBe('c0000000-0000-4000-a000-000000000001');
  });

  it('returns 400 for invalid UUID param', async () => {
    const app = createApp(
      { params: z.object({ id: z.string().uuid() }) },
      { path: '/items/:id' },
    );

    const res = await request(app).get('/items/not-a-uuid');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details[0].source).toBe('params');
    expect(res.body.error.details[0].path).toBe('id');
  });

  it('validates multiple params', async () => {
    const app = createApp(
      {
        params: z.object({
          agency_id: z.string().uuid(),
          source_id: z.string().uuid(),
        }),
      },
      { path: '/agencies/:agency_id/sources/:source_id' },
    );

    const res = await request(app).get(
      '/agencies/c0000000-0000-4000-a000-000000000001/sources/c0000000-0000-4000-a000-000000000002',
    );

    expect(res.status).toBe(200);
    expect(res.body.validated.params.agency_id).toBe('c0000000-0000-4000-a000-000000000001');
    expect(res.body.validated.params.source_id).toBe('c0000000-0000-4000-a000-000000000002');
  });
});

// ───── Query validation ─────

describe('validation middleware — query validation', () => {
  it('validates and attaches parsed query params', async () => {
    const app = createApp({
      query: z.object({
        status: z.enum(['active', 'disabled']).optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
      }),
    });

    const res = await request(app).get('/test?status=active&limit=25');

    expect(res.status).toBe(200);
    expect(res.body.validated.query.status).toBe('active');
    expect(res.body.validated.query.limit).toBe(25);
  });

  it('applies defaults for omitted query params', async () => {
    const app = createApp({
      query: z.object({
        limit: z.coerce.number().int().min(1).max(200).default(50),
      }),
    });

    const res = await request(app).get('/test');

    expect(res.status).toBe(200);
    expect(res.body.validated.query.limit).toBe(50);
  });

  it('returns 400 for invalid enum value', async () => {
    const app = createApp({
      query: z.object({
        status: z.enum(['active', 'disabled']),
      }),
    });

    const res = await request(app).get('/test?status=bogus');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details[0].source).toBe('query');
  });

  it('returns 400 when limit exceeds max', async () => {
    const app = createApp({
      query: z.object({
        limit: z.coerce.number().int().max(200),
      }),
    });

    const res = await request(app).get('/test?limit=500');

    expect(res.status).toBe(400);
    expect(res.body.error.details[0].source).toBe('query');
  });
});

// ───── Body validation ─────

describe('validation middleware — body validation', () => {
  it('validates and attaches parsed body', async () => {
    const app = createApp(
      {
        body: z.object({
          name: z.string().min(1).max(255),
          code: z.string().max(50).optional(),
        }),
      },
      { method: 'post' },
    );

    const res = await request(app)
      .post('/test')
      .send({ name: 'Department of Testing', code: 'DOT' });

    expect(res.status).toBe(200);
    expect(res.body.validated.body.name).toBe('Department of Testing');
    expect(res.body.validated.body.code).toBe('DOT');
  });

  it('returns 400 when required field is missing', async () => {
    const app = createApp(
      { body: z.object({ name: z.string() }) },
      { method: 'post' },
    );

    const res = await request(app).post('/test').send({});

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details[0].source).toBe('body');
    expect(res.body.error.details[0].path).toBe('name');
  });

  it('returns 400 when field has wrong type', async () => {
    const app = createApp(
      { body: z.object({ count: z.number() }) },
      { method: 'post' },
    );

    const res = await request(app).post('/test').send({ count: 'not-a-number' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('strips unknown fields when schema uses strict or strip', async () => {
    const app = createApp(
      { body: z.object({ name: z.string() }) },
      { method: 'post' },
    );

    const res = await request(app)
      .post('/test')
      .send({ name: 'valid', __proto__: 'attack', extra: 'field' });

    expect(res.status).toBe(200);
    expect(res.body.validated.body).toEqual({ name: 'valid' });
    expect(res.body.validated.body).not.toHaveProperty('extra');
  });
});

// ───── Combined validation ─────

describe('validation middleware — combined validation', () => {
  it('validates params, query, and body together', async () => {
    const app = createApp(
      {
        params: z.object({ agency_id: z.string().uuid() }),
        query: z.object({ include: z.enum(['details', 'summary']).optional() }),
        body: z.object({ name: z.string().min(1) }),
      },
      { method: 'post', path: '/agencies/:agency_id' },
    );

    const res = await request(app)
      .post('/agencies/c0000000-0000-4000-a000-000000000001?include=details')
      .send({ name: 'Dept of Testing' });

    expect(res.status).toBe(200);
    expect(res.body.validated.params.agency_id).toBe('c0000000-0000-4000-a000-000000000001');
    expect(res.body.validated.query.include).toBe('details');
    expect(res.body.validated.body.name).toBe('Dept of Testing');
  });

  it('collects errors from all sources in a single response', async () => {
    const app = createApp(
      {
        params: z.object({ id: z.string().uuid() }),
        query: z.object({ limit: z.coerce.number().int().min(1) }),
        body: z.object({ name: z.string() }),
      },
      { method: 'post', path: '/items/:id' },
    );

    const res = await request(app)
      .post('/items/bad-uuid?limit=-5')
      .send({ name: 42 });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');

    const sources = res.body.error.details.map((d) => d.source);
    expect(sources).toContain('params');
    expect(sources).toContain('query');
    expect(sources).toContain('body');
  });

  it('returns all field-level errors, not just the first', async () => {
    const app = createApp(
      {
        body: z.object({
          name: z.string(),
          email: z.string().email(),
        }),
      },
      { method: 'post' },
    );

    const res = await request(app).post('/test').send({});

    expect(res.status).toBe(400);
    expect(res.body.error.details.length).toBeGreaterThanOrEqual(2);
  });
});

// ───── Omitted schemas ─────

describe('validation middleware — omitted schemas', () => {
  it('works with only params schema', async () => {
    const app = createApp(
      { params: z.object({ id: z.string().uuid() }) },
      { path: '/items/:id' },
    );

    const res = await request(app).get('/items/c0000000-0000-4000-a000-000000000001');

    expect(res.status).toBe(200);
    expect(res.body.validated.params).toBeDefined();
    expect(res.body.validated.query).toBeUndefined();
    expect(res.body.validated.body).toBeUndefined();
  });

  it('works with only query schema', async () => {
    const app = createApp({
      query: z.object({ page: z.coerce.number().default(1) }),
    });

    const res = await request(app).get('/test');

    expect(res.status).toBe(200);
    expect(res.body.validated.query).toBeDefined();
    expect(res.body.validated.params).toBeUndefined();
    expect(res.body.validated.body).toBeUndefined();
  });

  it('works with only body schema', async () => {
    const app = createApp(
      { body: z.object({ name: z.string() }) },
      { method: 'post' },
    );

    const res = await request(app).post('/test').send({ name: 'test' });

    expect(res.status).toBe(200);
    expect(res.body.validated.body).toBeDefined();
    expect(res.body.validated.params).toBeUndefined();
    expect(res.body.validated.query).toBeUndefined();
  });

  it('works with params and query but no body', async () => {
    const app = createApp(
      {
        params: z.object({ id: z.string() }),
        query: z.object({ verbose: z.coerce.boolean().default(false) }),
      },
      { path: '/items/:id' },
    );

    const res = await request(app).get('/items/abc');

    expect(res.status).toBe(200);
    expect(res.body.validated.params).toBeDefined();
    expect(res.body.validated.query).toBeDefined();
    expect(res.body.validated.body).toBeUndefined();
  });
});

// ───── Validation failure responses ─────

describe('validation middleware — failure response shape', () => {
  it('returns standard error shape with code, message, details, request_id', async () => {
    const app = createApp(
      { params: z.object({ id: z.string().uuid() }) },
      { path: '/items/:id' },
    );

    const res = await request(app).get('/items/invalid');

    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.message).toBe('Request validation failed.');
    expect(Array.isArray(res.body.error.details)).toBe(true);
    expect(res.body.error.request_id).toMatch(UUID_REGEX);
  });

  it('includes source, path, and message in each detail entry', async () => {
    const app = createApp(
      { body: z.object({ email: z.string().email() }) },
      { method: 'post' },
    );

    const res = await request(app).post('/test').send({ email: 'not-an-email' });

    expect(res.status).toBe(400);
    const detail = res.body.error.details[0];
    expect(detail).toHaveProperty('source');
    expect(detail).toHaveProperty('path');
    expect(detail).toHaveProperty('message');
  });

  it('does not expose raw Zod error class or internal structure', async () => {
    const app = createApp(
      { body: z.object({ name: z.string() }) },
      { method: 'post' },
    );

    const res = await request(app).post('/test').send({ name: 123 });

    const body = JSON.stringify(res.body);
    expect(body).not.toContain('ZodError');
    expect(body).not.toContain('invalid_type');
    expect(body).not.toContain('"code":"invalid');
    expect(body).not.toContain('"expected"');
    expect(body).not.toContain('"received"');
  });

  it('uses 400 status code for validation failures', async () => {
    const app = createApp({
      query: z.object({ limit: z.coerce.number().positive() }),
    });

    const res = await request(app).get('/test?limit=-1');

    expect(res.status).toBe(400);
  });
});

// ───── req.validated shape ─────

describe('validation middleware — req.validated shape', () => {
  it('attaches validated as an object on the request', async () => {
    const app = createApp({
      query: z.object({ ok: z.coerce.boolean().default(true) }),
    });

    const res = await request(app).get('/test');

    expect(typeof res.body.validated).toBe('object');
    expect(res.body.validated).not.toBeNull();
  });

  it('only contains keys for schemas that were provided', async () => {
    const app = createApp({
      params: z.object({ id: z.string() }),
    }, { path: '/items/:id' });

    const res = await request(app).get('/items/abc');

    expect(Object.keys(res.body.validated)).toEqual(['params']);
  });

  it('contains typed/coerced values, not raw strings', async () => {
    const app = createApp({
      query: z.object({
        limit: z.coerce.number().default(50),
        verbose: z.coerce.boolean().default(false),
      }),
    });

    const res = await request(app).get('/test?limit=10&verbose=true');

    expect(res.body.validated.query.limit).toBe(10);
    expect(typeof res.body.validated.query.limit).toBe('number');
    expect(res.body.validated.query.verbose).toBe(true);
    expect(typeof res.body.validated.query.verbose).toBe('boolean');
  });

  it('does not set req.validated on failure', async () => {
    let capturedValidated;
    const app = express();
    app.use(express.json());
    app.use(requestId);
    const mw = createValidationMiddleware({ body: z.object({ name: z.string() }) });
    app.post('/test', mw, (req, res) => {
      capturedValidated = req.validated;
      res.json({ ok: true });
    });
    app.use((err, req, res, _next) => {
      capturedValidated = req.validated;
      res.status(400).json({ error: true });
    });

    await request(app).post('/test').send({ name: 123 });

    expect(capturedValidated).toBeUndefined();
  });
});

// ───── Request immutability ─────

describe('validation middleware — request immutability', () => {
  it('preserves original req.params', async () => {
    const app = createApp(
      { params: z.object({ id: z.string().uuid() }) },
      { path: '/items/:id' },
    );

    const uuid = 'c0000000-0000-4000-a000-000000000001';
    const res = await request(app).get(`/items/${uuid}`);

    expect(res.body.originalParams.id).toBe(uuid);
  });

  it('preserves original req.query', async () => {
    const app = createApp({
      query: z.object({ limit: z.coerce.number().default(50) }),
    });

    const res = await request(app).get('/test?limit=25');

    expect(res.body.originalQuery.limit).toBe('25');
  });

  it('preserves original req.body', async () => {
    const app = createApp(
      { body: z.object({ name: z.string(), extra: z.string().optional() }) },
      { method: 'post' },
    );

    const res = await request(app).post('/test').send({ name: 'test', extra: 'data' });

    expect(res.body.originalBody).toEqual({ name: 'test', extra: 'data' });
  });

  it('does not mutate req.params when validated.params differs', async () => {
    const app = createApp(
      {
        params: z.object({ id: z.string().transform((s) => s.toUpperCase()) }),
      },
      { path: '/items/:id' },
    );

    const res = await request(app).get('/items/abc');

    expect(res.body.validated.params.id).toBe('ABC');
    expect(res.body.originalParams.id).toBe('abc');
  });

  it('does not mutate req.query when validated.query has coerced types', async () => {
    const app = createApp({
      query: z.object({ limit: z.coerce.number() }),
    });

    const res = await request(app).get('/test?limit=42');

    expect(res.body.validated.query.limit).toBe(42);
    expect(res.body.originalQuery.limit).toBe('42');
  });
});
