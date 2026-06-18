import { describe, it, expect, vi } from 'vitest';
import { getTenant, updateTenant } from '../../../../execution/logic/tenant.js';

const TENANT_ID = 'c0000000-0000-4000-a000-000000000001';

const TENANT_ROW = {
  id: TENANT_ID,
  name: 'ACME Government',
  slug: 'acme-gov',
  status: 'active',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

function mockClient(rows) {
  return { query: vi.fn().mockResolvedValue({ rows }) };
}

// ───── Successful row return ─────

describe('getTenant — success', () => {
  it('returns the tenant row when found', async () => {
    const client = mockClient([TENANT_ROW]);
    const result = await getTenant(client, TENANT_ID);

    expect(result).toEqual(TENANT_ROW);
  });

  it('returns the first row only', async () => {
    const duplicate = { ...TENANT_ROW, name: 'Duplicate' };
    const client = mockClient([TENANT_ROW, duplicate]);
    const result = await getTenant(client, TENANT_ID);

    expect(result).toEqual(TENANT_ROW);
  });
});

// ───── Not found ─────

describe('getTenant — not found', () => {
  it('returns null when no rows exist', async () => {
    const client = mockClient([]);
    const result = await getTenant(client, TENANT_ID);

    expect(result).toBeNull();
  });

  it('does not throw when no rows exist', async () => {
    const client = mockClient([]);

    await expect(getTenant(client, TENANT_ID)).resolves.toBeNull();
  });
});

// ───── Parameterized query ─────

describe('getTenant — parameterized query', () => {
  it('passes tenantId as a query parameter', async () => {
    const client = mockClient([TENANT_ROW]);
    await getTenant(client, TENANT_ID);

    const [, params] = client.query.mock.calls[0];
    expect(params).toEqual([TENANT_ID]);
  });

  it('uses a parameterized SQL string with $1 placeholder', async () => {
    const client = mockClient([TENANT_ROW]);
    await getTenant(client, TENANT_ID);

    const [sql] = client.query.mock.calls[0];
    expect(sql).toContain('$1');
    expect(sql).not.toContain(TENANT_ID);
  });

  it('queries the tenants table', async () => {
    const client = mockClient([TENANT_ROW]);
    await getTenant(client, TENANT_ID);

    const [sql] = client.query.mock.calls[0];
    expect(sql).toMatch(/FROM\s+tenants\b/i);
  });

  it('selects the expected columns', async () => {
    const client = mockClient([TENANT_ROW]);
    await getTenant(client, TENANT_ID);

    const [sql] = client.query.mock.calls[0];
    for (const col of ['id', 'name', 'slug', 'status', 'created_at', 'updated_at']) {
      expect(sql).toContain(col);
    }
  });

  it('calls client.query exactly once', async () => {
    const client = mockClient([TENANT_ROW]);
    await getTenant(client, TENANT_ID);

    expect(client.query).toHaveBeenCalledOnce();
  });
});

// ───── Error propagation ─────

describe('getTenant — error propagation', () => {
  it('propagates query errors to the caller', async () => {
    const client = { query: vi.fn().mockRejectedValue(new Error('connection refused')) };

    await expect(getTenant(client, TENANT_ID)).rejects.toThrow('connection refused');
  });

  it('does not swallow database errors', async () => {
    const dbError = new Error('relation "tenants" does not exist');
    dbError.code = '42P01';
    const client = { query: vi.fn().mockRejectedValue(dbError) };

    await expect(getTenant(client, TENANT_ID)).rejects.toThrow(dbError);
  });
});

// ═══════════════════════════════════════════════════
//  updateTenant
// ═══════════════════════════════════════════════════

const UPDATED_ROW = {
  ...TENANT_ROW,
  name: 'New Name',
  updated_at: '2026-06-18T12:00:00Z',
};

// ───── Update name only ─────

describe('updateTenant — update name only', () => {
  it('returns the updated row', async () => {
    const client = mockClient([UPDATED_ROW]);
    const result = await updateTenant(client, TENANT_ID, { name: 'New Name' });

    expect(result).toEqual(UPDATED_ROW);
  });

  it('builds a SET clause for name only', async () => {
    const client = mockClient([UPDATED_ROW]);
    await updateTenant(client, TENANT_ID, { name: 'New Name' });

    const [sql] = client.query.mock.calls[0];
    expect(sql).toMatch(/SET\s+name\s*=\s*\$1/i);
    expect(sql).not.toMatch(/slug\s*=\s*\$/i);
  });

  it('passes name as $1 and tenantId as $2', async () => {
    const client = mockClient([UPDATED_ROW]);
    await updateTenant(client, TENANT_ID, { name: 'New Name' });

    const [, params] = client.query.mock.calls[0];
    expect(params).toEqual(['New Name', TENANT_ID]);
  });
});

// ───── Update slug only ─────

describe('updateTenant — update slug only', () => {
  it('returns the updated row', async () => {
    const row = { ...TENANT_ROW, slug: 'new-slug', updated_at: '2026-06-18T12:00:00Z' };
    const client = mockClient([row]);
    const result = await updateTenant(client, TENANT_ID, { slug: 'new-slug' });

    expect(result).toEqual(row);
  });

  it('builds a SET clause for slug only', async () => {
    const client = mockClient([UPDATED_ROW]);
    await updateTenant(client, TENANT_ID, { slug: 'new-slug' });

    const [sql] = client.query.mock.calls[0];
    expect(sql).toMatch(/SET\s+slug\s*=\s*\$1/i);
    expect(sql).not.toMatch(/name\s*=\s*\$/i);
  });

  it('passes slug as $1 and tenantId as $2', async () => {
    const client = mockClient([UPDATED_ROW]);
    await updateTenant(client, TENANT_ID, { slug: 'new-slug' });

    const [, params] = client.query.mock.calls[0];
    expect(params).toEqual(['new-slug', TENANT_ID]);
  });
});

// ───── Update both fields ─────

describe('updateTenant — update both fields', () => {
  it('returns the updated row', async () => {
    const row = { ...TENANT_ROW, name: 'New Name', slug: 'new-slug', updated_at: '2026-06-18T12:00:00Z' };
    const client = mockClient([row]);
    const result = await updateTenant(client, TENANT_ID, { name: 'New Name', slug: 'new-slug' });

    expect(result).toEqual(row);
  });

  it('builds SET clauses for both name and slug', async () => {
    const client = mockClient([UPDATED_ROW]);
    await updateTenant(client, TENANT_ID, { name: 'New Name', slug: 'new-slug' });

    const [sql] = client.query.mock.calls[0];
    expect(sql).toMatch(/name\s*=\s*\$1/i);
    expect(sql).toMatch(/slug\s*=\s*\$2/i);
  });

  it('passes name as $1, slug as $2, and tenantId as $3', async () => {
    const client = mockClient([UPDATED_ROW]);
    await updateTenant(client, TENANT_ID, { name: 'New Name', slug: 'new-slug' });

    const [, params] = client.query.mock.calls[0];
    expect(params).toEqual(['New Name', 'new-slug', TENANT_ID]);
  });
});

// ───── Parameterized query ─────

describe('updateTenant — parameterized query', () => {
  it('does not interpolate values into the SQL string', async () => {
    const client = mockClient([UPDATED_ROW]);
    await updateTenant(client, TENANT_ID, { name: 'Injected Value' });

    const [sql] = client.query.mock.calls[0];
    expect(sql).not.toContain('Injected Value');
    expect(sql).not.toContain(TENANT_ID);
  });

  it('uses UPDATE on the tenants table', async () => {
    const client = mockClient([UPDATED_ROW]);
    await updateTenant(client, TENANT_ID, { name: 'X' });

    const [sql] = client.query.mock.calls[0];
    expect(sql).toMatch(/UPDATE\s+tenants\b/i);
  });

  it('includes updated_at = NOW() in every query', async () => {
    const client = mockClient([UPDATED_ROW]);
    await updateTenant(client, TENANT_ID, { name: 'X' });

    const [sql] = client.query.mock.calls[0];
    expect(sql).toMatch(/updated_at\s*=\s*NOW\(\)/i);
  });

  it('uses RETURNING to fetch the updated row', async () => {
    const client = mockClient([UPDATED_ROW]);
    await updateTenant(client, TENANT_ID, { name: 'X' });

    const [sql] = client.query.mock.calls[0];
    expect(sql).toMatch(/RETURNING\b/i);
    for (const col of ['id', 'name', 'slug', 'status', 'created_at', 'updated_at']) {
      expect(sql).toContain(col);
    }
  });

  it('calls client.query exactly once', async () => {
    const client = mockClient([UPDATED_ROW]);
    await updateTenant(client, TENANT_ID, { name: 'X' });

    expect(client.query).toHaveBeenCalledOnce();
  });

  it('places tenantId as the last parameter in the WHERE clause', async () => {
    const client = mockClient([UPDATED_ROW]);
    await updateTenant(client, TENANT_ID, { name: 'A', slug: 'b-slug' });

    const [sql, params] = client.query.mock.calls[0];
    const whereMatch = sql.match(/WHERE\s+id\s*=\s*\$(\d+)/i);
    expect(whereMatch).not.toBeNull();
    const whereIndex = parseInt(whereMatch[1], 10);
    expect(params[whereIndex - 1]).toBe(TENANT_ID);
  });
});

// ───── Not found ─────

describe('updateTenant — not found', () => {
  it('returns null when no row matches tenantId', async () => {
    const client = mockClient([]);
    const result = await updateTenant(client, TENANT_ID, { name: 'Ghost' });

    expect(result).toBeNull();
  });

  it('does not throw for not-found', async () => {
    const client = mockClient([]);

    await expect(updateTenant(client, TENANT_ID, { slug: 'gone' })).resolves.toBeNull();
  });
});

// ───── Error propagation ─────

describe('updateTenant — error propagation', () => {
  it('propagates query errors to the caller', async () => {
    const client = { query: vi.fn().mockRejectedValue(new Error('deadlock detected')) };

    await expect(updateTenant(client, TENANT_ID, { name: 'X' })).rejects.toThrow('deadlock detected');
  });

  it('does not swallow database errors', async () => {
    const dbError = new Error('unique_violation');
    dbError.code = '23505';
    const client = { query: vi.fn().mockRejectedValue(dbError) };

    await expect(updateTenant(client, TENANT_ID, { slug: 'dup' })).rejects.toThrow(dbError);
  });
});

// ───── getTenant unchanged ─────

describe('getTenant — unchanged after updateTenant implementation', () => {
  it('still returns a tenant row', async () => {
    const client = mockClient([TENANT_ROW]);
    const result = await getTenant(client, TENANT_ID);

    expect(result).toEqual(TENANT_ROW);
  });

  it('still returns null when not found', async () => {
    const client = mockClient([]);
    const result = await getTenant(client, TENANT_ID);

    expect(result).toBeNull();
  });

  it('still uses a SELECT query', async () => {
    const client = mockClient([TENANT_ROW]);
    await getTenant(client, TENANT_ID);

    const [sql] = client.query.mock.calls[0];
    expect(sql).toMatch(/^SELECT\b/i);
  });
});
