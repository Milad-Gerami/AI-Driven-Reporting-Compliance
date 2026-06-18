# Directive: Middleware Architecture

## Status
Approved — all middleware responsibilities, execution order, request context contracts, and bypass rules defined here are the source of truth for middleware implementations in `/api/middleware/`. References `directives/api-contract.md` for route contracts and error shapes, `directives/auth-and-permissions.md` for authentication and authorization logic, `directives/security-baseline.md` for security controls, and `directives/audit-policy.md` for audit-writer behavior.

## Scope
Middleware chain architecture for the Express HTTP server in `/api/`. Defines what each middleware does, what it attaches to the request context, what it rejects, and which endpoints bypass which layers. Does not cover worker-side audit writing (see `directives/worker-lifecycle.md` section 10) or queue-level concerns.

---

## 1. Middleware Execution Order

### Request flow diagram

```
request
  │
  ├─→ request-id
  │     Attach or propagate a unique request identifier.
  │
  ├─→ auth
  │     Validate token. Resolve tenant, user, memberships, permissions.
  │     Reject 401 if invalid, expired, or unresolvable.
  │
  ├─→ tenant-context
  │     Verify tenant is active. SET LOCAL app.current_tenant_id on the DB connection.
  │     Reject 401 if tenant is suspended or offboarded.
  │
  ├─→ authorization
  │     Check agency membership (agency-scoped routes).
  │     Check required permission string (permission-gated routes).
  │     Reject 404/403 as appropriate.
  │
  ├─→ validation
  │     Validate and sanitize path params, query params, request body.
  │     Reject 400/413/422 if invalid.
  │
  ├─→ route-handler
  │     Execute business logic. Prepare audit context on the request.
  │
  ├─→ audit-writer
  │     Write audit log entry within the same database transaction.
  │     COMMIT transaction.
  │
  └─→ response
        Send HTTP response to the client.

error at any step
  └─→ error-handler
        Format error into standard response shape. Send error response.
```

### Registration order in Express

Middleware is registered on the Express app in this exact order:

1. `request-id`
2. `auth`
3. `tenant-context`
4. `authorization`
5. `validation` (route-specific, applied per-route or per-router)
6. Route handlers
7. `audit-writer` (post-handler, pre-commit)
8. `error-handler` (Express error middleware — registered last, signature `(err, req, res, next)`)

Each middleware calls `next()` to pass control to the next layer or `next(err)` to skip to the error handler. A middleware that sends a response (e.g., `res.status(401).json(...)`) must not call `next()`.

### Transaction boundary

The audit-writer and the route handler operate within the same database transaction. The transaction is opened before the route handler executes and committed after the audit-writer completes. If any step between transaction open and commit fails, the entire transaction rolls back — the primary operation is not applied without its audit record. (Source: `directives/audit-policy.md` section 9.)

---

## 2. Request ID Middleware

### Purpose
Assigns a unique identifier to every inbound request for correlation across logs, error responses, and downstream services.

### Behavior

1. Check for an incoming `X-Request-ID` header.
2. If present and the value is a valid UUID, adopt it as `req.requestId`.
3. If absent or invalid, generate a new UUID v4 and set it as `req.requestId`.
4. Set the `X-Request-ID` response header to `req.requestId` on every response.

### Attaches to request context
| Property | Type | Description |
|---|---|---|
| `req.requestId` | `string` (UUID) | Unique identifier for this request |

### Bypass rules
None. Runs on every request, including health endpoints.

### Rejection
Never rejects. This middleware always calls `next()`.

---

## 3. Authentication Middleware

### Purpose
Validates the caller's identity and loads their authorization context from the database. This is the gateway between unauthenticated and authenticated request processing.

### Behavior

Steps are performed in order. Failure at any step results in an immediate `401` response — no further middleware or handler executes.

