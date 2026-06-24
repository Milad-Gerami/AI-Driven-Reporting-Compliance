'use strict';

const ALLOWED_ACTOR_TYPES = new Set(['user', 'system', 'api_key']);

function sanitizeSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return snapshot;

  const result = { ...snapshot };

  if ('connection_config' in result) {
    result.connection_config_fields = Object.keys(result.connection_config);
    delete result.connection_config;
  }

  delete result.auth_provider_id;

  if ('content' in result) {
    result.has_content = !!result.content;
    delete result.content;
  }

  delete result.details;

  return result;
}

function sanitizeMetadata(metadata) {
  const clone = JSON.parse(JSON.stringify(metadata));

  if (clone.before) {
    clone.before = sanitizeSnapshot(clone.before);
  }
  if (clone.after) {
    clone.after = sanitizeSnapshot(clone.after);
  }

  return clone;
}

function validateAuditEvent(event) {
  if (!event || typeof event !== 'object') {
    throw new Error('createAuditEvent: event is required');
  }

  for (const field of ['tenant_id', 'actor_type', 'action', 'resource_type', 'resource_id', 'metadata']) {
    if (event[field] == null) {
      throw new Error(`createAuditEvent: ${field} is required`);
    }
  }

  if (!ALLOWED_ACTOR_TYPES.has(event.actor_type)) {
    throw new Error(`createAuditEvent: actor_type must be one of user, system, api_key`);
  }

  if (event.actor_type === 'user' && event.actor_id == null) {
    throw new Error('createAuditEvent: actor_id is required when actor_type is user');
  }

  if (event.actor_type !== 'user' && event.actor_id != null) {
    throw new Error(`createAuditEvent: actor_id must be null when actor_type is ${event.actor_type}`);
  }
}

async function createAuditEvent(client, event) {
  validateAuditEvent(event);

  const safeMeta = sanitizeMetadata(event.metadata);

  const result = await client.query(
    'INSERT INTO audit_logs (tenant_id, actor_id, actor_type, action, resource_type, resource_id, metadata) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, tenant_id, actor_id, actor_type, action, resource_type, resource_id, metadata, occurred_at',
    [event.tenant_id, event.actor_id, event.actor_type, event.action, event.resource_type, event.resource_id, safeMeta],
  );
  return result.rows[0];
}

async function listAuditEvents(client, tenantId) {
  const result = await client.query(
    'SELECT * FROM audit_logs WHERE tenant_id = $1 ORDER BY occurred_at DESC',
    [tenantId],
  );
  return result.rows;
}

module.exports = { createAuditEvent, listAuditEvents, sanitizeMetadata };
