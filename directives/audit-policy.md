# Directive: Audit Policy

## Status
Approved — all audit logging rules, field requirements, and immutability constraints defined here are the source of truth for the audit-writer middleware in `/api/middleware/`, worker audit logic in `/workers/`, and the `audit_logs` table defined in `directives/data-model.md`.

## Scope
Audit logging policy for a multi-tenant government reporting and compliance platform. Defines what is logged, how it is logged, and the guarantees the system provides about the integrity of the audit trail.

---

## 1. What Actions Must Be Audited

### Mandatory audit events

Every state-changing operation in the system produces an audit log entry. There are no exceptions. The following table lists every auditable action, grouped by resource.

#### Tenant
| Action String | Trigger |
|---|---|
| `tenant.updated` | `PATCH /api/v1/tenant` |

#### Agencies
| Action String | Trigger |
|---|---|
| `agency.created` | `POST /api/v1/agencies` |
| `agency.updated` | `PATCH /api/v1/agencies/:agency_id` |
| `agency.deleted` | `DELETE /api/v1/agencies/:agency_id` |

#### Users
| Action String | Trigger |
|---|---|
| `user.created` | `POST /api/v1/users` |
| `user.updated` | `PATCH /api/v1/users/:user_id` |
| `user.disabled` | `PATCH /api/v1/users/:user_id` when status transitions to `disabled` |
| `user.enabled` | `PATCH /api/v1/users/:user_id` when status transitions to `active` |

`user.disabled` and `user.enabled` are logged in addition to `user.updated` when a status transition occurs. This allows filtering the audit trail for access-control changes without parsing metadata.

#### Roles
| Action String | Trigger |
|---|---|
| `role.created` | `POST /api/v1/roles` |
| `role.updated` | `PATCH /api/v1/roles/:role_id` |
| `role.permissions_changed` | `PATCH /api/v1/roles/:role_id` when `permissions` field is modified |
| `role.deleted` | `DELETE /api/v1/roles/:role_id` |

`role.permissions_changed` is logged in addition to `role.updated` when permissions are modified. This allows filtering for authorization-impacting changes.

#### Memberships
| Action String | Trigger |
|---|---|
| `membership.created` | `POST /api/v1/users/:user_id/memberships` |
| `membership.deleted` | `DELETE /api/v1/users/:user_id/memberships/:membership_id` |

#### Data Sources
| Action String | Trigger |
|---|---|
| `data_source.created` | `POST /api/v1/agencies/:aid/data-sources` |
| `data_source.updated` | `PATCH /api/v1/agencies/:aid/data-sources/:sid` |
| `data_source.deleted` | `DELETE /api/v1/agencies/:aid/data-sources/:sid` |

#### Ingestion Runs
| Action String | Trigger |
|---|---|
| `ingestion_run.created` | Worker creates a new run |
| `ingestion_run.started` | Worker begins execution |
| `ingestion_run.completed` | Worker finishes successfully |
| `ingestion_run.failed` | Worker finishes with error |
| `ingestion_run.retried` | `POST .../ingestion-runs/:rid/retry` |

#### Compliance Runs
| Action String | Trigger |
|---|---|
| `compliance_run.created` | Worker or `POST /api/v1/compliance-runs` |
| `compliance_run.started` | Worker begins evaluation |
| `compliance_run.completed` | Worker finishes successfully |
| `compliance_run.partial_failure` | Worker finishes with some rules errored |
| `compliance_run.failed` | Worker finishes with batch-level error |
| `compliance_run.retried` | `POST /api/v1/compliance-runs/:rid/retry` |

#### Compliance Rules
| Action String | Trigger |
|---|---|
| `compliance_rule.created` | `POST /api/v1/agencies/:aid/compliance-rules` |
| `compliance_rule.updated` | `PATCH /api/v1/agencies/:aid/compliance-rules/:rule_id` |
| `compliance_rule.deactivated` | `PATCH ...` when `is_active` transitions to `false` |
| `compliance_rule.activated` | `PATCH ...` when `is_active` transitions to `true` |
| `compliance_rule.deleted` | `DELETE /api/v1/agencies/:aid/compliance-rules/:rule_id` |