1. **Extract the token.** Read the JWT or session token from the `Authorization` header (Bearer scheme). If missing, reject `401`.
2. **Validate the token.** Verify signature, expiration (`exp`), and issuer (`iss`). If invalid, reject `401`. (Source: `directives/auth-and-permissions.md` section 1.)
3. **Resolve the tenant.** Map the token's tenant claim to a `tenants` row. If no matching tenant exists, reject `401`.
4. **Resolve the user.** Match the token's `sub` or `email` to a `users` row within the resolved tenant. If no matching user or user status is not `active`, reject `401`. (Source: `directives/auth-and-permissions.md` section 1.)
5. **Load memberships.** Query all `memberships` rows for this user within this tenant, joining `roles` to get each role's `permissions` map. (Source: `directives/auth-and-permissions.md` section 10.)
6. **Flatten permissions.** Iterate over all loaded memberships. For each role's `permissions` map, collect every key where the value is `true` into a deduplicated set. This is the user's effective permission set. (Source: `directives/auth-and-permissions.md` section 10, step 3.)

### Attaches to request context
| Property | Type | Description |
|---|---|---|
| `req.tenantId` | `string` (UUID) | Tenant ID resolved from the token |
| `req.userId` | `string` (UUID) | User ID resolved from the token |
| `req.memberships` | `Array<object>` | Full membership records with joined role data (see schema below) |
| `req.effectivePermissions` | `Set<string>` | Deduplicated union of all permission strings where value is `true` |

#### Membership object shape
```
{
  id: "uuid",
  agency_id: "uuid | null",
  role_id: "uuid",
  role_name: "string",
  permissions: { "permission.string": true/false, ... }
}
```

### Rejection
| Condition | Status | Error Code |
|---|---|---|
| Missing or malformed Authorization header | 401 | `UNAUTHENTICATED` |
| Token signature invalid, expired, or wrong issuer | 401 | `UNAUTHENTICATED` |
| Tenant not found | 401 | `UNAUTHENTICATED` |
| User not found or user status is not `active` | 401 | `UNAUTHENTICATED` |

All `401` responses use the same generic `UNAUTHENTICATED` code. The response must not reveal which step failed — whether the tenant does not exist or the user is disabled is internal information. (Source: `directives/security-baseline.md` section 9 principles applied to error responses.)

### Caching
None. Memberships and permissions are loaded from the database on every request. Cached state could allow a revoked membership or disabled user to retain access between refreshes. (Source: `directives/auth-and-permissions.md` section 10, "Why re-derive on every request.")

---

## 4. Tenant Context Middleware

### Purpose
Activates PostgreSQL row-level security for the authenticated tenant. This is the database-layer enforcement of tenant isolation, independent of application-layer query filters.

### Behavior

1. Read `req.tenantId` set by the auth middleware. If absent, reject `401` (defensive — auth middleware should have already rejected).
2. Verify the tenant's `status` is `active`. If `suspended` or `offboarded`, reject `401`. (Source: `directives/auth-and-permissions.md` section 2.)
3. Execute `SET LOCAL app.current_tenant_id = '<req.tenantId>'` on the database connection. `SET LOCAL` scopes the setting to the current transaction, preventing cross-request leakage on pooled connections. (Source: `directives/security-baseline.md` section 2.)

### Attaches to request context
No new properties. The effect is on the database connection, not the request object. The `SET LOCAL` call activates the RLS policy `tenant_id = current_setting('app.current_tenant_id')::uuid` on all 12 tenant-scoped tables.

### Immutability rule
Once set, the tenant context must not be changed during request processing. No middleware, route handler, or business logic function may call `SET LOCAL` a second time with a different tenant ID. (Source: `directives/auth-and-permissions.md` section 2.)

### Rejection
| Condition | Status | Error Code |
|---|---|---|
| `req.tenantId` missing (defensive) | 401 | `UNAUTHENTICATED` |
| Tenant status is `suspended` or `offboarded` | 401 | `UNAUTHENTICATED` |

