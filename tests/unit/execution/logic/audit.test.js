import { describe, it, expect, vi } from 'vitest';
import { createAuditEvent, listAuditEvents } from '../../../../execution/logic/audit.js';

const TENANT_ID = 'c0000000-0000-4000-a000-000000000001';
const ACTOR_ID = 'u0000000-0000-4000-a000-000000000001';
const RESOURCE_ID = 'r0000000-0000-4000-a000-000000000001';

const AUDIT_EVENT = {
  tenant_id: TENANT_ID,
  actor_id: ACTOR_ID,
  actor_type: 'user',
  action: 'agency.created',
  resource_type: 'agencies',
  resource_id: RESOURCE_ID,
  metadata: { ip_address: '127.0.0.1', user_agent: 'test' },
};

const INSERTED_ROW = {
  id: 'e0000000-0000-4000-a000-000000000001',
  ...AUDIT_EVENT,
  occurred_at: '2026-06-22T00:00:00Z',
};

const AUDIT_ROW_A = {
  id: 'e0000000-0000-4000-a000-000000000001',
  tenant_id: TENANT_ID,
  actor_id: ACTOR_ID,
  actor_type: 'user',
  action: 'agency.created',
  resource_type: 'agencies',
  resource_id: RESOURCE_ID,
  metadata: {},
  occurred_at: '2026-06-22T12:00:00Z',
};

const AUDIT_ROW_B = {
  id: 'e0000000-0000-4000-a000-000000000002',
  tenant_id: TENANT_ID,
  actor_id: null,
  actor_type: 'system',
  action: 'ingestion_run.started',
  resource_type: 'ingestion_runs',
  resource_id: 'r0000000-0000-4000-a000-000000000002',
  metadata: { worker_name: 'ingestion-runner', job_id: 'job-1' },
  occurred_at: '2026-06-22T11:00:00Z',
};

function mockClient(rows) {
  return { query: vi.fn().mockResolvedValue({ rows }) };
}

// ═══════════════════════════════════════════════════
//  createAuditEvent
// ═══════════════════════════════════════════════════

// ───── Success path ─────

describe('createAuditEvent — success', () => {
  it('returns the inserted row', async () => {
    const client = mockClient([INSERTED_ROW]);
    const result = await createAuditEvent(client, AUDIT_EVENT);

    expect(result).toEqual(INSERTED_ROW);
  });

  it('returns a row with all expected columns', async () => {
    const client = mockClient([INSERTED_ROW]);
    const result = await createAuditEvent(client, AUDIT_EVENT);

    expect(result).toHaveProperty('id');
    expect(result).toHaveProperty('tenant_id');
    expect(result).toHaveProperty('actor_id');
    expect(result).toHaveProperty('actor_type');
    expect(result).toHaveProperty('action');
    expect(result).toHaveProperty('resource_type');
    expect(result).toHaveProperty('resource_id');
    expect(result).toHaveProperty('metadata');
    expect(result).toHaveProperty('occurred_at');
  });
});

// ───── Parameterized query verification ─────

describe('createAuditEvent — parameterized query', () => {
  it('inserts into the audit_logs table', async () => {
    const client = mockClient([INSERTED_ROW]);
    await createAuditEvent(client, AUDIT_EVENT);

    const [sql] = client.query.mock.calls[0];
    expect(sql).toMatch(/INSERT\s+INTO\s+audit_logs\b/i);
  });

  it('uses RETURNING clause', async () => {
    const client = mockClient([INSERTED_ROW]);
    await createAuditEvent(client, AUDIT_EVENT);

    const [sql] = client.query.mock.calls[0];
    expect(sql).toMatch(/RETURNING\b/i);
  });

  it('returns all nine columns in the RETURNING clause', async () => {
    const client = mockClient([INSERTED_ROW]);
    await createAuditEvent(client, AUDIT_EVENT);

    const [sql] = client.query.mock.calls[0];
    for (const col of ['id', 'tenant_id', 'actor_id', 'actor_type', 'action', 'resource_type', 'resource_id', 'metadata', 'occurred_at']) {
      expect(sql).toContain(col);
    }
  });

  it('uses $1 through $7 placeholders', async () => {
    const client = mockClient([INSERTED_ROW]);
    await createAuditEvent(client, AUDIT_EVENT);

    const [sql] = client.query.mock.calls[0];
    for (let i = 1; i <= 7; i++) {
      expect(sql).toContain(`$${i}`);
    }
  });

  it('does not interpolate literal values into SQL', async () => {
    const client = mockClient([INSERTED_ROW]);
    await createAuditEvent(client, AUDIT_EVENT);

    const [sql] = client.query.mock.calls[0];
    expect(sql).not.toContain(TENANT_ID);
    expect(sql).not.toContain(ACTOR_ID);
    expect(sql).not.toContain(RESOURCE_ID);
    expect(sql).not.toContain('agency.created');
  });

  it('calls client.query exactly once', async () => {
    const client = mockClient([INSERTED_ROW]);
    await createAuditEvent(client, AUDIT_EVENT);

    expect(client.query).toHaveBeenCalledOnce();
  });
});

