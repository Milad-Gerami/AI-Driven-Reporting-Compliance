# Directive: MVP REST API Contract

## Status
Approved — all routes, request/response shapes, and authorization rules defined here are the source of truth for route handlers in `/api/routes/`, middleware in `/api/middleware/`, and validators in `/api/validators/`.

## Scope
45-endpoint REST API for a multi-tenant government reporting and compliance platform. Backed by the schema defined in `directives/data-model.md`.

---

## Conventions

### Base URL

All endpoints are prefixed with `/api/v1`.

### Authentication

Every request except health endpoints requires an authenticated session. Authentication is resolved by middleware from a JWT or session token. The middleware extracts `tenant_id` and `user_id` from the auth context and makes them available to all downstream handlers.

### Tenant Scoping

Every authenticated request is scoped to a single tenant. The tenant is derived from the auth context, never from a query parameter or request body. Middleware sets `app.current_tenant_id` via `SET LOCAL` on the database connection so RLS enforces isolation at the database level.

### Agency Scoping

Routes that include `:agency_id` in the path require the caller to have a `memberships` record granting access to that agency. Middleware validates this before the route handler executes. Users with a tenant-wide membership (null `agency_id` in memberships) bypass agency checks.

### Pagination

All list endpoints accept cursor-based pagination:

- `?cursor=<opaque string>` — position from a previous response
- `?limit=<integer>` — page size (default 50, max 200)

Response envelope for all list endpoints:

```json
{
  "data": [],
  "pagination": {
    "next_cursor": "string | null",
    "has_more": true
  }
}
```

### Timestamps

All `_at` fields in responses are ISO 8601 UTC strings (e.g., `2026-06-15T14:30:00Z`).

### Error Response

All error responses use a consistent shape:

```json
{
  "error": {
    "code": "string",
    "message": "string",
    "details": {}
  }
}
```

- `code` is a machine-readable identifier (e.g., `VALIDATION_ERROR`, `NOT_FOUND`, `FORBIDDEN`).
- `message` is a human-readable explanation safe to display to end users.
- `details` is an optional object with field-level validation errors or additional context.

### HTTP Status Codes

| Code | Usage |
|---|---|
| 200 | Success (GET, PATCH) |
| 201 | Created (POST) |
| 204 | No content (DELETE) |
| 400 | Malformed request |
| 401 | Not authenticated |
| 403 | Authenticated but insufficient permissions |
| 404 | Resource not found (within tenant scope) |
| 409 | Conflict (duplicate, dependency exists, invalid state transition) |
| 422 | Validation failed (well-formed request but invalid content) |
| 429 | Rate limited |
| 503 | Service unavailable (readiness check failure) |

### Audit Logging

All state-changing operations (POST, PATCH, DELETE) write to the `audit_logs` table via middleware. No endpoint skips the audit trail. The audit write happens after the primary operation succeeds, within the same transaction.

---

## Infrastructure Endpoints

These endpoints are unauthenticated and exist for operational use by load balancers, orchestrators, and deployment tooling.

### GET /api/v1/health/live

**Purpose:** Liveness probe. Confirms the process is running and can accept TCP connections. No dependency checks. Used by the container orchestrator to decide whether to restart the process.

**Auth:** None.

**Response (always 200 if the process is alive):**

```json
{
  "status": "ok",
  "version": "0.1.0",
  "api": "v1"
}
```

**Performance requirement:** Returns in under 5ms with zero I/O.

**Security:** Must not expose internal hostnames, dependency versions, error messages, build timestamps, environment names, or git SHAs.

---

### GET /api/v1/health/ready

**Purpose:** Readiness probe. Confirms the process can serve real requests by checking critical dependencies. Used by the load balancer to decide whether to route traffic to this instance.

**Auth:** None.

**Response (200 when ready, 503 when not):**

```json
{
  "status": "ok | degraded | error",
  "version": "0.1.0",
  "api": "v1",
  "checks": {
    "database": "ok | error",
    "secrets_manager": "ok | error"
  }
}
```

- `ok` — all dependencies reachable.
- `degraded` — non-critical dependency down, most requests can still be served.
- `error` — critical dependency unreachable, instance should be pulled from the pool.

**Security:** The `checks` object reports status only, never connection strings, hostnames, error messages, or latency measurements. Diagnostic telemetry belongs in the metrics pipeline, not in an unauthenticated HTTP response.

---

## Session Endpoint

### GET /api/v1/me

**Purpose:** Returns the authenticated caller's profile, resolved memberships, and effective permissions. This is the endpoint the frontend calls on page load to determine identity, agency access, and UI guards.

**Auth:** Required. Resolved from session/token only — no user ID parameter.

**Rate limit:** 60 requests/minute per session.