---

## 5. Authorization Middleware

### Purpose
Enforces two independent access controls: agency membership (for agency-scoped routes) and permission checks (for permission-gated routes). Both checks use the membership and permission data loaded by the auth middleware.

### Agency membership check

Applies to routes with `:agency_id` in the path (e.g., `/api/v1/agencies/:agency_id/data-sources`).

**Validation order** (Source: `directives/auth-and-permissions.md` section 3):

1. **Verify the agency exists** within the current tenant. If not found, return `404`. This must happen before the access check — a `403` on a nonexistent agency would confirm the agency exists.
2. **Verify the caller has access.** A user has access if they have a `memberships` row where `agency_id` matches the requested agency, OR a `memberships` row where `agency_id IS NULL` (tenant-wide role). If no access, return `403`.

### Permission check

Applies to routes that require a specific permission string (documented per-route in `directives/api-contract.md`).

1. Read the required permission string from route metadata (e.g., `reports.create`).
2. Check whether `req.effectivePermissions` contains that string.
3. If not, return `403`.

### Escalation prevention

For membership management routes (`POST /users/:user_id/memberships`, `DELETE /users/:user_id/memberships/:membership_id`, `PATCH /roles/:role_id`), authorization middleware must also enforce escalation prevention rules. (Source: `directives/auth-and-permissions.md` section 8.)

These checks compare the target role's permissions against the caller's effective permissions. If the target role grants any permission the caller does not hold, reject with `403`.

### Separation of duties

For the report approval transition (`PATCH /agencies/:agency_id/reports/:report_id` with `status: "approved"`), authorization middleware must verify `created_by != req.userId`. If they match, reject with `403` and error code `SEPARATION_OF_DUTIES`. (Source: `directives/auth-and-permissions.md` section 9.)

### Attaches to request context
| Property | Type | Description |
|---|---|---|
| `req.agencyId` | `string` (UUID) or `undefined` | The validated agency ID from the path parameter, if the route is agency-scoped. Only set after the agency is confirmed to exist and the caller has access. |

### Rejection
| Condition | Status | Error Code |
|---|---|---|
| Agency not found within the tenant | 404 | `NOT_FOUND` |
| Caller lacks agency membership | 403 | `FORBIDDEN` |
| Caller lacks required permission | 403 | `FORBIDDEN` |
| Escalation prevention triggered | 403 | `FORBIDDEN` |
| Separation of duties violated | 403 | `SEPARATION_OF_DUTIES` |

---

## 6. Audit Context Middleware (Audit-Writer)

### Purpose
Writes an audit log entry for every successful state-changing operation. Runs after the route handler, within the same database transaction, before the transaction is committed.

### Position in the chain
The audit-writer is the last middleware in the response chain for state-changing operations. It runs after the route handler has completed its work but before the database transaction is committed. (Source: `directives/audit-policy.md` section 9.)

### Behavior

1. **Check for audit context.** Read `req.auditContext` set by the route handler. If absent (GET requests, health checks), skip — call `next()`.
2. **Construct the audit entry.** Combine:
   - From `req.auditContext`: `action`, `resource_type`, `resource_id`, `before`, `after`, and action-specific metadata fields.
   - From auth context: `req.userId` as `actor_id`, `"user"` as `actor_type`, `req.tenantId` as `tenant_id`.
   - From request: `req.ip` as `ip_address`, `req.headers['user-agent']` as `user_agent`, `req.method` as `request_method`, `req.path` as `request_path`.
   - From system: `now()` as `occurred_at`.