`compliance_rule.deactivated` and `compliance_rule.activated` are logged in addition to `compliance_rule.updated` when the active status changes.

#### Reports
| Action String | Trigger |
|---|---|
| `report.created` | `POST /api/v1/agencies/:aid/reports` |
| `report.updated` | `PATCH /api/v1/agencies/:aid/reports/:rid` |
| `report.status_changed` | `PATCH ...` when `status` field transitions |
| `report.approved` | `PATCH ...` when status transitions to `approved` |
| `report.published` | `PATCH ...` when status transitions to `published` |
| `report.deleted` | `DELETE /api/v1/agencies/:aid/reports/:rid` |

`report.approved` and `report.published` are logged in addition to `report.status_changed`. These are the highest-significance audit events in the system — regulatory reviewers look for them specifically.

#### Report Exports
| Action String | Trigger |
|---|---|
| `report_export.created` | `POST .../reports/:rid/exports` |
| `report_export.downloaded` | `GET .../exports/:eid/download` |

`report_export.downloaded` is an exception to the "only state-changing operations" rule. Downloads are read-only, but they represent data leaving the platform. Government compliance requires tracking who accessed what data and when.

### Actions that are NOT audited

- `GET` requests (except `report_export.downloaded` as noted above).
- Health checks (`/health/live`, `/health/ready`).
- `GET /api/v1/me`.
- Failed authentication attempts (these are logged by the IdP, not the platform).
- Queries to `GET /api/v1/audit-logs` (auditing the audit reader would create an infinite loop with no practical value).

---

## 2. Required Fields

Every audit log entry must contain all of the following fields. No field may be omitted. See `directives/data-model.md` section 13 for the column definitions.

| Field | Requirement |
|---|---|
| `id` | Generated `uuid`. Never reused. |
| `tenant_id` | The tenant in which the action occurred. Always present, even for system-initiated actions. |
| `actor_id` | The `users.id` of the person or null for system actors. See section 4. |
| `actor_type` | One of: `user`, `system`, `api_key`. See section 4. |
| `action` | The action string from the table in section 1. Must match exactly. |
| `resource_type` | The database table name of the affected resource (e.g., `reports`, `compliance_rules`). |
| `resource_id` | The `uuid` primary key of the affected row. For create operations, this is the newly created row's ID. |
| `metadata` | A JSON object containing contextual information. See sections 5 and 6. Never null — use an empty object `{}` if no additional context applies. |
| `occurred_at` | The timestamp when the action was performed. Must be set by the server, never by the client. Uses database `now()` within the transaction. |

---

## 3. Immutability Rules

Audit log rows are write-once. They are never updated, never deleted, and never modified after insertion. This is the foundational guarantee of the audit system.

### Three-layer enforcement

As defined in `directives/data-model.md` section 13, immutability is enforced at three independent layers:

**Layer 1: Application policy.** No code in the application — not in middleware, not in route handlers, not in workers, not in execution logic — may issue an `UPDATE` or `DELETE` statement against the `audit_logs` table. This is a development rule, not a runtime control.

**Layer 2: Database trigger.** A `BEFORE UPDATE OR DELETE` trigger on `audit_logs` raises an exception unconditionally. This catches any application bug that accidentally issues an update or delete.

**Layer 3: Grant restriction.** The application database role has `SELECT` and `INSERT` privileges only on `audit_logs`. No `UPDATE` or `DELETE` grants. This catches any code that bypasses the trigger (e.g., `ALTER TABLE ... DISABLE TRIGGER`).

### Why all three layers

Any single layer can be bypassed:
- Application policy can have bugs.
- Triggers can be disabled by a superuser or during maintenance.
- Grants can be changed by a DBA.

All three failing simultaneously requires a deliberate, multi-step action — which is the definition of tamper-evidence, not tamper-proof. For tamper-proof guarantees, external log shipping (to a write-once store like S3 with Object Lock) is a post-MVP concern.