**Response (200):**

```json
{
  "id": "uuid",
  "email": "string",
  "display_name": "string | null",
  "status": "active",
  "tenant": {
    "id": "uuid",
    "name": "string",
    "slug": "string"
  },
  "memberships": [
    {
      "id": "uuid",
      "agency_id": "uuid | null",
      "agency_name": "string | null",
      "role_id": "uuid",
      "role_name": "string"
    }
  ],
  "permissions": [
    "reports.create",
    "reports.read",
    "compliance_results.read"
  ]
}
```

**`permissions`** is the flattened, deduplicated union of all permissions across all of the user's roles. The frontend uses this for UI guards. The backend never trusts these — it re-derives permissions on each request from the database.

**What is excluded:** `auth_provider_id` (internal plumbing), `created_at` (not relevant to current session context).

**Security:** Must reflect real-time state from the database, not cached JWT claims. If a user is disabled or a membership is revoked between token refreshes, this endpoint must return the current truth.

---

## Resource Endpoints

### Tenant

#### GET /api/v1/tenant

| | |
|---|---|
| **Purpose** | Get the current tenant's profile |
| **Scope** | Tenant (from auth context) |
| **Auth** | Any authenticated user |

**Response (200):**

```json
{
  "id": "uuid",
  "name": "string",
  "slug": "string",
  "status": "active | suspended | offboarded",
  "created_at": "iso8601",
  "updated_at": "iso8601"
}
```

#### PATCH /api/v1/tenant

| | |
|---|---|
| **Purpose** | Update tenant profile |
| **Scope** | Tenant |
| **Auth** | `tenant.admin` permission |

**Request:**

```json
{
  "name": "string?",
  "slug": "string?"
}
```

**Response (200):** Updated tenant object.

**No POST or DELETE.** Tenant provisioning and offboarding happen through internal tooling, not the public API.

---

### Agencies

#### GET /api/v1/agencies

| | |
|---|---|
| **Purpose** | List agencies in the current tenant |
| **Scope** | Tenant |
| **Auth** | Any authenticated user. Non-admin users see only agencies they have memberships in. |
| **Query params** | `?cursor`, `?limit` |

**Response (200):** Paginated list.

```json
{
  "data": [
    {
      "id": "uuid",
      "name": "string",
      "code": "string | null",
      "created_at": "iso8601"
    }
  ],
  "pagination": {}
}
```

#### POST /api/v1/agencies

| | |
|---|---|
| **Purpose** | Create an agency |
| **Scope** | Tenant |
| **Auth** | `agencies.create` permission |

**Request:**

```json
{
  "name": "string",
  "code": "string?"
}
```

**Response (201):** Created agency object.

#### GET /api/v1/agencies/:agency_id

| | |
|---|---|
| **Purpose** | Get a single agency |
| **Scope** | Tenant + agency membership |
| **Auth** | Any user with a membership in this agency, or tenant-admin |

**Response (200):** Agency object.

#### PATCH /api/v1/agencies/:agency_id

| | |
|---|---|
| **Purpose** | Update agency name or code |
| **Scope** | Tenant + agency |
| **Auth** | `agencies.update` permission |

**Request:**

```json
{
  "name": "string?",
  "code": "string?"
}
```

**Response (200):** Updated agency object.

#### DELETE /api/v1/agencies/:agency_id

| | |
|---|---|
| **Purpose** | Remove an agency |
| **Scope** | Tenant |
| **Auth** | `agencies.delete` permission |

**Response (204).**

**Conflict:** Returns `409` if the agency has active data sources, compliance rules, or reports. No cascading deletes in MVP. Dependents must be removed or reassigned first.

---

### Users

#### GET /api/v1/users

| | |
|---|---|
| **Purpose** | List users in the tenant |
| **Scope** | Tenant |
| **Auth** | `users.list` permission |
| **Query params** | `?status=active\|disabled`, `?cursor`, `?limit` |

**Response (200):** Paginated list.

```json
{
  "data": [
    {
      "id": "uuid",
      "email": "string",
      "display_name": "string | null",
      "status": "active | disabled",
      "created_at": "iso8601"
    }
  ],
  "pagination": {}
}
```

#### POST /api/v1/users

| | |
|---|---|
| **Purpose** | Create or invite a user |
| **Scope** | Tenant |
| **Auth** | `users.create` permission |

**Request:**

```json
{
  "email": "string",
  "display_name": "string?",
  "auth_provider_id": "string?"
}
```

**Response (201):** Created user object. Does not include memberships — those are assigned separately.

#### GET /api/v1/users/:user_id

| | |
|---|---|
| **Purpose** | Get user detail including memberships |
| **Scope** | Tenant |
| **Auth** | `users.read` permission, or the user themselves |