3. **Scrub prohibited fields.** Remove any fields from snapshots that must not appear in audit logs (e.g., `auth_provider_id`, raw `connection_config` values, `reports.content`). Replace with safe summaries per `directives/audit-policy.md` sections 6 and 8.
4. **Validate completeness.** Verify all required fields from `directives/audit-policy.md` section 2 are present.
5. **Insert the entry.** Write the row to `audit_logs` within the current transaction.
6. **Commit.** The transaction (covering both the route handler's work and the audit entry) is committed.

### What the route handler must provide

The route handler sets `req.auditContext` with the following shape:

| Field | Required | Description |
|---|---|---|
| `action` | Yes | Action string from `directives/audit-policy.md` section 1 (e.g., `report.approved`) |
| `resource_type` | Yes | Database table name of the affected resource (e.g., `reports`) |
| `resource_id` | Yes | UUID primary key of the affected row |
| `before` | Conditional | Resource state before the change (required for updates and deletes) |
| `after` | Conditional | Resource state after the change (required for creates and updates) |
| Additional fields | Varies | Action-specific metadata (e.g., `status_from`, `status_to`, `target_user_id`) |

### Attaches to request context
No new properties. The audit-writer reads context; it does not write to it.

### Failure behavior
If the audit write fails, the entire transaction rolls back. The primary operation is not applied without its audit record. This is a hard guarantee. (Source: `directives/audit-policy.md` section 9.)

---

## 7. Validation Middleware

### Purpose
Validates and sanitizes all inbound data — path parameters, query parameters, and request bodies — before the route handler executes. Rejects malformed or invalid input before any database operation occurs.

### Implementation location
Validators live in `/api/validators/`. Each route or resource type has its own validator. Validators are applied per-route, not globally. (Source: `directives/security-baseline.md` section 6.)

### Behavior

Validation is applied as route-specific middleware, registered on individual routes or routers. The validation middleware for a given route:

1. **Validate path parameters.** All UUID path params (`:agency_id`, `:user_id`, etc.) must match UUID v4 format. Reject `400` if not.
2. **Validate query parameters.** Enum-like query filters (`?status`, `?source_type`, etc.) are checked against explicit allowlists. Pagination params (`?cursor`, `?limit`) are validated for type and range (limit default 50, max 200).
3. **Validate request body** (POST, PATCH only):
   - String fields: enforce max length (255 for names/titles/slugs, 100 for emails, 1000 for general text), reject null bytes, trim whitespace. (Source: `directives/security-baseline.md` section 6.)
   - Enum fields: check against allowlist. Reject `422` if invalid.
   - JSONB fields: validate as parseable JSON, enforce max payload size (1 MB, reject `413`), apply field-specific structural validation.
   - Foreign key UUIDs in bodies: validate UUID format.
4. **Attach validated data.** Place the sanitized, validated data on `req.validated` for the route handler to consume.

### Attaches to request context
| Property | Type | Description |
|---|---|---|
| `req.validated.params` | `object` | Validated and typed path parameters |
| `req.validated.query` | `object` | Validated and typed query parameters |
| `req.validated.body` | `object` | Validated and sanitized request body (POST/PATCH only) |

### Rejection
| Condition | Status | Error Code |
|---|---|---|
| Malformed UUID in path or body | 400 | `VALIDATION_ERROR` |
| Invalid query parameter value | 400 | `VALIDATION_ERROR` |
| Enum value not in allowlist | 422 | `VALIDATION_ERROR` |
| String exceeds max length | 422 | `VALIDATION_ERROR` |
| String contains null byte | 400 | `VALIDATION_ERROR` |
| JSONB payload exceeds 1 MB | 413 | `PAYLOAD_TOO_LARGE` |
| JSONB structural validation fails | 422 | `VALIDATION_ERROR` |
| Secret pattern detected in `connection_config` | 422 | `SECRET_IN_CONFIG` |

All validation errors include a `details` object with field-level information per the standard error shape in `directives/api-contract.md`.

---

## 8. Error Handling Middleware

### Purpose
Catches any error thrown by upstream middleware or route handlers and formats it into the standard error response shape. This is the last middleware registered on the Express app, using the four-argument Express error signature `(err, req, res, next)`.

### Behavior

1. **Receive the error.** Any middleware or handler that calls `next(err)` or throws an unhandled exception routes here.
2. **Determine the HTTP status.** If the error carries a `status` or `statusCode` property, use it. Otherwise, default to `500`.
3. **Format the response.** Construct the standard error body:

```json
{
  "error": {
    "code": "string",
    "message": "string",
    "details": {}
  }
}
```

(Source: `directives/api-contract.md`, Error Response section.)

4. **Sanitize the message.** For `5xx` errors, replace the error message with a generic string (`"Internal server error"`). Never expose stack traces, connection strings, internal hostnames, or secret material in any error response. (Source: `directives/security-baseline.md` section 3 and section 9.)
5. **Include the request ID.** Add `req.requestId` to the error response so the caller can reference it in support requests and operators can correlate it with server-side logs.
6. **Log the error.** Write the full error (including stack trace) to the application log (stdout/stderr) for debugging. This is application logging, not audit logging — errors that do not result in a state change do not produce audit entries.

### What is never included in error responses
- Stack traces
- Database hostnames, ports, or connection strings
- Secrets manager endpoints
- Internal file paths
- Raw SQL
- Library or dependency version numbers

### Response shape for 5xx errors

```json
{
  "error": {
    "code": "INTERNAL_ERROR",
    "message": "Internal server error",
    "request_id": "uuid"
  }
}
```

### Response shape for known errors (4xx)

```json
{
  "error": {
    "code": "<SPECIFIC_CODE>",
    "message": "<user-safe message>",
    "details": {},
    "request_id": "uuid"
  }
}
```

---

## 9. Request Context Summary

This table shows what data is available on the request object after each middleware completes. Each middleware reads from upstream properties and attaches its own.

| Property | Set By | Type | Available From |
|---|---|---|---|
| `req.requestId` | request-id | `string` (UUID) | All middleware and handlers |
| `req.tenantId` | auth | `string` (UUID) | tenant-context onward |
| `req.userId` | auth | `string` (UUID) | tenant-context onward |
| `req.memberships` | auth | `Array<object>` | authorization onward |
| `req.effectivePermissions` | auth | `Set<string>` | authorization onward |
| `req.agencyId` | authorization | `string` (UUID) or `undefined` | route handler onward (agency-scoped routes only) |
| `req.validated.params` | validation | `object` | route handler onward |
| `req.validated.query` | validation | `object` | route handler onward |
| `req.validated.body` | validation | `object` or `undefined` | route handler onward |
| `req.auditContext` | route handler | `object` or `undefined` | audit-writer |

### Context accumulation diagram

```
request-id:     req.requestId
                    │
auth:           + req.tenantId, req.userId, req.memberships, req.effectivePermissions
                    │
tenant-context: + (database SET LOCAL — no new req properties)
                    │
authorization:  + req.agencyId (agency-scoped routes)
                    │
validation:     + req.validated { params, query, body }
                    │
route-handler:  + req.auditContext { action, resource_type, resource_id, before, after, ... }
                    │
audit-writer:     reads req.auditContext, req.userId, req.tenantId, req.requestId, req.ip, req.headers
```

---

## 10. Endpoint Bypass Rules

Not all endpoints pass through every middleware. Health endpoints are unauthenticated. The `/me` endpoint requires authentication but not a specific permission check. This section defines exactly which middleware layers each endpoint class passes through.

### Bypass matrix

| Middleware | `/health/live` | `/health/ready` | `/me` | All other routes |
|---|---|---|---|---|
| request-id | **Yes** | **Yes** | **Yes** | **Yes** |
| auth | Skip | Skip | **Yes** | **Yes** |
| tenant-context | Skip | Skip | **Yes** | **Yes** |
| authorization | Skip | Skip | Skip | **Yes** |
| validation | Skip | Skip | Skip | **Yes** (route-specific) |
| route handler | **Yes** | **Yes** | **Yes** | **Yes** |
| audit-writer | Skip | Skip | Skip | **Yes** (state-changing only) |
| error-handler | **Yes** | **Yes** | **Yes** | **Yes** |

### GET /api/v1/health/live

- **Passes through:** request-id, route handler, error-handler.
- **Skips:** auth, tenant-context, authorization, validation, audit-writer.
- **Rationale:** Liveness probe for container orchestrators. Must respond with zero authentication overhead and zero I/O. (Source: `directives/api-contract.md`, `/health/live` section.)
- **Security:** Returns only `status`, `version`, and `api`. No dependency information, no internal details. (Source: `directives/security-baseline.md` section 9.)

### GET /api/v1/health/ready

- **Passes through:** request-id, route handler, error-handler.
- **Skips:** auth, tenant-context, authorization, validation, audit-writer.
- **Rationale:** Readiness probe for load balancers. Checks dependency health. Unauthenticated by design — the load balancer does not carry application credentials. (Source: `directives/api-contract.md`, `/health/ready` section.)
- **Security:** Returns named check statuses (`"ok"` / `"error"`) only. Never exposes hostnames, connection strings, error messages, latency, or any detail from `directives/security-baseline.md` section 9's prohibition list.

### GET /api/v1/me

- **Passes through:** request-id, auth, tenant-context, route handler, error-handler.
- **Skips:** authorization (no permission check), validation (no input beyond the token), audit-writer (GET request — not audited).
- **Rationale:** Returns the authenticated caller's profile, memberships, and effective permissions. Authentication alone is sufficient — every authenticated user can call `/me`. (Source: `directives/auth-and-permissions.md` section 10.)
- **Note:** The `/me` endpoint must reflect real-time database state, not cached token claims. The auth middleware's fresh membership query satisfies this requirement.

### Self-access routes

The following routes also have special authorization bypass rules, though they still pass through the authorization middleware:

- `GET /api/v1/users/:user_id` — permitted if `:user_id == req.userId`, regardless of permissions.
- `GET /api/v1/users/:user_id/memberships` — permitted if `:user_id == req.userId`, regardless of permissions.
- `PATCH /api/v1/users/:user_id` — permitted if `:user_id == req.userId`, but only for `display_name` changes.

These self-access rules are evaluated within the authorization middleware as hardcoded checks, not as permission strings. (Source: `directives/auth-and-permissions.md` section 10.)

---

## Design Decisions

### Why separate auth and tenant-context middleware

Authentication (token validation, user resolution) and tenant-context activation (`SET LOCAL`) are logically distinct. Separating them allows:
- Auth to fail fast before any database write operations.
- Tenant-context to be the single place that manages the RLS session variable, making it auditable and testable in isolation.
- Clear attribution of `401` causes: auth failures are identity problems; tenant-context failures are organizational status problems (suspended/offboarded).

### Why authorization combines agency scoping and permission checks

Agency membership and permission checks are both access-control decisions that depend on the same data (`req.memberships`, `req.effectivePermissions`). Combining them into a single middleware avoids redundant membership lookups and keeps the authorization decision in one place.

### Why validation is route-specific, not global

Different routes accept different inputs with different rules. A global validator would either be too permissive (allowing invalid data through) or require complex route-matching logic. Route-specific validators are explicit, testable, and maintainable. They are applied as middleware on individual route definitions.

### Why the audit-writer is middleware, not called by the route handler

Making the audit write a middleware concern (rather than a call inside each handler) guarantees that no handler can accidentally skip the audit trail. The handler's only responsibility is to set `req.auditContext` — the middleware handles the write. If `req.auditContext` is missing on a state-changing route, that is a detectable bug, not a silent audit gap.

### Why request-id never rejects

A missing or malformed `X-Request-ID` is not a client error — it simply means the request did not originate from a system that propagates trace IDs. Generating a new ID is the correct fallback. Rejecting would break health checks from simple load balancers and monitoring probes.