// ───── Parameter ordering ─────

describe('createAuditEvent — parameter ordering', () => {
  it('passes seven parameters', async () => {
    const client = mockClient([INSERTED_ROW]);
    await createAuditEvent(client, AUDIT_EVENT);

    const [, params] = client.query.mock.calls[0];
    expect(params).toHaveLength(7);
  });

  it('passes tenant_id as $1', async () => {
    const client = mockClient([INSERTED_ROW]);
    await createAuditEvent(client, AUDIT_EVENT);

    const [, params] = client.query.mock.calls[0];
    expect(params[0]).toBe(TENANT_ID);
  });

  it('passes actor_id as $2', async () => {
    const client = mockClient([INSERTED_ROW]);
    await createAuditEvent(client, AUDIT_EVENT);

    const [, params] = client.query.mock.calls[0];
    expect(params[1]).toBe(ACTOR_ID);
  });

  it('passes actor_type as $3', async () => {
    const client = mockClient([INSERTED_ROW]);
    await createAuditEvent(client, AUDIT_EVENT);

    const [, params] = client.query.mock.calls[0];
    expect(params[2]).toBe('user');
  });

  it('passes action as $4', async () => {
    const client = mockClient([INSERTED_ROW]);
    await createAuditEvent(client, AUDIT_EVENT);

    const [, params] = client.query.mock.calls[0];
    expect(params[3]).toBe('agency.created');
  });

  it('passes resource_type as $5', async () => {
    const client = mockClient([INSERTED_ROW]);
    await createAuditEvent(client, AUDIT_EVENT);

    const [, params] = client.query.mock.calls[0];
    expect(params[4]).toBe('agencies');
  });

  it('passes resource_id as $6', async () => {
    const client = mockClient([INSERTED_ROW]);
    await createAuditEvent(client, AUDIT_EVENT);

    const [, params] = client.query.mock.calls[0];
    expect(params[5]).toBe(RESOURCE_ID);
  });

  it('passes metadata as $7', async () => {
    const client = mockClient([INSERTED_ROW]);
    await createAuditEvent(client, AUDIT_EVENT);

    const [, params] = client.query.mock.calls[0];
    expect(params[6]).toEqual({ ip_address: '127.0.0.1', user_agent: 'test' });
  });
});

// ───── System actor (null actor_id) ─────

describe('createAuditEvent — system actor', () => {
  it('passes null actor_id for system-initiated events', async () => {
    const systemEvent = { ...AUDIT_EVENT, actor_id: null, actor_type: 'system' };
    const client = mockClient([{ ...INSERTED_ROW, actor_id: null, actor_type: 'system' }]);
    await createAuditEvent(client, systemEvent);

    const [, params] = client.query.mock.calls[0];
    expect(params[1]).toBeNull();
    expect(params[2]).toBe('system');
  });
});

// ───── Validation — missing required fields ─────

describe('createAuditEvent — missing required fields', () => {
  const REQUIRED_FIELDS = ['tenant_id', 'actor_type', 'action', 'resource_type', 'resource_id', 'metadata'];

  for (const field of REQUIRED_FIELDS) {
    it(`throws when ${field} is missing`, async () => {
      const event = { ...AUDIT_EVENT };
      delete event[field];
      const client = mockClient([]);

      await expect(createAuditEvent(client, event)).rejects.toThrow(`${field} is required`);
    });

    it(`throws when ${field} is null`, async () => {
      const event = { ...AUDIT_EVENT, [field]: null };
      const client = mockClient([]);

      await expect(createAuditEvent(client, event)).rejects.toThrow(`${field} is required`);
    });

    it(`does not call client.query when ${field} is missing`, async () => {
      const event = { ...AUDIT_EVENT };
      delete event[field];
      const client = mockClient([]);

      try { await createAuditEvent(client, event); } catch (_) { /* expected */ }

      expect(client.query).not.toHaveBeenCalled();
    });
  }

  it('throws when event is null', async () => {
    const client = mockClient([]);

    await expect(createAuditEvent(client, null)).rejects.toThrow('event is required');
  });

  it('throws when event is undefined', async () => {
    const client = mockClient([]);

    await expect(createAuditEvent(client, undefined)).rejects.toThrow('event is required');
  });
});

// ───── Validation — invalid actor_type ─────

