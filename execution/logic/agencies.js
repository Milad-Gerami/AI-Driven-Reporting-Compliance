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
  throw new Error('TODO: createAgency not yet implemented');
}

async function updateAgency(client, tenantId, agencyId, data) {
  throw new Error('TODO: updateAgency not yet implemented');
}

async function deleteAgency(client, tenantId, agencyId) {
  throw new Error('TODO: deleteAgency not yet implemented');
}

module.exports = { getAgency, listAgencies, createAgency, updateAgency, deleteAgency };