### No corrections

If an audit log entry contains incorrect data (e.g., a wrong `resource_id` due to a bug), the correct remediation is to insert a new corrective entry with action `audit.correction`, referencing the original entry's ID in metadata. The original entry is never modified.

```json
{
  "action": "audit.correction",
  "resource_type": "audit_logs",
  "resource_id": "<original audit log id>",
  "metadata": {
    "reason": "Original entry referenced wrong resource_id due to bug #123",
    "original_resource_id": "<wrong id>",
    "correct_resource_id": "<right id>"
  }
}
```

---

## 4. User vs. System Actor Handling

### User-initiated actions (`actor_type: "user"`)

Any action triggered by an authenticated API request. The `actor_id` is the `user_id` from the auth context.

Applies to: all API endpoints that require authentication and perform state changes.

### System-initiated actions (`actor_type: "system"`)

Any action triggered by an automated process without a specific user context. The `actor_id` is `null`.

Applies to:
- Worker jobs that create or update ingestion runs.
- Worker jobs that create or update compliance runs and results.
- Worker jobs that generate report content (transition from `generating` to `review`).
- Worker jobs that render report exports.
- Scheduled maintenance tasks.

### API key actions (`actor_type: "api_key"`)

Reserved for future use. When API key authentication is added post-MVP, actions performed via API key will use this actor type. The `actor_id` will be `null`, and the API key identifier will be stored in `metadata.api_key_id`.

### Rules

1. Every audit entry must have a non-null `actor_type`.
2. `actor_id` is null only when `actor_type` is `system` or `api_key`.
3. `actor_id` must not be null when `actor_type` is `user`.
4. The actor must be resolved before the audit entry is written. If the actor cannot be determined, the action must still be logged with `actor_type: "system"` and a `metadata.reason` explaining why the actor is unknown.

---

## 5. Metadata Requirements

The `metadata` field is a JSON object that provides context beyond the fixed columns. Its contents vary by action type, but certain fields are required or conditionally required.

### Always included (API-originated actions)

| Field | Type | Description |
|---|---|---|
| `ip_address` | string | The client's IP address. Taken from the request, accounting for trusted proxy headers. |
| `user_agent` | string | The `User-Agent` header value. |
| `request_method` | string | HTTP method (e.g., `POST`, `PATCH`, `DELETE`). |
| `request_path` | string | The full request path (e.g., `/api/v1/agencies/abc-123/reports/def-456`). |

### Always included (worker-originated actions)

| Field | Type | Description |
|---|---|---|
| `worker_name` | string | Identifier of the worker process (e.g., `ingestion-runner`, `compliance-evaluator`). |
| `job_id` | string | The queue job ID, for correlation with job queue logs. |

### Conditionally included

| Field | When | Description |
|---|---|---|
| `before` | Updates and deletes | Snapshot of the resource before the change. See section 6. |
| `after` | Creates and updates | Snapshot of the resource after the change. See section 6. |
| `status_from` | Status transitions | Previous status value. |
| `status_to` | Status transitions | New status value. |
| `target_user_id` | Membership create/delete | The user whose membership was changed (distinct from the actor). |
| `target_role_id` | Membership create/delete | The role that was assigned or revoked. |
| `target_agency_id` | Membership create/delete | The agency scope of the membership (null for tenant-wide). |
| `triggered_by` | Compliance run create | `automatic`, `manual`, or `retroactive`. |
| `format` | Report export create | `pdf`, `csv`, or `xlsx`. |
| `error_message` | Failed runs | The error message from the failed operation. |
| `separation_of_duties` | Report approval | `true` — confirms the check was performed and passed. |

---

## 6. Before/After Snapshot Rules

### When snapshots are required

| Action Type | `before` | `after` |
|---|---|---|
| Create | Not included | Required |
| Update | Required | Required |
| Delete | Required | Not included |

### What to include in snapshots