**Response (200):**

```json
{
  "id": "uuid",
  "email": "string",
  "display_name": "string | null",
  "status": "active | disabled",
  "created_at": "iso8601",
  "memberships": [
    {
      "id": "uuid",
      "agency_id": "uuid | null",
      "agency_name": "string | null",
      "role_id": "uuid",
      "role_name": "string"
    }
  ]
}
```

#### PATCH /api/v1/users/:user_id

| | |
|---|---|
| **Purpose** | Update user profile or status |
| **Scope** | Tenant |
| **Auth** | `users.update` permission for status changes; the user themselves for `display_name` only |

**Request:**

```json
{
  "display_name": "string?",
  "status": "active | disabled?"
}
```

**Response (200):** Updated user object.

---

### Roles

#### GET /api/v1/roles

| | |
|---|---|
| **Purpose** | List all roles in the tenant |
| **Scope** | Tenant |
| **Auth** | Any authenticated user |

**Response (200):** Paginated list.

```json
{
  "data": [
    {
      "id": "uuid",
      "name": "string",
      "permissions": {},
      "created_at": "iso8601"
    }
  ],
  "pagination": {}
}
```

#### POST /api/v1/roles

| | |
|---|---|
| **Purpose** | Create a custom role |
| **Scope** | Tenant |
| **Auth** | `roles.create` permission |

**Request:**

```json
{
  "name": "string",
  "permissions": {
    "reports.create": true,
    "reports.approve": false
  }
}
```

**Response (201):** Created role object.

#### PATCH /api/v1/roles/:role_id

| | |
|---|---|
| **Purpose** | Update role name or permissions |
| **Scope** | Tenant |
| **Auth** | `roles.update` permission |

**Request:**

```json
{
  "name": "string?",
  "permissions": "{}?"
}
```

**Response (200):** Updated role object.

**Note:** Changing permissions takes effect immediately for all users holding this role.

#### DELETE /api/v1/roles/:role_id

| | |
|---|---|
| **Purpose** | Delete a role |
| **Scope** | Tenant |
| **Auth** | `roles.delete` permission |

**Response (204).**

**Conflict:** Returns `409` if any memberships reference this role. Reassign users to a different role first.

---

### Memberships

Managed as a sub-resource of users.

#### GET /api/v1/users/:user_id/memberships

| | |
|---|---|
| **Purpose** | List all role assignments for a user |
| **Scope** | Tenant |
| **Auth** | `memberships.read` permission, or the user themselves |

**Response (200):**

```json
{
  "data": [
    {
      "id": "uuid",
      "agency_id": "uuid | null",
      "agency_name": "string | null",
      "role_id": "uuid",
      "role_name": "string",
      "created_at": "iso8601"
    }
  ]
}
```

#### POST /api/v1/users/:user_id/memberships

| | |
|---|---|
| **Purpose** | Assign a role to a user, optionally scoped to an agency |
| **Scope** | Tenant |
| **Auth** | `memberships.create` permission |

**Request:**

```json
{
  "role_id": "uuid",
  "agency_id": "uuid | null"
}
```

**Response (201):** Created membership object.

**Conflict:** Returns `409` if the exact `(user_id, agency_id, role_id)` tuple already exists.

**Escalation prevention:** The caller cannot assign a role whose permissions exceed their own. The API compares the target role's permissions against the caller's effective permissions and rejects with `403` if the target role grants anything the caller does not hold.

#### DELETE /api/v1/users/:user_id/memberships/:membership_id

| | |
|---|---|
| **Purpose** | Revoke a role assignment |
| **Scope** | Tenant |
| **Auth** | `memberships.delete` permission |

**Response (204).**

**Escalation prevention:** The caller cannot revoke a role whose permissions exceed their own.

---

### Data Sources

#### GET /api/v1/agencies/:agency_id/data-sources

| | |
|---|---|
| **Purpose** | List data sources for an agency |
| **Scope** | Tenant + agency |
| **Auth** | Agency membership with `data_sources.read` |
| **Query params** | `?status=active\|disabled\|error`, `?source_type=api\|sftp\|database\|file_upload`, `?cursor`, `?limit` |

**Response (200):** Paginated list.

```json
{
  "data": [
    {
      "id": "uuid",
      "name": "string",
      "source_type": "api | sftp | database | file_upload",
      "status": "active | disabled | error",
      "connection_config": {},
      "created_at": "iso8601"
    }
  ],
  "pagination": {}
}
```

#### POST /api/v1/agencies/:agency_id/data-sources

| | |
|---|---|
| **Purpose** | Register a new data source |
| **Scope** | Tenant + agency |
| **Auth** | `data_sources.create` |

**Request:**

