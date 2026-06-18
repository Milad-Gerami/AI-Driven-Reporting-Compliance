import { describe, it, expect, vi } from 'vitest';
import { getAgency, listAgencies } from '../../../../execution/logic/agencies.js';

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