Snapshots capture the full row state of the affected resource, as it exists in the database, with the following exceptions:

**Include:**
- All scalar columns (id, name, status, type fields, timestamps, etc.).
- All foreign key references (as UUIDs, not joined data).
- Boolean flags (`is_active`, etc.).
- Enum-like text fields (`status`, `severity`, `source_type`, etc.).

**Exclude:**
- Large `jsonb` content fields. Specifically:
  - `reports.content` — can be megabytes of structured data. Include only `reports.content IS NOT NULL` as a boolean indicator (`"has_content": true`).
  - `compliance_results.details` — can contain thousands of failing record references. Exclude entirely from snapshots; the details are queryable from the results table itself.
- `connection_config` on `data_sources` — may contain non-secret but operationally sensitive configuration (hosts, paths). See section 8. Include a hash or field-count summary instead.

### Snapshot depth

Snapshots are flat — they capture the single affected row, not its relationships. A `report.approved` snapshot includes the report's columns, not the compliance results it references. Relationship context is derivable from the `resource_type` and `resource_id`.

### Diff representation

Snapshots store full state (`before` and `after`), not a diff. Computing what changed is the responsibility of the reader, not the writer. Full-state snapshots are more reliable under concurrent modifications and require no diff algorithm agreement between writer and reader.

---

## 7. Tenant and Agency Scoping Rules

### Tenant scoping

Every audit log entry has a `tenant_id`. This field is set from the request's tenant context (API) or the worker's tenant context (background jobs). Audit logs are tenant-isolated by the same RLS policy as all other tenant-scoped tables.

An audit log entry is always scoped to the tenant where the action occurred. There are no cross-tenant audit entries.

### Agency scoping

The `audit_logs` table does not have an `agency_id` column. Agency context is derived from the referenced resource:

- For agency-scoped resources (data sources, compliance rules, reports, report exports): the agency is determined by following the resource's `agency_id` foreign key.
- For resources without a direct `agency_id` (ingestion runs, compliance runs, compliance results): the agency is determined by following the FK chain to the data source.
- For tenant-scoped resources (tenants, users, roles, memberships, agencies themselves): there is no agency context.

### Querying by agency

When `GET /api/v1/audit-logs?agency_id=<uuid>` is requested, the API must join through the resource to determine agency membership. This is a query-time join, not a stored column. The implementation should:

1. For resources with direct `agency_id`: filter `WHERE resource_type IN ('data_sources', 'compliance_rules', 'reports', 'report_exports') AND resource.agency_id = <requested_agency_id>`.
2. For resources in the ingestion/compliance chain: join through `ingestion_runs → data_sources` to resolve the agency.
3. For tenant-scoped resources: exclude from agency-filtered results (they have no agency).

### Agency-scoped user visibility

As defined in `directives/auth-and-permissions.md` section 3:
- Tenant-wide members see all audit logs (optionally filtered by agency).
- Agency-scoped members see only logs for resources within their agencies. Tenant-scoped resource logs (user created, role changed) are not visible to agency-scoped users.

---

## 8. Events That Must Never Be Logged with Secrets

### The rule

No audit log entry may contain secrets, credentials, tokens, passwords, API keys, or other sensitive authentication material in any field — including `metadata`, `before` snapshots, and `after` snapshots.

### Specific exclusions

| Source | Field | Rule |
|---|---|---|
| `data_sources.connection_config` | `metadata.before.connection_config`, `metadata.after.connection_config` | Never include the raw value. Log a summary instead: `"connection_config_fields": ["host", "port", "path"]` (field names only, no values). |
| `users.auth_provider_id` | `metadata.before.auth_provider_id`, `metadata.after.auth_provider_id` | Exclude entirely. The IdP subject identifier is internal plumbing and carries no audit value. |
| Request headers | `metadata.authorization` | Never log the `Authorization` header or any bearer token. The `ip_address` and `user_agent` are sufficient for request identification. |
| IdP tokens | Anywhere | JWT contents, refresh tokens, and session tokens must never appear in audit logs. The platform doesn't store these, but a bug could accidentally pass one through. Audit-writer middleware must not blindly serialize the request. |