```json
{
  "name": "string",
  "source_type": "api | sftp | database | file_upload",
  "connection_config": {}
}
```

**Response (201):** Created data source object.

**Validation:** `connection_config` is rejected with `422` if it contains fields matching known secret patterns (`password`, `secret`, `token`, `key`, `credential`). Secrets must be stored in the external secrets manager and referenced by key name only.

#### GET /api/v1/agencies/:agency_id/data-sources/:source_id

| | |
|---|---|
| **Purpose** | Get data source detail |
| **Scope** | Tenant + agency |
| **Auth** | `data_sources.read` |

**Response (200):** Data source object.

#### PATCH /api/v1/agencies/:agency_id/data-sources/:source_id

| | |
|---|---|
| **Purpose** | Update configuration or status |
| **Scope** | Tenant + agency |
| **Auth** | `data_sources.update` |

**Request:**

```json
{
  "name": "string?",
  "connection_config": "{}?",
  "status": "active | disabled?"
}
```

**Response (200):** Updated data source object.

#### DELETE /api/v1/agencies/:agency_id/data-sources/:source_id

| | |
|---|---|
| **Purpose** | Remove a data source |
| **Scope** | Tenant + agency |
| **Auth** | `data_sources.delete` |

**Response (204).**

**Conflict:** Returns `409` if active or pending ingestion runs reference this source. Disable the source and wait for runs to complete before deleting.

---

### Ingestion Runs

Read-only from the API. Created by worker jobs in `/workers/`.

#### GET /api/v1/agencies/:agency_id/data-sources/:source_id/ingestion-runs

| | |
|---|---|
| **Purpose** | List ingestion runs for a data source |
| **Scope** | Tenant + agency |
| **Auth** | `ingestion_runs.read` |
| **Query params** | `?status=pending\|running\|success\|failed`, `?cursor`, `?limit` |

**Response (200):** Paginated list, ordered by `created_at DESC`.

```json
{
  "data": [
    {
      "id": "uuid",
      "status": "pending | running | success | failed",
      "records_fetched": 4520,
      "error_message": "string | null",
      "started_at": "iso8601 | null",
      "completed_at": "iso8601 | null",
      "created_at": "iso8601"
    }
  ],
  "pagination": {}
}
```

#### GET /api/v1/agencies/:agency_id/data-sources/:source_id/ingestion-runs/:run_id

| | |
|---|---|
| **Purpose** | Get detail for a single ingestion run |
| **Scope** | Tenant + agency |
| **Auth** | `ingestion_runs.read` |

**Response (200):** Ingestion run object.

#### POST /api/v1/agencies/:agency_id/data-sources/:source_id/ingestion-runs/:run_id/retry

| | |
|---|---|
| **Purpose** | Queue a retry for a failed ingestion run |
| **Scope** | Tenant + agency |
| **Auth** | `ingestion_runs.retry` |

**Request:** Empty body.

**Response (201):** New ingestion run object (new `id`, status `pending`).

**Conflict:** Returns `409` if the source run is not in `failed` status.

---

### Compliance Runs

Primarily created by workers after ingestion completes. Can also be triggered manually via the API.

#### GET /api/v1/compliance-runs

| | |
|---|---|
| **Purpose** | List compliance runs across the tenant |
| **Scope** | Tenant. Non-admin users see only runs linked to agencies they have memberships in. |
| **Auth** | `compliance_runs.read` |
| **Query params** | `?agency_id`, `?status=pending\|running\|success\|partial_failure\|failed`, `?triggered_by=automatic\|manual\|retroactive`, `?cursor`, `?limit` |

**Response (200):** Paginated list, ordered by `created_at DESC`.

```json
{
  "data": [
    {
      "id": "uuid",
      "ingestion_run_id": "uuid",
      "status": "pending | running | success | partial_failure | failed",
      "rules_evaluated": 48,
      "rules_passed": 45,
      "rules_failed": 3,
      "error_message": "string | null",
      "triggered_by": "automatic | manual | retroactive",
      "started_at": "iso8601 | null",
      "completed_at": "iso8601 | null",
      "created_at": "iso8601"
    }
  ],
  "pagination": {}
}
```

**Routing note:** Compliance runs are a flat route (`/api/v1/compliance-runs`) rather than nested under agencies because they span agencies — a tenant-admin views runs cross-agency. Agency filtering is done via query parameter, not URL path.

#### GET /api/v1/compliance-runs/:run_id

| | |
|---|---|
| **Purpose** | Get a single compliance run with ingestion context |
| **Scope** | Tenant (agency-checked via ingestion run lineage) |
| **Auth** | `compliance_runs.read` |

**Response (200):**

