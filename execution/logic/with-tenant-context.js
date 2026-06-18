'use strict';

function withTenantContext(pool) {
  if (!pool || typeof pool.connect !== 'function') {
    throw new Error('withTenantContext: pool must have a connect method');
  }

  return async function withTenantContextForRequest(tenantId, callback) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL app.current_tenant_id = $1', [tenantId]);
      await callback(client);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  };
}

module.exports = withTenantContext;