### Enforcement

The audit-writer middleware must construct the `metadata` object explicitly, field by field. It must never serialize the raw request object, raw database row, or raw response into metadata. Explicit construction ensures that only approved fields are included and secrets cannot leak through unexpected object properties.

### If a secret is accidentally logged

This constitutes a security incident. The response is:
1. Rotate the compromised credential immediately.
2. Insert a corrective audit entry (see section 3, "No corrections") documenting the incident.
3. The original entry containing the secret is not deleted (immutability rule), but the incident response process must evaluate whether the audit_logs partition containing the entry needs to be flagged for restricted access.
4. Fix the code path that allowed the secret to be logged.
5. Add a test case to prevent recurrence.

---

## 9. How Audit Logging Relates to API Middleware and Workers

### API middleware: audit-writer

The `audit-writer` middleware in `/api/middleware/` is responsible for logging all API-originated actions. It operates as follows:

**Timing:** The audit-writer runs after the route handler completes successfully, within the same database transaction. If the primary operation fails (rolls back), no audit entry is written. If the primary operation succeeds but the audit write fails, the entire transaction rolls back — the operation is not applied without its audit record.

**Transaction boundary:** The audit write and the primary operation share a single database transaction. This guarantees atomicity: it is impossible for an action to succeed without its corresponding audit entry, or for an audit entry to exist without its corresponding action having completed.

**Middleware position:** The audit-writer is the last middleware in the response chain, after the route handler has committed its work to the transaction but before the transaction is committed to the database. The sequence is:

```
Request → auth → tenant-context → agency-scope → permissions → route handler → audit-writer → COMMIT
```

If any step fails, the transaction rolls back and no audit entry is written.

**What the middleware receives:** The route handler must place an audit context object on the request, containing:
- `action` — the action string
- `resource_type` — the table name
- `resource_id` — the affected row's UUID
- `before` — the resource state before the change (for updates and deletes)
- `after` — the resource state after the change (for creates and updates)
- Any additional metadata fields specific to the action

The audit-writer middleware then combines this with request-level fields (`ip_address`, `user_agent`, `request_method`, `request_path`) and the auth context (`actor_id`, `actor_type`, `tenant_id`) to construct the complete `audit_logs` row.

### Workers: inline audit writes

Workers in `/workers/` do not use the API middleware chain. They write audit entries directly using execution logic in `/execution/logic/`.

**Transaction boundary:** Same rule as API — the audit write and the primary operation share a single database transaction. A compliance run status update and its audit entry are committed atomically.

**Actor context:** Workers set `actor_type: "system"` and `actor_id: null`. They include `worker_name` and `job_id` in metadata for traceability.

**Tenant context:** Workers must set `app.current_tenant_id` via `SET LOCAL` before writing audit entries, just as API middleware does. Workers that process multiple tenants (e.g., a scheduled sweep) must set the correct tenant context for each tenant's operations.

### Shared audit-writing function

Both the API middleware and workers use the same underlying function in `/execution/logic/` to construct and insert audit entries. This function:

1. Validates that all required fields are present.
2. Validates that `metadata` does not contain prohibited fields (see section 8).
3. Scrubs snapshot fields against the exclusion list.
4. Inserts the row into `audit_logs`.

The function does not commit the transaction — the caller (middleware or worker) controls the transaction boundary. This ensures the audit write is always atomic with the primary operation.

### What is NOT the audit-writer's responsibility

- **Authentication logging.** Failed logins, token refresh, and session management are the IdP's responsibility.
- **Read access logging.** GET requests are not audited (except `report_export.downloaded`).
- **Performance monitoring.** Request latency, error rates, and throughput belong in the metrics pipeline, not the audit trail.
- **Debug logging.** Application-level debug/info/warning logs are a separate concern, written to stdout/stderr and collected by the logging infrastructure. They are not audit events.