```json
{
  "id": "uuid",
  "ingestion_run": {
    "id": "uuid",
    "data_source_id": "uuid",
    "data_source_name": "string",
    "agency_id": "uuid",
    "agency_name": "string"
  },
  "status": "pending | running | success | partial_failure | failed",
  "rules_evaluated": 48,
  "rules_passed": 45,
  "rules_failed": 3,
  "error_message": "string | null",
  "triggered_by": "automatic | manual | retroactive",
  "started_at": "iso8601",
  "completed_at": "iso8601",
  "created_at": "iso8601"
}
```

#### POST /api/v1/compliance-runs

| | |
|---|---|
| **Purpose** | Manually trigger a compliance evaluation against an existing ingestion run |
| **Scope** | Tenant |
| **Auth** | `compliance_runs.trigger` |

**Request:**

```json
{
  "ingestion_run_id": "uuid"
}
```

**Response (201):** New compliance run (status `pending`, triggered_by `manual`).

**Validation:** Returns `422` if the referenced ingestion run's status is not `success`. Only successfully completed ingestion data can be evaluated.

#### POST /api/v1/compliance-runs/:run_id/retry

| | |
|---|---|
| **Purpose** | Retry a failed or partially failed compliance run |
| **Scope** | Tenant |
| **Auth** | `compliance_runs.trigger` |

**Request:** Empty body.

**Response (201):** New compliance run (new `id`, triggered_by `manual`).

**Conflict:** Returns `409` if the source run is not in `failed` or `partial_failure` status.

---

### Compliance Results

Read-only. Written by execution logic during a compliance run.

#### GET /api/v1/compliance-runs/:run_id/results

| | |
|---|---|
| **Purpose** | List all results for a compliance run |
| **Scope** | Tenant (agency-checked via run lineage) |
| **Auth** | `compliance_results.read` |
| **Query params** | `?status=pass\|fail\|error\|skipped`, `?cursor`, `?limit` |

**Response (200):** Paginated list.

```json
{
  "data": [
    {
      "id": "uuid",
      "compliance_rule_id": "uuid",
      "rule_name": "string",
      "severity": "critical | high | medium | low",
      "status": "pass | fail | error | skipped",
      "details": {},
      "evaluated_at": "iso8601"
    }
  ],
  "pagination": {}
}
```

**Note:** `rule_name` and `severity` are denormalized from `compliance_rules` into the response (not the database) for display convenience. The source of truth is the `compliance_rules` table via `compliance_rule_id`.

#### GET /api/v1/compliance-runs/:run_id/results/:result_id

| | |
|---|---|
| **Purpose** | Get full detail for a single result |
| **Scope** | Tenant |
| **Auth** | `compliance_results.read` |

**Response (200):** Result object with full `details` payload (failing records, counts, evidence).

#### GET /api/v1/compliance-results/summary

| | |
|---|---|
| **Purpose** | Aggregate compliance health across the tenant or a specific agency |
| **Scope** | Tenant |
| **Auth** | `compliance_results.read` |
| **Query params** | `?agency_id`, `?since=iso8601` (defaults to 30 days) |

**Response (200):**

```json
{
  "total_runs": 124,
  "total_pass": 5800,
  "total_fail": 212,
  "total_error": 15,
  "by_severity": {
    "critical": { "pass": 500, "fail": 12 },
    "high": { "pass": 2100, "fail": 89 },
    "medium": { "pass": 2400, "fail": 78 },
    "low": { "pass": 800, "fail": 33 }
  },
  "since": "iso8601"
}
```

This is a computed endpoint backed by an indexed query on `compliance_results` joined through `compliance_runs`. It is not a direct table read.

---

### Compliance Rules

#### GET /api/v1/agencies/:agency_id/compliance-rules

| | |
|---|---|
| **Purpose** | List compliance rules for an agency |
| **Scope** | Tenant + agency |
| **Auth** | `compliance_rules.read` |
| **Query params** | `?is_active=true\|false`, `?severity=critical\|high\|medium\|low`, `?rule_type=threshold\|presence\|format\|custom_sql`, `?cursor`, `?limit` |

**Response (200):** Paginated list.

```json
{
  "data": [
    {
      "id": "uuid",
      "name": "string",
      "rule_type": "threshold | presence | format | custom_sql",
      "severity": "critical | high | medium | low",
      "is_active": true,
      "definition": {},
      "created_at": "iso8601",
      "updated_at": "iso8601"
    }
  ],
  "pagination": {}
}
```

#### POST /api/v1/agencies/:agency_id/compliance-rules

| | |
|---|---|
| **Purpose** | Create a compliance rule |
| **Scope** | Tenant + agency |
| **Auth** | `compliance_rules.create` |

**Request:**

```json
{
  "name": "string",
  "rule_type": "threshold | presence | format | custom_sql",
  "severity": "critical | high | medium | low",
  "definition": {}
}
```