describe('createAuditEvent — invalid actor_type', () => {
  it('throws for an unknown actor_type', async () => {
    const event = { ...AUDIT_EVENT, actor_type: 'robot' };
    const client = mockClient([]);

    await expect(createAuditEvent(client, event)).rejects.toThrow('actor_type must be one of');
  });

  it('does not call client.query for an unknown actor_type', async () => {
    const event = { ...AUDIT_EVENT, actor_type: 'robot' };
    const client = mockClient([]);

    try { await createAuditEvent(client, event); } catch (_) { /* expected */ }

    expect(client.query).not.toHaveBeenCalled();
  });
});

// ───── Validation — actor_id / actor_type invariant ─────

describe('createAuditEvent — actor_id rules', () => {
  it('throws when actor_type is user and actor_id is missing', async () => {
    const event = { ...AUDIT_EVENT, actor_type: 'user', actor_id: undefined };
    const client = mockClient([]);

    await expect(createAuditEvent(client, event)).rejects.toThrow('actor_id is required when actor_type is user');
  });

  it('throws when actor_type is user and actor_id is null', async () => {
    const event = { ...AUDIT_EVENT, actor_type: 'user', actor_id: null };
    const client = mockClient([]);

    await expect(createAuditEvent(client, event)).rejects.toThrow('actor_id is required when actor_type is user');
  });

  it('throws when actor_type is system and actor_id is provided', async () => {
    const event = { ...AUDIT_EVENT, actor_type: 'system', actor_id: ACTOR_ID };
    const client = mockClient([]);

    await expect(createAuditEvent(client, event)).rejects.toThrow('actor_id must be null when actor_type is system');
  });

  it('throws when actor_type is api_key and actor_id is provided', async () => {
    const event = { ...AUDIT_EVENT, actor_type: 'api_key', actor_id: ACTOR_ID };
    const client = mockClient([]);

    await expect(createAuditEvent(client, event)).rejects.toThrow('actor_id must be null when actor_type is api_key');
  });

  it('does not call client.query when actor_id rule is violated', async () => {
    const event = { ...AUDIT_EVENT, actor_type: 'system', actor_id: ACTOR_ID };
    const client = mockClient([]);

    try { await createAuditEvent(client, event); } catch (_) { /* expected */ }

    expect(client.query).not.toHaveBeenCalled();
  });

  it('accepts system actor_type with null actor_id', async () => {
    const event = { ...AUDIT_EVENT, actor_type: 'system', actor_id: null };
    const client = mockClient([{ ...INSERTED_ROW, actor_type: 'system', actor_id: null }]);

    await expect(createAuditEvent(client, event)).resolves.toBeDefined();
    expect(client.query).toHaveBeenCalledOnce();
  });

  it('accepts api_key actor_type with null actor_id', async () => {
    const event = { ...AUDIT_EVENT, actor_type: 'api_key', actor_id: null };
    const client = mockClient([{ ...INSERTED_ROW, actor_type: 'api_key', actor_id: null }]);

    await expect(createAuditEvent(client, event)).resolves.toBeDefined();
    expect(client.query).toHaveBeenCalledOnce();
  });

  it('accepts user actor_type with a non-null actor_id', async () => {
    const client = mockClient([INSERTED_ROW]);

    await expect(createAuditEvent(client, AUDIT_EVENT)).resolves.toBeDefined();
    expect(client.query).toHaveBeenCalledOnce();
  });
});

// ───── Error propagation ─────

describe('createAuditEvent — error propagation', () => {
  it('propagates query errors to the caller', async () => {
    const client = { query: vi.fn().mockRejectedValue(new Error('connection refused')) };

    await expect(createAuditEvent(client, AUDIT_EVENT)).rejects.toThrow('connection refused');
  });

  it('propagates constraint violations', async () => {
    const dbError = new Error('violates check constraint "actor_id_matches_actor_type"');
    dbError.code = '23514';
    const client = { query: vi.fn().mockRejectedValue(dbError) };

    await expect(createAuditEvent(client, AUDIT_EVENT)).rejects.toThrow(dbError);
  });

  it('propagates foreign key violations', async () => {
    const dbError = new Error('violates foreign key constraint');
    dbError.code = '23503';
    const client = { query: vi.fn().mockRejectedValue(dbError) };

    await expect(createAuditEvent(client, AUDIT_EVENT)).rejects.toThrow(dbError);
  });
});

// ═══════════════════════════════════════════════════
//  listAuditEvents
// ═══════════════════════════════════════════════════

// ───── Success path ─────

