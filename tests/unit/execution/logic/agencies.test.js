import { describe, it, expect, vi } from 'vitest';
import { getAgency, listAgencies, createAgency, updateAgency, deleteAgency } from '../../../../execution/logic/agencies.js';

const TENANT_ID = 'c0000000-0000-4000-a000-000000000001';

const AGENCY_A = {
  id: 'a0000000-0000-4000-a000-000000000001',
  tenant_id: TENANT_ID,
  name: 'Department of Agriculture',
  slug: 'dept-agriculture',
  status: 'active',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

const AGENCY_B = {
  id: 'a0000000-0000-4000-a000-000000000002',
  tenant_id: TENANT_ID,
  name: 'Department of Transportation',
  slug: 'dept-transportation',
  status: 'active',
  created_at: '2026-02-01T00:00:00Z',
  updated_at: '2026-02-01T00:00:00Z',
};

function mockClient(rows) {
  return { query: vi.fn().mockResolvedValue({ rows }) };
}

// ═══════════════════════════════════════════════════
//  getAgency
// ═══════════════════════════════════════════════════

const AGENCY_ID = AGENCY_A.id;

// ───── Success path ─────

describe('getAgency — success', () => {
  it('returns the agency row when found', async () => {
    const client = mockClient([AGENCY_A]);
    const result = await getAgency(client, TENANT_ID, AGENCY_ID);

    expect(result).toEqual(AGENCY_A);
  });

  it('returns the first row only', async () => {
    const client = mockClient([AGENCY_A, AGENCY_B]);
    const result = await getAgency(client, TENANT_ID, AGENCY_ID);

    expect(result).toEqual(AGENCY_A);
  });

  it('returns a row with the expected columns', async () => {
    const client = mockClient([AGENCY_A]);
    const result = await getAgency(client, TENANT_ID, AGENCY_ID);

    expect(result).toHaveProperty('id');
    expect(result).toHaveProperty('tenant_id');
    expect(result).toHaveProperty('name');
    expect(result).toHaveProperty('slug');
    expect(result).toHaveProperty('status');
    expect(result).toHaveProperty('created_at');
    expect(result).toHaveProperty('updated_at');
  });
});

// ───── Not found ─────

describe('getAgency — not found', () => {
  it('returns null when no rows exist', async () => {
    const client = mockClient([]);
    const result = await getAgency(client, TENANT_ID, AGENCY_ID);

    expect(result).toBeNull();
  });

  it('does not throw when no rows exist', async () => {
    const client = mockClient([]);

    await expect(getAgency(client, TENANT_ID, AGENCY_ID)).resolves.toBeNull();
  });
});

// ───── Parameterized query verification ─────

describe('getAgency — parameterized query', () => {
  it('passes tenantId as $1 and agencyId as $2', async () => {
    const client = mockClient([AGENCY_A]);
    await getAgency(client, TENANT_ID, AGENCY_ID);

    const [, params] = client.query.mock.calls[0];
    expect(params).toEqual([TENANT_ID, AGENCY_ID]);
  });

  it('uses $1 and $2 placeholders, not literal values', async () => {
    const client = mockClient([AGENCY_A]);
    await getAgency(client, TENANT_ID, AGENCY_ID);

    const [sql] = client.query.mock.calls[0];
    expect(sql).toContain('$1');
    expect(sql).toContain('$2');
    expect(sql).not.toContain(TENANT_ID);
    expect(sql).not.toContain(AGENCY_ID);
  });

  it('queries the agencies table', async () => {
    const client = mockClient([AGENCY_A]);
    await getAgency(client, TENANT_ID, AGENCY_ID);

    const [sql] = client.query.mock.calls[0];
    expect(sql).toMatch(/FROM\s+agencies\b/i);
  });

  it('filters by tenant_id and id', async () => {
    const client = mockClient([AGENCY_A]);
    await getAgency(client, TENANT_ID, AGENCY_ID);

    const [sql] = client.query.mock.calls[0];
    expect(sql).toMatch(/tenant_id\s*=\s*\$1/i);
    expect(sql).toMatch(/id\s*=\s*\$2/i);
  });

  it('selects the expected columns', async () => {
    const client = mockClient([AGENCY_A]);
    await getAgency(client, TENANT_ID, AGENCY_ID);

    const [sql] = client.query.mock.calls[0];
    for (const col of ['id', 'tenant_id', 'name', 'slug', 'status', 'created_at', 'updated_at']) {
      expect(sql).toContain(col);
    }
  });

  it('calls client.query exactly once', async () => {
    const client = mockClient([AGENCY_A]);
    await getAgency(client, TENANT_ID, AGENCY_ID);

    expect(client.query).toHaveBeenCalledOnce();
  });
});

// ───── Tenant isolation verification ─────

describe('getAgency — tenant isolation', () => {
  it('includes tenant_id in the WHERE clause', async () => {
    const client = mockClient([]);
    await getAgency(client, TENANT_ID, AGENCY_ID);

    const [sql] = client.query.mock.calls[0];
    expect(sql).toMatch(/WHERE\b.*tenant_id\s*=\s*\$1/i);
  });

  it('passes tenant_id before agency id in parameters', async () => {
    const client = mockClient([]);
    await getAgency(client, TENANT_ID, AGENCY_ID);

    const [, params] = client.query.mock.calls[0];
    expect(params[0]).toBe(TENANT_ID);
    expect(params[1]).toBe(AGENCY_ID);
  });

  it('uses both parameters in the query, preventing cross-tenant access', async () => {
    const otherTenant = 'c9999999-9999-4000-a000-999999999999';
    const client = mockClient([]);
    await getAgency(client, otherTenant, AGENCY_ID);

    const [, params] = client.query.mock.calls[0];
    expect(params[0]).toBe(otherTenant);
    expect(params[1]).toBe(AGENCY_ID);
  });
});

// ───── Error propagation ─────

describe('getAgency — error propagation', () => {
  it('propagates query errors to the caller', async () => {
    const client = { query: vi.fn().mockRejectedValue(new Error('connection refused')) };

    await expect(getAgency(client, TENANT_ID, AGENCY_ID)).rejects.toThrow('connection refused');
  });

  it('does not swallow database errors', async () => {
    const dbError = new Error('relation "agencies" does not exist');
    dbError.code = '42P01';
    const client = { query: vi.fn().mockRejectedValue(dbError) };

    await expect(getAgency(client, TENANT_ID, AGENCY_ID)).rejects.toThrow(dbError);
  });
});

// ═══════════════════════════════════════════════════
//  createAgency
// ═══════════════════════════════════════════════════

const CREATED_AGENCY = {
  id: 'a0000000-0000-4000-a000-000000000099',
  tenant_id: TENANT_ID,
  name: 'Department of Energy',
  slug: 'dept-energy',
  created_at: '2026-06-18T12:00:00Z',
  updated_at: '2026-06-18T12:00:00Z',
};

// ───── Successful insert ─────

describe('createAgency — success', () => {
  it('returns the inserted row', async () => {
    const client = mockClient([CREATED_AGENCY]);
    const result = await createAgency(client, TENANT_ID, { name: 'Department of Energy', slug: 'dept-energy' });

    expect(result).toEqual(CREATED_AGENCY);
  });

  it('passes tenantId, name, and slug to the query', async () => {
    const client = mockClient([CREATED_AGENCY]);
    await createAgency(client, TENANT_ID, { name: 'Department of Energy', slug: 'dept-energy' });

    const [, params] = client.query.mock.calls[0];
    expect(params).toEqual([TENANT_ID, 'Department of Energy', 'dept-energy']);
  });
});

// ───── Correct RETURNING columns ─────

describe('createAgency — RETURNING columns', () => {
  it('uses RETURNING clause', async () => {
    const client = mockClient([CREATED_AGENCY]);
    await createAgency(client, TENANT_ID, { name: 'X', slug: 'xxx' });

    const [sql] = client.query.mock.calls[0];
    expect(sql).toMatch(/RETURNING\b/i);
  });

  it('returns the expected columns', async () => {
    const client = mockClient([CREATED_AGENCY]);
    await createAgency(client, TENANT_ID, { name: 'X', slug: 'xxx' });

    const [sql] = client.query.mock.calls[0];
    for (const col of ['id', 'tenant_id', 'name', 'slug', 'created_at', 'updated_at']) {
      expect(sql).toContain(col);
    }
  });
});

// ───── Parameterized query verification ─────

describe('createAgency — parameterized query', () => {
  it('uses $1, $2, $3 placeholders', async () => {
    const client = mockClient([CREATED_AGENCY]);
    await createAgency(client, TENANT_ID, { name: 'Test', slug: 'test-slug' });

    const [sql] = client.query.mock.calls[0];
    expect(sql).toContain('$1');
    expect(sql).toContain('$2');
    expect(sql).toContain('$3');
  });

  it('does not interpolate literal values into SQL', async () => {
    const client = mockClient([CREATED_AGENCY]);
    await createAgency(client, TENANT_ID, { name: 'Injected Value', slug: 'inject-slug' });

    const [sql] = client.query.mock.calls[0];
    expect(sql).not.toContain('Injected Value');
    expect(sql).not.toContain('inject-slug');
    expect(sql).not.toContain(TENANT_ID);
  });

  it('inserts into the agencies table', async () => {
    const client = mockClient([CREATED_AGENCY]);
    await createAgency(client, TENANT_ID, { name: 'X', slug: 'xxx' });

    const [sql] = client.query.mock.calls[0];
    expect(sql).toMatch(/INSERT\s+INTO\s+agencies\b/i);
  });
});

// ───── Correct parameter ordering ─────

describe('createAgency — parameter ordering', () => {
  it('passes tenantId as $1, name as $2, slug as $3', async () => {
    const client = mockClient([CREATED_AGENCY]);
    await createAgency(client, TENANT_ID, { name: 'Dept A', slug: 'dept-a' });

    const [, params] = client.query.mock.calls[0];
    expect(params[0]).toBe(TENANT_ID);
    expect(params[1]).toBe('Dept A');
    expect(params[2]).toBe('dept-a');
  });

  it('includes tenant_id, name, slug in the column list', async () => {
    const client = mockClient([CREATED_AGENCY]);
    await createAgency(client, TENANT_ID, { name: 'X', slug: 'xxx' });

    const [sql] = client.query.mock.calls[0];
    expect(sql).toMatch(/\(\s*tenant_id\s*,\s*name\s*,\s*slug\s*\)/i);
  });
});

// ───── Single query execution ─────

describe('createAgency — single query', () => {
  it('calls client.query exactly once', async () => {
    const client = mockClient([CREATED_AGENCY]);
    await createAgency(client, TENANT_ID, { name: 'X', slug: 'xxx' });

    expect(client.query).toHaveBeenCalledOnce();
  });
});

// ───── Error propagation ─────

describe('createAgency — error propagation', () => {
  it('propagates query errors to the caller', async () => {
    const client = { query: vi.fn().mockRejectedValue(new Error('connection refused')) };

    await expect(createAgency(client, TENANT_ID, { name: 'X', slug: 'xxx' })).rejects.toThrow('connection refused');
  });

  it('propagates unique constraint violations', async () => {
    const dbError = new Error('duplicate key value violates unique constraint');
    dbError.code = '23505';
    const client = { query: vi.fn().mockRejectedValue(dbError) };

    await expect(createAgency(client, TENANT_ID, { name: 'X', slug: 'dup' })).rejects.toThrow(dbError);
  });
});

// ═══════════════════════════════════════════════════
//  updateAgency
// ═══════════════════════════════════════════════════

const UPDATED_AGENCY = {
  id: AGENCY_ID,
  tenant_id: TENANT_ID,
  name: 'Renamed Department',
  slug: 'renamed-dept',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-06-18T12:00:00Z',
};

// ───── Update name only ─────

describe('updateAgency — update name only', () => {
  it('returns the updated row', async () => {
    const row = { ...UPDATED_AGENCY, slug: AGENCY_A.slug };
    const client = mockClient([row]);
    const result = await updateAgency(client, TENANT_ID, AGENCY_ID, { name: 'Renamed Department' });

    expect(result).toEqual(row);
  });

  it('builds a SET clause for name only', async () => {
    const client = mockClient([UPDATED_AGENCY]);
    await updateAgency(client, TENANT_ID, AGENCY_ID, { name: 'X' });

    const [sql] = client.query.mock.calls[0];
    expect(sql).toMatch(/SET\s+name\s*=\s*\$1/i);
    expect(sql).not.toMatch(/slug\s*=\s*\$/i);
  });

  it('passes name, tenantId, agencyId in correct order', async () => {
    const client = mockClient([UPDATED_AGENCY]);
    await updateAgency(client, TENANT_ID, AGENCY_ID, { name: 'New Name' });

    const [, params] = client.query.mock.calls[0];
    expect(params).toEqual(['New Name', TENANT_ID, AGENCY_ID]);
  });
});

// ───── Update slug only ─────

describe('updateAgency — update slug only', () => {
  it('returns the updated row', async () => {
    const row = { ...UPDATED_AGENCY, name: AGENCY_A.name };
    const client = mockClient([row]);
    const result = await updateAgency(client, TENANT_ID, AGENCY_ID, { slug: 'new-slug' });

    expect(result).toEqual(row);
  });

  it('builds a SET clause for slug only', async () => {
    const client = mockClient([UPDATED_AGENCY]);
    await updateAgency(client, TENANT_ID, AGENCY_ID, { slug: 'new-slug' });

    const [sql] = client.query.mock.calls[0];
    expect(sql).toMatch(/SET\s+slug\s*=\s*\$1/i);
    expect(sql).not.toMatch(/name\s*=\s*\$/i);
  });

  it('passes slug, tenantId, agencyId in correct order', async () => {
    const client = mockClient([UPDATED_AGENCY]);
    await updateAgency(client, TENANT_ID, AGENCY_ID, { slug: 'new-slug' });

    const [, params] = client.query.mock.calls[0];
    expect(params).toEqual(['new-slug', TENANT_ID, AGENCY_ID]);
  });
});

// ───── Update both fields ─────

describe('updateAgency — update both fields', () => {
  it('returns the updated row', async () => {
    const client = mockClient([UPDATED_AGENCY]);
    const result = await updateAgency(client, TENANT_ID, AGENCY_ID, { name: 'Renamed Department', slug: 'renamed-dept' });

    expect(result).toEqual(UPDATED_AGENCY);
  });

  it('builds SET clauses for both name and slug', async () => {
    const client = mockClient([UPDATED_AGENCY]);
    await updateAgency(client, TENANT_ID, AGENCY_ID, { name: 'X', slug: 'y-slug' });

    const [sql] = client.query.mock.calls[0];
    expect(sql).toMatch(/name\s*=\s*\$1/i);
    expect(sql).toMatch(/slug\s*=\s*\$2/i);
  });

  it('passes name, slug, tenantId, agencyId in correct order', async () => {
    const client = mockClient([UPDATED_AGENCY]);
    await updateAgency(client, TENANT_ID, AGENCY_ID, { name: 'N', slug: 's-slug' });

    const [, params] = client.query.mock.calls[0];
    expect(params).toEqual(['N', 's-slug', TENANT_ID, AGENCY_ID]);
  });
});

// ───── Parameterized query verification ─────

describe('updateAgency — parameterized query', () => {
  it('does not interpolate literal values into SQL', async () => {
    const client = mockClient([UPDATED_AGENCY]);
    await updateAgency(client, TENANT_ID, AGENCY_ID, { name: 'Injected' });

    const [sql] = client.query.mock.calls[0];
    expect(sql).not.toContain('Injected');
    expect(sql).not.toContain(TENANT_ID);
    expect(sql).not.toContain(AGENCY_ID);
  });

  it('uses UPDATE on the agencies table', async () => {
    const client = mockClient([UPDATED_AGENCY]);
    await updateAgency(client, TENANT_ID, AGENCY_ID, { name: 'X' });

    const [sql] = client.query.mock.calls[0];
    expect(sql).toMatch(/UPDATE\s+agencies\b/i);
  });

  it('calls client.query exactly once', async () => {
    const client = mockClient([UPDATED_AGENCY]);
    await updateAgency(client, TENANT_ID, AGENCY_ID, { name: 'X' });

    expect(client.query).toHaveBeenCalledOnce();
  });
});

// ───── Tenant isolation verification ─────

describe('updateAgency — tenant isolation', () => {
  it('includes tenant_id in the WHERE clause', async () => {
    const client = mockClient([UPDATED_AGENCY]);
    await updateAgency(client, TENANT_ID, AGENCY_ID, { name: 'X' });

    const [sql] = client.query.mock.calls[0];
    expect(sql).toMatch(/WHERE\b.*tenant_id\s*=\s*\$/i);
  });

  it('passes tenantId as a query parameter', async () => {
    const client = mockClient([UPDATED_AGENCY]);
    await updateAgency(client, TENANT_ID, AGENCY_ID, { name: 'X' });

    const [, params] = client.query.mock.calls[0];
    expect(params).toContain(TENANT_ID);
  });
});

// ───── Agency isolation verification ─────

describe('updateAgency — agency isolation', () => {
  it('includes id in the WHERE clause', async () => {
    const client = mockClient([UPDATED_AGENCY]);
    await updateAgency(client, TENANT_ID, AGENCY_ID, { name: 'X' });

    const [sql] = client.query.mock.calls[0];
    expect(sql).toMatch(/WHERE\b.*\bid\s*=\s*\$/i);
  });

  it('passes agencyId as a query parameter', async () => {
    const client = mockClient([UPDATED_AGENCY]);
    await updateAgency(client, TENANT_ID, AGENCY_ID, { name: 'X' });

    const [, params] = client.query.mock.calls[0];
    expect(params).toContain(AGENCY_ID);
  });
});

// ───── Correct parameter ordering ─────

describe('updateAgency — parameter ordering', () => {
  it('places tenantId and agencyId after field values', async () => {
    const client = mockClient([UPDATED_AGENCY]);
    await updateAgency(client, TENANT_ID, AGENCY_ID, { name: 'A', slug: 'b-slug' });

    const [, params] = client.query.mock.calls[0];
    expect(params.at(-2)).toBe(TENANT_ID);
    expect(params.at(-1)).toBe(AGENCY_ID);
  });

  it('uses correct placeholder index for tenant_id in WHERE', async () => {
    const client = mockClient([UPDATED_AGENCY]);
    await updateAgency(client, TENANT_ID, AGENCY_ID, { name: 'A', slug: 'b-slug' });

    const [sql, params] = client.query.mock.calls[0];
    const tenantMatch = sql.match(/tenant_id\s*=\s*\$(\d+)/i);
    expect(tenantMatch).not.toBeNull();
    expect(params[parseInt(tenantMatch[1], 10) - 1]).toBe(TENANT_ID);
  });

  it('uses correct placeholder index for id in WHERE', async () => {
    const client = mockClient([UPDATED_AGENCY]);
    await updateAgency(client, TENANT_ID, AGENCY_ID, { name: 'A', slug: 'b-slug' });

    const [sql, params] = client.query.mock.calls[0];
    const idMatch = sql.match(/\bAND\s+id\s*=\s*\$(\d+)/i);
    expect(idMatch).not.toBeNull();
    expect(params[parseInt(idMatch[1], 10) - 1]).toBe(AGENCY_ID);
  });
});

// ───── updated_at = NOW() ─────

describe('updateAgency — updated_at', () => {
  it('includes updated_at = NOW() in the SET clause', async () => {
    const client = mockClient([UPDATED_AGENCY]);
    await updateAgency(client, TENANT_ID, AGENCY_ID, { name: 'X' });

    const [sql] = client.query.mock.calls[0];
    expect(sql).toMatch(/updated_at\s*=\s*NOW\(\)/i);
  });
});

// ───── RETURNING clause verification ─────

describe('updateAgency — RETURNING clause', () => {
  it('includes RETURNING', async () => {
    const client = mockClient([UPDATED_AGENCY]);
    await updateAgency(client, TENANT_ID, AGENCY_ID, { name: 'X' });

    const [sql] = client.query.mock.calls[0];
    expect(sql).toMatch(/RETURNING\b/i);
  });

  it('returns the expected columns', async () => {
    const client = mockClient([UPDATED_AGENCY]);
    await updateAgency(client, TENANT_ID, AGENCY_ID, { name: 'X' });

    const [sql] = client.query.mock.calls[0];
    for (const col of ['id', 'tenant_id', 'name', 'slug', 'created_at', 'updated_at']) {
      expect(sql).toContain(col);
    }
  });
});

// ───── Not found returns null ─────

describe('updateAgency — not found', () => {
  it('returns null when no row matches', async () => {
    const client = mockClient([]);
    const result = await updateAgency(client, TENANT_ID, AGENCY_ID, { name: 'Ghost' });

    expect(result).toBeNull();
  });

  it('does not throw for not-found', async () => {
    const client = mockClient([]);

    await expect(updateAgency(client, TENANT_ID, AGENCY_ID, { slug: 'gone' })).resolves.toBeNull();
  });
});

// ───── Error propagation ─────

describe('updateAgency — error propagation', () => {
  it('propagates query errors to the caller', async () => {
    const client = { query: vi.fn().mockRejectedValue(new Error('deadlock detected')) };

    await expect(updateAgency(client, TENANT_ID, AGENCY_ID, { name: 'X' })).rejects.toThrow('deadlock detected');
  });

  it('propagates unique constraint violations', async () => {
    const dbError = new Error('unique_violation');
    dbError.code = '23505';
    const client = { query: vi.fn().mockRejectedValue(dbError) };

    await expect(updateAgency(client, TENANT_ID, AGENCY_ID, { slug: 'dup' })).rejects.toThrow(dbError);
  });
});

// ═══════════════════════════════════════════════════
//  listAgencies
// ═══════════════════════════════════════════════════

// ───── Success path ─────

describe('listAgencies — success', () => {
  it('returns all matching rows', async () => {
    const client = mockClient([AGENCY_A, AGENCY_B]);
    const result = await listAgencies(client, TENANT_ID);

    expect(result).toEqual([AGENCY_A, AGENCY_B]);
  });

  it('returns a single row when only one agency exists', async () => {
    const client = mockClient([AGENCY_A]);
    const result = await listAgencies(client, TENANT_ID);

    expect(result).toEqual([AGENCY_A]);
    expect(result).toHaveLength(1);
  });

  it('returns rows with the expected columns', async () => {
    const client = mockClient([AGENCY_A]);
    const result = await listAgencies(client, TENANT_ID);

    const row = result[0];
    expect(row).toHaveProperty('id');
    expect(row).toHaveProperty('tenant_id');
    expect(row).toHaveProperty('name');
    expect(row).toHaveProperty('slug');
    expect(row).toHaveProperty('status');
    expect(row).toHaveProperty('created_at');
    expect(row).toHaveProperty('updated_at');
  });
});

// ───── Empty result set ─────

describe('listAgencies — empty result', () => {
  it('returns an empty array when no rows exist', async () => {
    const client = mockClient([]);
    const result = await listAgencies(client, TENANT_ID);

    expect(result).toEqual([]);
  });

  it('does not throw when no rows exist', async () => {
    const client = mockClient([]);

    await expect(listAgencies(client, TENANT_ID)).resolves.toEqual([]);
  });

  it('returns an array, not null or undefined', async () => {
    const client = mockClient([]);
    const result = await listAgencies(client, TENANT_ID);

    expect(Array.isArray(result)).toBe(true);
  });
});

// ───── Parameterized query verification ─────

describe('listAgencies — parameterized query', () => {
  it('passes tenantId as a query parameter', async () => {
    const client = mockClient([]);
    await listAgencies(client, TENANT_ID);

    const [, params] = client.query.mock.calls[0];
    expect(params).toEqual([TENANT_ID]);
  });

  it('uses $1 placeholder, not literal tenantId', async () => {
    const client = mockClient([]);
    await listAgencies(client, TENANT_ID);

    const [sql] = client.query.mock.calls[0];
    expect(sql).toContain('$1');
    expect(sql).not.toContain(TENANT_ID);
  });

  it('queries the agencies table', async () => {
    const client = mockClient([]);
    await listAgencies(client, TENANT_ID);

    const [sql] = client.query.mock.calls[0];
    expect(sql).toMatch(/FROM\s+agencies\b/i);
  });

  it('filters by tenant_id', async () => {
    const client = mockClient([]);
    await listAgencies(client, TENANT_ID);

    const [sql] = client.query.mock.calls[0];
    expect(sql).toMatch(/WHERE\s+tenant_id\s*=\s*\$1/i);
  });

  it('selects the expected columns', async () => {
    const client = mockClient([]);
    await listAgencies(client, TENANT_ID);

    const [sql] = client.query.mock.calls[0];
    for (const col of ['id', 'tenant_id', 'name', 'slug', 'status', 'created_at', 'updated_at']) {
      expect(sql).toContain(col);
    }
  });

  it('calls client.query exactly once', async () => {
    const client = mockClient([]);
    await listAgencies(client, TENANT_ID);

    expect(client.query).toHaveBeenCalledOnce();
  });
});

// ───── Ordering clause verification ─────

describe('listAgencies — ordering', () => {
  it('includes ORDER BY name ASC', async () => {
    const client = mockClient([]);
    await listAgencies(client, TENANT_ID);

    const [sql] = client.query.mock.calls[0];
    expect(sql).toMatch(/ORDER\s+BY\s+name\s+ASC/i);
  });
});

// ───── Error propagation ─────

describe('listAgencies — error propagation', () => {
  it('propagates query errors to the caller', async () => {
    const client = { query: vi.fn().mockRejectedValue(new Error('connection refused')) };

    await expect(listAgencies(client, TENANT_ID)).rejects.toThrow('connection refused');
  });

  it('does not swallow database errors', async () => {
    const dbError = new Error('relation "agencies" does not exist');
    dbError.code = '42P01';
    const client = { query: vi.fn().mockRejectedValue(dbError) };

    await expect(listAgencies(client, TENANT_ID)).rejects.toThrow(dbError);
  });
});

// ═══════════════════════════════════════════════════
//  deleteAgency
// ═══════════════════════════════════════════════════

function mockDeleteClient(rowCount) {
  return { query: vi.fn().mockResolvedValue({ rowCount }) };
}

// ───── Successful delete ─────

describe('deleteAgency — success', () => {
  it('returns true when a row was deleted', async () => {
    const client = mockDeleteClient(1);
    const result = await deleteAgency(client, TENANT_ID, AGENCY_ID);

    expect(result).toBe(true);
  });
});

// ───── Returns true when rowCount > 0 ─────

describe('deleteAgency — returns true when rowCount > 0', () => {
  it('returns true for rowCount of 1', async () => {
    const client = mockDeleteClient(1);
    const result = await deleteAgency(client, TENANT_ID, AGENCY_ID);

    expect(result).toBe(true);
  });
});

// ───── Returns false when rowCount = 0 ─────

describe('deleteAgency — returns false when rowCount = 0', () => {
  it('returns false when no row matched', async () => {
    const client = mockDeleteClient(0);
    const result = await deleteAgency(client, TENANT_ID, AGENCY_ID);

    expect(result).toBe(false);
  });

  it('does not throw when no row matched', async () => {
    const client = mockDeleteClient(0);

    await expect(deleteAgency(client, TENANT_ID, AGENCY_ID)).resolves.toBe(false);
  });
});

// ───── Parameterized query verification ─────

describe('deleteAgency — parameterized query', () => {
  it('uses $1 and $2 placeholders', async () => {
    const client = mockDeleteClient(1);
    await deleteAgency(client, TENANT_ID, AGENCY_ID);

    const [sql] = client.query.mock.calls[0];
    expect(sql).toContain('$1');
    expect(sql).toContain('$2');
  });

  it('does not interpolate literal values into SQL', async () => {
    const client = mockDeleteClient(1);
    await deleteAgency(client, TENANT_ID, AGENCY_ID);

    const [sql] = client.query.mock.calls[0];
    expect(sql).not.toContain(TENANT_ID);
    expect(sql).not.toContain(AGENCY_ID);
  });

  it('uses DELETE FROM agencies', async () => {
    const client = mockDeleteClient(1);
    await deleteAgency(client, TENANT_ID, AGENCY_ID);

    const [sql] = client.query.mock.calls[0];
    expect(sql).toMatch(/DELETE\s+FROM\s+agencies\b/i);
  });
});

// ───── Tenant isolation verification ─────

describe('deleteAgency — tenant isolation', () => {
  it('includes tenant_id in the WHERE clause', async () => {
    const client = mockDeleteClient(0);
    await deleteAgency(client, TENANT_ID, AGENCY_ID);

    const [sql] = client.query.mock.calls[0];
    expect(sql).toMatch(/WHERE\b.*tenant_id\s*=\s*\$1/i);
  });

  it('passes tenantId as a query parameter', async () => {
    const client = mockDeleteClient(0);
    await deleteAgency(client, TENANT_ID, AGENCY_ID);

    const [, params] = client.query.mock.calls[0];
    expect(params).toContain(TENANT_ID);
  });
});

// ───── Agency isolation verification ─────

describe('deleteAgency — agency isolation', () => {
  it('includes id in the WHERE clause', async () => {
    const client = mockDeleteClient(0);
    await deleteAgency(client, TENANT_ID, AGENCY_ID);

    const [sql] = client.query.mock.calls[0];
    expect(sql).toMatch(/\bAND\s+id\s*=\s*\$2/i);
  });

  it('passes agencyId as a query parameter', async () => {
    const client = mockDeleteClient(0);
    await deleteAgency(client, TENANT_ID, AGENCY_ID);

    const [, params] = client.query.mock.calls[0];
    expect(params).toContain(AGENCY_ID);
  });
});

// ───── Correct parameter ordering ─────

describe('deleteAgency — parameter ordering', () => {
  it('passes tenantId as $1 and agencyId as $2', async () => {
    const client = mockDeleteClient(1);
    await deleteAgency(client, TENANT_ID, AGENCY_ID);

    const [, params] = client.query.mock.calls[0];
    expect(params).toEqual([TENANT_ID, AGENCY_ID]);
  });
});

// ───── Single query execution ─────

describe('deleteAgency — single query', () => {
  it('calls client.query exactly once', async () => {
    const client = mockDeleteClient(1);
    await deleteAgency(client, TENANT_ID, AGENCY_ID);

    expect(client.query).toHaveBeenCalledOnce();
  });
});

// ───── Error propagation ─────

describe('deleteAgency — error propagation', () => {
  it('propagates foreign key violations', async () => {
    const dbError = new Error('update or delete on table "agencies" violates foreign key constraint');
    dbError.code = '23503';
    const client = { query: vi.fn().mockRejectedValue(dbError) };

    await expect(deleteAgency(client, TENANT_ID, AGENCY_ID)).rejects.toThrow(dbError);
  });

  it('propagates connection errors', async () => {
    const client = { query: vi.fn().mockRejectedValue(new Error('connection refused')) };

    await expect(deleteAgency(client, TENANT_ID, AGENCY_ID)).rejects.toThrow('connection refused');
  });
});