**Response (201):** Created rule object.

**Validation:** If `rule_type` is `custom_sql`, the `definition.sql` field is validated to ensure it is read-only (`SELECT` only, no DDL/DML). Returns `422` if the SQL fails validation.

#### GET /api/v1/agencies/:agency_id/compliance-rules/:rule_id

| | |
|---|---|
| **Purpose** | Get rule detail |
| **Scope** | Tenant + agency |
| **Auth** | `compliance_rules.read` |

**Response (200):** Rule object.

#### PATCH /api/v1/agencies/:agency_id/compliance-rules/:rule_id

| | |
|---|---|
| **Purpose** | Update rule definition, severity, or active status |
| **Scope** | Tenant + agency |
| **Auth** | `compliance_rules.update` |

**Request:**

```json
{
  "name": "string?",
  "rule_type": "threshold | presence | format | custom_sql?",
  "severity": "critical | high | medium | low?",
  "definition": "{}?",
  "is_active": "boolean?"
}
```

**Response (200):** Updated rule object.

#### DELETE /api/v1/agencies/:agency_id/compliance-rules/:rule_id

| | |
|---|---|
| **Purpose** | Delete a compliance rule |
| **Scope** | Tenant + agency |
| **Auth** | `compliance_rules.delete` |

**Response (204).**

**Referential behavior:** Historical `compliance_results` referencing this rule are retained (FK is not cascaded). The rule is hard-deleted and will not appear in future evaluations. Existing results keep the `compliance_rule_id` for audit purposes.

---

### Reports

#### GET /api/v1/agencies/:agency_id/reports

| | |
|---|---|
| **Purpose** | List reports for an agency |
| **Scope** | Tenant + agency |
| **Auth** | `reports.read` |
| **Query params** | `?status=draft\|generating\|review\|approved\|published`, `?report_type=quarterly\|annual\|ad_hoc\|audit_response`, `?cursor`, `?limit` |

**Response (200):** Paginated list. The `content` field is excluded from list responses because it is potentially large.

```json
{
  "data": [
    {
      "id": "uuid",
      "title": "string",
      "report_type": "quarterly | annual | ad_hoc | audit_response",
      "status": "draft | generating | review | approved | published",
      "created_by": { "id": "uuid", "display_name": "string" },
      "approved_by": null,
      "created_at": "iso8601",
      "updated_at": "iso8601"
    }
  ],
  "pagination": {}
}
```

#### POST /api/v1/agencies/:agency_id/reports

| | |
|---|---|
| **Purpose** | Create a new report |
| **Scope** | Tenant + agency |
| **Auth** | `reports.create` |

**Request:**

```json
{
  "title": "string",
  "report_type": "quarterly | annual | ad_hoc | audit_response",
  "parameters": {
    "date_from": "iso8601",
    "date_to": "iso8601",
    "rule_ids": ["uuid"],
    "include_passing": false
  }
}
```

**Response (201):** Report object with status `generating`.

**Behavior:** Report content is built asynchronously by a worker in `/workers/`. The client polls the GET endpoint to check status or waits for a future webhook notification (post-MVP).

#### GET /api/v1/agencies/:agency_id/reports/:report_id

| | |
|---|---|
| **Purpose** | Get full report including content |
| **Scope** | Tenant + agency |
| **Auth** | `reports.read` |

**Response (200):** Full report object with `content` and `parameters` fields.

#### PATCH /api/v1/agencies/:agency_id/reports/:report_id

| | |
|---|---|
| **Purpose** | Update report title or advance status |
| **Scope** | Tenant + agency |
| **Auth** | `reports.update` for title; `reports.approve` for approval transition; `reports.publish` for publish transition |

**Request:**

```json
{
  "title": "string?",
  "status": "review | approved | published?"
}
```

**Response (200):** Updated report object.

**Status transition rules (enforced server-side):**

```
draft → generating → review → approved → published
                       ↘ draft (rejection)
```

- Only `reports.approve` permission can transition to `approved`.
- Only `reports.publish` permission can transition to `published`.
- The `approved_by` field is set automatically when status moves to `approved`.

**Separation of duties:** The user who created the report (`created_by`) cannot be the user who approves it. The API rejects the transition with `403` if `created_by == current_user`.

#### DELETE /api/v1/agencies/:agency_id/reports/:report_id

| | |
|---|---|
| **Purpose** | Delete a report |
| **Scope** | Tenant + agency |
| **Auth** | `reports.delete` |

**Response (204).**

**Conflict:** Returns `409` if report status is `approved` or `published`. Published and approved reports are immutable for audit purposes. Only `draft`, `generating`, or `review` reports can be deleted.

---

### Report Exports

#### GET /api/v1/agencies/:agency_id/reports/:report_id/exports