describe('listAuditEvents — success', () => {
  it('returns all matching rows', async () => {
    const client = mockClient([AUDIT_ROW_A, AUDIT_ROW_B]);
    const result = await listAuditEvents(client, TENANT_ID);

    expect(result).toEqual([AUDIT_ROW_A, AUDIT_ROW_B]);
  });

  it('returns a single row when only one event exists', async () => {
    const client = mockClient([AUDIT_ROW_A]);
    const result = await listAuditEvents(client, TENANT_ID);

    expect(result).toEqual([AUDIT_ROW_A]);
    expect(result).toHaveLength(1);
  });

  it('returns rows with the expected columns', async () => {
    const client = mockClient([AUDIT_ROW_A]);
    const result = await listAuditEvents(client, TENANT_ID);

    const row = result[0];
    expect(row).toHaveProperty('id');
    expect(row).toHaveProperty('tenant_id');
    expect(row).toHaveProperty('actor_id');
    expect(row).toHaveProperty('actor_type');
    expect(row).toHaveProperty('action');
    expect(row).toHaveProperty('resource_type');
    expect(row).toHaveProperty('resource_id');
    expect(row).toHaveProperty('metadata');
    expect(row).toHaveProperty('occurred_at');
  });
});

// ───── Empty result set ─────

describe('listAuditEvents — empty result', () => {
  it('returns an empty array when no rows exist', async () => {
    const client = mockClient([]);
    const result = await listAuditEvents(client, TENANT_ID);

    expect(result).toEqual([]);
  });

  it('does not throw when no rows exist', async () => {
    const client = mockClient([]);

    await expect(listAuditEvents(client, TENANT_ID)).resolves.toEqual([]);
  });

  it('returns an array, not null or undefined', async () => {
    const client = mockClient([]);
    const result = await listAuditEvents(client, TENANT_ID);

    expect(Array.isArray(result)).toBe(true);
  });
});

// ───── Parameterized query verification ─────

describe('listAuditEvents — parameterized query', () => {
  it('passes tenantId as a query parameter', async () => {
    const client = mockClient([]);
    await listAuditEvents(client, TENANT_ID);

    const [, params] = client.query.mock.calls[0];
    expect(params).toEqual([TENANT_ID]);
  });

  it('uses $1 placeholder, not literal tenantId', async () => {
    const client = mockClient([]);
    await listAuditEvents(client, TENANT_ID);

    const [sql] = client.query.mock.calls[0];
    expect(sql).toContain('$1');
    expect(sql).not.toContain(TENANT_ID);
  });

  it('queries the audit_logs table', async () => {
    const client = mockClient([]);
    await listAuditEvents(client, TENANT_ID);

    const [sql] = client.query.mock.calls[0];
    expect(sql).toMatch(/FROM\s+audit_logs\b/i);
  });

  it('filters by tenant_id', async () => {
    const client = mockClient([]);
    await listAuditEvents(client, TENANT_ID);

    const [sql] = client.query.mock.calls[0];
    expect(sql).toMatch(/WHERE\s+tenant_id\s*=\s*\$1/i);
  });

  it('calls client.query exactly once', async () => {
    const client = mockClient([]);
    await listAuditEvents(client, TENANT_ID);

    expect(client.query).toHaveBeenCalledOnce();
  });
});

// ───── Ordering clause verification ─────

describe('listAuditEvents — ordering', () => {
  it('includes ORDER BY occurred_at DESC', async () => {
    const client = mockClient([]);
    await listAuditEvents(client, TENANT_ID);

    const [sql] = client.query.mock.calls[0];
    expect(sql).toMatch(/ORDER\s+BY\s+occurred_at\s+DESC/i);
  });
});

// ───── Tenant isolation verification ─────

describe('listAuditEvents — tenant isolation', () => {
  it('includes tenant_id in the WHERE clause', async () => {
    const client = mockClient([]);
    await listAuditEvents(client, TENANT_ID);

    const [sql] = client.query.mock.calls[0];
    expect(sql).toMatch(/WHERE\b.*tenant_id\s*=\s*\$1/i);
  });

  it('passes the correct tenantId parameter', async () => {
    const otherTenant = 'c9999999-9999-4000-a000-999999999999';
    const client = mockClient([]);
    await listAuditEvents(client, otherTenant);

    const [, params] = client.query.mock.calls[0];
    expect(params[0]).toBe(otherTenant);
  });
});

// ───── Error propagation ─────

describe('listAuditEvents — error propagation', () => {
  it('propagates query errors to the caller', async () => {
    const client = { query: vi.fn().mockRejectedValue(new Error('connection refused')) };

    await expect(listAuditEvents(client, TENANT_ID)).rejects.toThrow('connection refused');
  });

  it('does not swallow database errors', async () => {
    const dbError = new Error('relation "audit_logs" does not exist');
    dbError.code = '42P01';
    const client = { query: vi.fn().mockRejectedValue(dbError) };

    await expect(listAuditEvents(client, TENANT_ID)).rejects.toThrow(dbError);
  });
});
