'use strict';

async function getTenant(client, tenantId) {
  const result = await client.query(
    'SELECT id, name, slug, status, created_at, updated_at FROM tenants WHERE id = $1',
    [tenantId],
  );
  return result.rows[0] || null;
}

async function updateTenant(client, tenantId, updates) {
  const setClauses = [];
  const values = [];
  let paramIndex = 1;

  if (updates.name !== undefined) {
    setClauses.push(`name = $${paramIndex++}`);
    values.push(updates.name);
  }
  if (updates.slug !== undefined) {
    setClauses.push(`slug = $${paramIndex++}`);
    values.push(updates.slug);
  }

  setClauses.push('updated_at = NOW()');
  values.push(tenantId);

  const sql = `UPDATE tenants SET ${setClauses.join(', ')} WHERE id = $${paramIndex} RETURNING id, name, slug, status, created_at, updated_at`;
  const result = await client.query(sql, values);
  return result.rows[0] || null;
}

module.exports = { getTenant, updateTenant };
