import { describe, it, expect, vi, beforeEach } from 'vitest';
import withTenantContext from '../../../../execution/logic/with-tenant-context.js';

const TENANT_ID = 'c0000000-0000-4000-a000-000000000001';

function createMockClient(overrides = {}) {
  return {
    query: vi.fn().mockResolvedValue({ rows: [] }),
    release: vi.fn(),
    ...overrides,
  };
}

function createMockPool(client) {
  return {
    connect: vi.fn().mockResolvedValue(client),
  };
}

describe('withTenantContext — factory validation', () => {
  it('throws when pool is missing', () => {
    expect(() => withTenantContext()).toThrow('pool must have a connect method');
  });

  it('throws when pool lacks connect method', () => {
    expect(() => withTenantContext({})).toThrow('pool must have a connect method');
  });

  it('returns a function when pool is valid', () => {
    const pool = createMockPool(createMockClient());
    expect(typeof withTenantContext(pool)).toBe('function');
  });
});

describe('withTenantContext — successful callback', () => {
  let client;
  let pool;
  let fn;

  beforeEach(() => {
    client = createMockClient();
    pool = createMockPool(client);
    fn = withTenantContext(pool);
  });

  it('acquires a client from the pool', async () => {
    await fn(TENANT_ID, vi.fn());
    expect(pool.connect).toHaveBeenCalledOnce();
  });

  it('executes BEGIN, SET LOCAL, and COMMIT in order', async () => {
    await fn(TENANT_ID, vi.fn());

    const calls = client.query.mock.calls;
    expect(calls[0][0]).toBe('BEGIN');
    expect(calls[1][0]).toBe('SET LOCAL app.current_tenant_id = $1');
    expect(calls[1][1]).toEqual([TENANT_ID]);
    expect(calls[2][0]).toBe('COMMIT');
  });

  it('passes the client to the callback', async () => {
    const callback = vi.fn();
    await fn(TENANT_ID, callback);

    expect(callback).toHaveBeenCalledWith(client);
  });

  it('calls the callback after SET LOCAL and before COMMIT', async () => {
    const callOrder = [];
    client.query.mockImplementation(async (sql) => {
      callOrder.push(sql);
    });
    const callback = vi.fn().mockImplementation(async () => {
      callOrder.push('callback');
    });

    await fn(TENANT_ID, callback);

    expect(callOrder).toEqual([
      'BEGIN',
      'SET LOCAL app.current_tenant_id = $1',
      'callback',
      'COMMIT',
    ]);
  });

  it('releases the client after COMMIT', async () => {
    await fn(TENANT_ID, vi.fn());

    expect(client.release).toHaveBeenCalledOnce();
  });

  it('uses a parameterized query for SET LOCAL', async () => {
    await fn(TENANT_ID, vi.fn());

    const setLocalCall = client.query.mock.calls[1];
    expect(setLocalCall[0]).toBe('SET LOCAL app.current_tenant_id = $1');
    expect(setLocalCall[1]).toEqual([TENANT_ID]);
  });
});

describe('withTenantContext — callback throws', () => {
  it('rolls back on callback error', async () => {
    const client = createMockClient();
    const pool = createMockPool(client);
    const fn = withTenantContext(pool);
    const error = new Error('callback failed');

    await expect(fn(TENANT_ID, () => { throw error; })).rejects.toThrow('callback failed');

    const queries = client.query.mock.calls.map(c => c[0]);
    expect(queries).toContain('ROLLBACK');
    expect(queries).not.toContain('COMMIT');
  });

  it('releases the client after callback error', async () => {
    const client = createMockClient();
    const pool = createMockPool(client);
    const fn = withTenantContext(pool);

    await expect(fn(TENANT_ID, () => { throw new Error('fail'); })).rejects.toThrow();

    expect(client.release).toHaveBeenCalledOnce();
  });

  it('re-throws the original error from callback', async () => {
    const client = createMockClient();
    const pool = createMockPool(client);
    const fn = withTenantContext(pool);
    const error = new Error('specific error');

    await expect(fn(TENANT_ID, () => { throw error; })).rejects.toBe(error);
  });
});

describe('withTenantContext — SET LOCAL failure', () => {
  it('rolls back when SET LOCAL fails', async () => {
    const client = createMockClient({
      query: vi.fn().mockImplementation(async (sql) => {
        if (sql.startsWith('SET LOCAL')) throw new Error('SET LOCAL failed');
      }),
    });
    const pool = createMockPool(client);
    const fn = withTenantContext(pool);

    await expect(fn(TENANT_ID, vi.fn())).rejects.toThrow('SET LOCAL failed');

    const queries = client.query.mock.calls.map(c => c[0]);
    expect(queries).toContain('ROLLBACK');
    expect(queries).not.toContain('COMMIT');
  });

  it('does not invoke callback when SET LOCAL fails', async () => {
    const callback = vi.fn();
    const client = createMockClient({
      query: vi.fn().mockImplementation(async (sql) => {
        if (sql.startsWith('SET LOCAL')) throw new Error('SET LOCAL failed');
      }),
    });
    const pool = createMockPool(client);
    const fn = withTenantContext(pool);

    await expect(fn(TENANT_ID, callback)).rejects.toThrow();

    expect(callback).not.toHaveBeenCalled();
  });

  it('releases the client when SET LOCAL fails', async () => {
    const client = createMockClient({
      query: vi.fn().mockImplementation(async (sql) => {
        if (sql.startsWith('SET LOCAL')) throw new Error('SET LOCAL failed');
      }),
    });
    const pool = createMockPool(client);
    const fn = withTenantContext(pool);

    await expect(fn(TENANT_ID, vi.fn())).rejects.toThrow();

    expect(client.release).toHaveBeenCalledOnce();
  });
});