| | |
|---|---|
| **Purpose** | List exports for a report |
| **Scope** | Tenant + agency |
| **Auth** | `report_exports.read` |

**Response (200):**

```json
{
  "data": [
    {
      "id": "uuid",
      "format": "pdf | csv | xlsx",
      "file_size_bytes": 284102,
      "exported_by": { "id": "uuid", "display_name": "string" },
      "created_at": "iso8601"
    }
  ]
}
```

**Note:** `storage_path` is never included in API responses.

#### POST /api/v1/agencies/:agency_id/reports/:report_id/exports

| | |
|---|---|
| **Purpose** | Generate a new export |
| **Scope** | Tenant + agency |
| **Auth** | `report_exports.create` |

**Request:**

```json
{
  "format": "pdf | csv | xlsx"
}
```

**Response (201):** Created export object.

**Validation:** Returns `422` if the report status is `draft` or `generating`. Only reports in `review`, `approved`, or `published` status can be exported.

#### GET /api/v1/agencies/:agency_id/reports/:report_id/exports/:export_id/download

| | |
|---|---|
| **Purpose** | Get a time-limited download URL |
| **Scope** | Tenant + agency |
| **Auth** | `report_exports.read` |

**Response (200):**

```json
{
  "download_url": "string",
  "expires_at": "iso8601"
}
```

The `download_url` is a presigned S3/GCS URL generated at request time with a 5-minute TTL. The internal `storage_path` is never exposed to the client.

---

### Audit Logs

Strictly read-only. Written internally by middleware on all state-changing operations.

#### GET /api/v1/audit-logs

| | |
|---|---|
| **Purpose** | Query the audit trail for the tenant |
| **Scope** | Tenant. Agency-scoped users see only logs for resources within their agencies. |
| **Auth** | `audit_logs.read` (typically auditor and admin roles only) |
| **Query params** | `?agency_id`, `?actor_id`, `?action`, `?resource_type`, `?resource_id`, `?since=iso8601`, `?until=iso8601`, `?cursor`, `?limit` |

**Response (200):** Paginated list, ordered by `occurred_at DESC`.

```json
{
  "data": [
    {
      "id": "uuid",
      "actor_id": "uuid | null",
      "actor_type": "user | system | api_key",
      "actor_display_name": "string | null",
      "action": "report.approved",
      "resource_type": "reports",
      "resource_id": "uuid",
      "metadata": {},
      "occurred_at": "iso8601"
    }
  ],
  "pagination": {}
}
```

#### GET /api/v1/audit-logs/:log_id

| | |
|---|---|
| **Purpose** | Get a single audit log entry with full metadata |
| **Scope** | Tenant |
| **Auth** | `audit_logs.read` |

**Response (200):** Full log entry. The `metadata` field may include before/after snapshots of the affected resource.

**No POST, PATCH, or DELETE.** Audit logs are append-only and immutable. They are written by internal middleware, never by API consumers. See `directives/data-model.md` section 13 for the three-layer immutability enforcement.

---

## Route Map

```
GET    /api/v1/health/live
GET    /api/v1/health/ready
GET    /api/v1/me

GET    /api/v1/tenant
PATCH  /api/v1/tenant

GET    /api/v1/agencies
POST   /api/v1/agencies
GET    /api/v1/agencies/:agency_id
PATCH  /api/v1/agencies/:agency_id
DELETE /api/v1/agencies/:agency_id

GET    /api/v1/users
POST   /api/v1/users
GET    /api/v1/users/:user_id
PATCH  /api/v1/users/:user_id

GET    /api/v1/roles
POST   /api/v1/roles
PATCH  /api/v1/roles/:role_id
DELETE /api/v1/roles/:role_id

GET    /api/v1/users/:user_id/memberships
POST   /api/v1/users/:user_id/memberships
DELETE /api/v1/users/:user_id/memberships/:membership_id

GET    /api/v1/agencies/:aid/data-sources
POST   /api/v1/agencies/:aid/data-sources
GET    /api/v1/agencies/:aid/data-sources/:sid
PATCH  /api/v1/agencies/:aid/data-sources/:sid
DELETE /api/v1/agencies/:aid/data-sources/:sid

GET    /api/v1/agencies/:aid/data-sources/:sid/ingestion-runs
GET    /api/v1/agencies/:aid/data-sources/:sid/ingestion-runs/:rid
POST   /api/v1/agencies/:aid/data-sources/:sid/ingestion-runs/:rid/retry

GET    /api/v1/compliance-runs
GET    /api/v1/compliance-runs/:rid
POST   /api/v1/compliance-runs
POST   /api/v1/compliance-runs/:rid/retry

GET    /api/v1/compliance-runs/:rid/results
GET    /api/v1/compliance-runs/:rid/results/:result_id
GET    /api/v1/compliance-results/summary

GET    /api/v1/agencies/:aid/compliance-rules
POST   /api/v1/agencies/:aid/compliance-rules
GET    /api/v1/agencies/:aid/compliance-rules/:rule_id
PATCH  /api/v1/agencies/:aid/compliance-rules/:rule_id
DELETE /api/v1/agencies/:aid/compliance-rules/:rule_id

GET    /api/v1/agencies/:aid/reports
POST   /api/v1/agencies/:aid/reports
GET    /api/v1/agencies/:aid/reports/:rid
PATCH  /api/v1/agencies/:aid/reports/:rid
DELETE /api/v1/agencies/:aid/reports/:rid

GET    /api/v1/agencies/:aid/reports/:rid/exports
POST   /api/v1/agencies/:aid/reports/:rid/exports
GET    /api/v1/agencies/:aid/reports/:rid/exports/:eid/download

GET    /api/v1/audit-logs
GET    /api/v1/audit-logs/:log_id
```

