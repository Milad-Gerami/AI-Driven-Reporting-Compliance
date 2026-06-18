'use strict';

async function getAgency(client, tenantId, agencyId) {
  const result = await client.query(
    'SELECT id, tenant_id, name, slug, status, created_at, updated_at FROM agencies WHERE tenant_id = $1 AND id = $2',
    [tenantId, agencyId],
  );
  return result.rows[0] || null;
}

async function listAgencies(client, tenantId) {
  const result = await client.query(
    'SELECT id, tenant_id, name, slug, status, created_at, updated_at FROM agencies WHERE tenant_id = $1 ORDER BY name ASC',
    [tenantId],
  );
  return result.rows;
}

async function createAgency(client, tenantId, data) {
  const result = await client.query(
    'INSERT INTO agencies (tenant_id, name, slug) VALUES ($1, $2, $3) RETURNING id, tenant_id, name, slug, created_at, updated_at',
    [tenantId, data.name, data.slug],
  );
  return result.rows[0];
}

async function updateAgency(client, tenantId, agencyId, data) {
  const setClauses = [];
  const values = [];
  let paramIndex = 1;

  if (data.name !== undefined) {
    setClauses.push(`name = $${paramIndex++}`);
    values.push(data.name);
  }
  if (data.slug !== undefined) {
    setClauses.push(`slug = $${paramIndex++}`);
    values.push(data.slug);
  }

  setClauses.push('updated_at = NOW()');
  values.push(tenantId, agencyId);

  const sql = `UPDATE agencies SET ${setClauses.join(', ')} WHERE tenant_id = $${paramIndex++} AND id = $${paramIndex} RETURNING id, tenant_id, name, slug, created_at, updated_at`;
  const result = await client.query(sql, values);
  return result.rows[0] || null;
}

async function deleteAgency(client, tenantId, agencyId) {
  const result = await client.query(
    'DELETE FROM agencies WHERE tenant_id = $1 AND id = $2',
    [tenantId, agencyId],
  );
  return result.rowCount > 0;
}

module.exports = { getAgency, listAgencies, createAgency, updateAgency, deleteAgency };