describe('withTenantContext — BEGIN failure', () => {
  it('rolls back when BEGIN fails', async () => {
    const client = createMockClient({
      query: vi.fn().mockImplementation(async (sql) => {
        if (sql === 'BEGIN') throw new Error('BEGIN failed');
      }),
    });
    const pool = createMockPool(client);
    const fn = withTenantContext(pool);

    await expect(fn(TENANT_ID, vi.fn())).rejects.toThrow('BEGIN failed');

    const queries = client.query.mock.calls.map(c => c[0]);
    expect(queries).toContain('ROLLBACK');
  });

  it('does not call SET LOCAL when BEGIN fails', async () => {
    const client = createMockClient({
      query: vi.fn().mockImplementation(async (sql) => {
        if (sql === 'BEGIN') throw new Error('BEGIN failed');
      }),
    });
    const pool = createMockPool(client);
    const fn = withTenantContext(pool);

    await expect(fn(TENANT_ID, vi.fn())).rejects.toThrow();

    const queries = client.query.mock.calls.map(c => c[0]);
    expect(queries).not.toContain('SET LOCAL app.current_tenant_id = $1');
  });

  it('releases the client when BEGIN fails', async () => {
    const client = createMockClient({
      query: vi.fn().mockImplementation(async (sql) => {
        if (sql === 'BEGIN') throw new Error('BEGIN failed');
      }),
    });
    const pool = createMockPool(client);
    const fn = withTenantContext(pool);

    await expect(fn(TENANT_ID, vi.fn())).rejects.toThrow();

    expect(client.release).toHaveBeenCalledOnce();
  });
});

describe('withTenantContext — COMMIT failure', () => {
  it('rolls back when COMMIT fails', async () => {
    const client = createMockClient({
      query: vi.fn().mockImplementation(async (sql) => {
        if (sql === 'COMMIT') throw new Error('COMMIT failed');
      }),
    });
    const pool = createMockPool(client);
    const fn = withTenantContext(pool);

    await expect(fn(TENANT_ID, vi.fn())).rejects.toThrow('COMMIT failed');

    const queries = client.query.mock.calls.map(c => c[0]);
    expect(queries).toContain('ROLLBACK');
  });

  it('releases the client when COMMIT fails', async () => {
    const client = createMockClient({
      query: vi.fn().mockImplementation(async (sql) => {
        if (sql === 'COMMIT') throw new Error('COMMIT failed');
      }),
    });
    const pool = createMockPool(client);
    const fn = withTenantContext(pool);

    await expect(fn(TENANT_ID, vi.fn())).rejects.toThrow();

    expect(client.release).toHaveBeenCalledOnce();
  });

  it('invokes the callback before COMMIT fails', async () => {
    const callback = vi.fn();
    const client = createMockClient({
      query: vi.fn().mockImplementation(async (sql) => {
        if (sql === 'COMMIT') throw new Error('COMMIT failed');
      }),
    });
    const pool = createMockPool(client);
    const fn = withTenantContext(pool);

    await expect(fn(TENANT_ID, callback)).rejects.toThrow();

    expect(callback).toHaveBeenCalledOnce();
  });
});

describe('withTenantContext — client release on every path', () => {
  it('releases client on pool.connect success + successful flow', async () => {
    const client = createMockClient();
    const pool = createMockPool(client);
    const fn = withTenantContext(pool);

    await fn(TENANT_ID, vi.fn());
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('releases client when callback throws', async () => {
    const client = createMockClient();
    const pool = createMockPool(client);
    const fn = withTenantContext(pool);

    await expect(fn(TENANT_ID, () => { throw new Error('fail'); })).rejects.toThrow();
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('releases client when BEGIN throws', async () => {
    const client = createMockClient({
      query: vi.fn().mockImplementation(async (sql) => {
        if (sql === 'BEGIN') throw new Error('fail');
      }),
    });
    const pool = createMockPool(client);
    const fn = withTenantContext(pool);

    await expect(fn(TENANT_ID, vi.fn())).rejects.toThrow();
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('releases client when SET LOCAL throws', async () => {
    const client = createMockClient({
      query: vi.fn().mockImplementation(async (sql) => {
        if (sql.startsWith('SET LOCAL')) throw new Error('fail');
      }),
    });
    const pool = createMockPool(client);
    const fn = withTenantContext(pool);

    await expect(fn(TENANT_ID, vi.fn())).rejects.toThrow();
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('releases client when COMMIT throws', async () => {
    const client = createMockClient({
      query: vi.fn().mockImplementation(async (sql) => {
        if (sql === 'COMMIT') throw new Error('fail');
      }),
    });
    const pool = createMockPool(client);
    const fn = withTenantContext(pool);

    await expect(fn(TENANT_ID, vi.fn())).rejects.toThrow();
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('does not release client when pool.connect throws', async () => {
    const pool = { connect: vi.fn().mockRejectedValue(new Error('pool exhausted')) };
    const fn = withTenantContext(pool);

    await expect(fn(TENANT_ID, vi.fn())).rejects.toThrow('pool exhausted');
  });
});