**Total: 45 endpoints.**

---

## Authorization Matrix

| Permission | Typical Roles | Notes |
|---|---|---|
| `tenant.admin` | Tenant Admin | Bypasses agency scoping |
| `agencies.create` | Tenant Admin | |
| `agencies.update` | Tenant Admin | |
| `agencies.delete` | Tenant Admin | |
| `users.list` | Tenant Admin, Agency Admin | |
| `users.read` | Tenant Admin, Agency Admin | Users can always read themselves |
| `users.create` | Tenant Admin, Agency Admin | |
| `users.update` | Tenant Admin, Agency Admin | Users can update own `display_name` |
| `roles.create` | Tenant Admin | |
| `roles.update` | Tenant Admin | |
| `roles.delete` | Tenant Admin | |
| `memberships.read` | Tenant Admin, Agency Admin | Users can read own memberships |
| `memberships.create` | Tenant Admin, Agency Admin | Subject to escalation prevention |
| `memberships.delete` | Tenant Admin, Agency Admin | Subject to escalation prevention |
| `data_sources.read` | Agency Admin, Analyst | |
| `data_sources.create` | Agency Admin, Analyst | |
| `data_sources.update` | Agency Admin, Analyst | |
| `data_sources.delete` | Agency Admin | |
| `ingestion_runs.read` | Agency Admin, Analyst | |
| `ingestion_runs.retry` | Agency Admin, Analyst | |
| `compliance_runs.read` | Agency Admin, Analyst, Auditor | |
| `compliance_runs.trigger` | Agency Admin, Analyst | |
| `compliance_rules.read` | Agency Admin, Analyst, Auditor | |
| `compliance_rules.create` | Agency Admin, Analyst | |
| `compliance_rules.update` | Agency Admin, Analyst | |
| `compliance_rules.delete` | Agency Admin | |
| `compliance_results.read` | All roles | |
| `reports.read` | All roles | |
| `reports.create` | Analyst, Agency Admin | |
| `reports.update` | Analyst, Agency Admin | |
| `reports.approve` | Agency Admin | Cannot be same user as `created_by` |
| `reports.publish` | Tenant Admin | |
| `reports.delete` | Agency Admin | Only non-approved/non-published |
| `report_exports.read` | Analyst, Agency Admin, Auditor | |
| `report_exports.create` | Analyst, Agency Admin, Auditor | |
| `audit_logs.read` | Auditor, Tenant Admin | |

---

## Design Decisions

### Nested vs. flat routes
Agency-scoped resources (`data-sources`, `compliance-rules`, `reports`) are nested under `/agencies/:agency_id` so the agency context is explicit in the URL and validated by middleware before the handler runs. `compliance-runs`, `compliance-results/summary`, and `audit-logs` are flat because they span agencies — a tenant-admin views them cross-agency with optional `?agency_id` filtering.

### No bulk endpoints in MVP
Bulk create/update adds complexity to validation, error reporting, and audit logging. Individual endpoints with client-side parallelism are sufficient at MVP scale.

### No webhooks in MVP
Report generation and ingestion runs are asynchronous, but MVP clients poll using GET endpoints with status filters. Webhooks are a post-MVP addition once latency requirements are understood.

### No file upload endpoint in MVP
`data_sources` with `source_type: file_upload` are registered through the standard CRUD endpoints. The actual file upload mechanism (presigned URL, multipart, or streaming) is a post-MVP concern that depends on infrastructure decisions (S3 direct upload vs. API proxy).

### storage_path never exposed
Report exports return a presigned download URL via the `/download` sub-resource. The internal storage path is never included in any API response, preventing clients from constructing or guessing paths to other tenants' files.
