# Directive: Security Baseline

## Status
Approved — all security requirements defined here are the source of truth for implementation across `/api/`, `/workers/`, `/execution/`, and `/config/`. Where this directive references a rule already documented in another directive, it cites the source and adds only the security-specific enforcement detail.

## Scope
Minimum security controls for a multi-tenant government reporting and compliance platform at MVP. Covers tenant isolation, database security, secret management, input validation, rate limiting, and test safety.

---

## 1. Tenant Isolation Requirements

Tenant isolation is the single most critical security property of the platform. A failure in tenant isolation — one tenant reading, modifying, or even detecting another tenant's data — is a severity-1 incident with regulatory consequences.

### Defense in depth

Tenant isolation is enforced at four independent layers. All four must be present. No single layer is sufficient on its own.

**Layer 1: Authentication.** The tenant is derived from the JWT/session token claim. A user can only authenticate into one tenant. There is no mechanism to switch tenants within a session. (Source: `directives/auth-and-permissions.md` section 1.)

**Layer 2: Application code.** Every database query includes `WHERE tenant_id = <current_tenant_id>`. This is the primary runtime control. (Source: `directives/data-model.md` conventions.)

**Layer 3: Row-Level Security.** PostgreSQL RLS policies on all 12 tenant-scoped tables enforce `tenant_id = current_setting('app.current_tenant_id')::uuid`. This catches any application-layer query that omits the tenant filter. (Source: `directives/data-model.md` RLS strategy.)

**Layer 4: Object storage path.** Export files are stored under `exports/<tenant_id>/...`. Bucket policies restrict the application role to paths matching the current tenant. This prevents cross-tenant file access even if a `storage_path` is guessed or leaked. (Source: `directives/worker-lifecycle.md` section 6.)

### What must never happen

- A query that does not include `tenant_id` in its `WHERE` clause (except queries on the `tenants` table itself).
- A `SET LOCAL app.current_tenant_id` call with a tenant ID that does not match the authenticated session.
- A response that includes a `resource_id` belonging to a different tenant.
- An object storage operation that reads or writes outside the current tenant's path prefix.
- A queue job payload missing `tenant_id`.

### Testing requirement

Every database query function in `/execution/logic/` must have a test that verifies tenant isolation: insert data for two tenants, set the RLS context to tenant A, and confirm that tenant B's data is not returned.

---

## 2. PostgreSQL RLS Requirements

### Enabling RLS

RLS must be enabled on all 12 tenant-scoped tables (every table except `tenants`). The migration that enables RLS must also set `FORCE ROW LEVEL SECURITY` on each table, ensuring RLS applies even to the table owner.

### Policy definition

A single policy per table for MVP:

```sql
CREATE POLICY tenant_isolation ON <table>
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);
```

`USING` controls reads (SELECT) and existing-row checks for UPDATE/DELETE. `WITH CHECK` controls writes (INSERT and the new-row check for UPDATE). Together they guarantee that a connection can only see and create rows for its own tenant.

### Session variable

The application must call `SET LOCAL app.current_tenant_id = '<uuid>'` at the start of every transaction. `SET LOCAL` scopes the setting to the current transaction, so it does not leak between requests on a pooled connection.

### What happens if the session variable is not set

If `app.current_tenant_id` is not set, `current_setting('app.current_tenant_id')` raises an error (when `missing_ok` is false, which is the default). This is the desired behavior — a missing tenant context must cause a hard failure, not a silent bypass.

### Application database role

As defined in `directives/data-model.md`:
- `SELECT`, `INSERT`, `UPDATE`, `DELETE` on all tables except `audit_logs`.
- `SELECT`, `INSERT` only on `audit_logs`.
- No `TRUNCATE`, `DROP`, or DDL privileges.
- `FORCE ROW LEVEL SECURITY` enabled.

The application must never connect as a superuser or a role that bypasses RLS.

### Connection pooling

If using a connection pooler (PgBouncer, pgpool), the pooler must be configured in transaction mode (not session mode). `SET LOCAL` only works correctly in transaction mode — in session mode, the setting persists across transactions and could leak between tenants.

---

## 3. Secret Handling Rules

### Secrets never in the database

No table in the schema stores credentials, API keys, tokens, passwords, or private keys. The `data_sources.connection_config` field stores non-secret configuration only (hostnames, ports, paths, schedules). Secrets are stored in an external secrets manager (AWS Secrets Manager, HashiCorp Vault, Azure Key Vault, or equivalent) and referenced by key name.

### Secrets never in code

No source file in the repository may contain hardcoded credentials, tokens, API keys, or passwords. This includes:
- No secrets in `/config/` files. Environment variable names are defined; values come from the deployment environment.
- No secrets in `/execution/seeds/`. Seed data may reference test credential key names but not actual credential values.
- No secrets in test fixtures. Tests use mock values or local-only credentials that do not work outside the test environment.

### Secrets never in logs

As defined in `directives/audit-policy.md` section 8, audit log entries must never contain secrets. This extends to all application logging:
- No secrets in stdout/stderr logs.
- No secrets in error messages stored on database rows (`error_message` fields).
- No secrets in job queue payloads.
- No secrets in HTTP responses (including error responses).

### Secrets never in version control

The `.gitignore` must exclude:
- `.env` files (all variants: `.env`, `.env.local`, `.env.production`).
- Any file matching `*credentials*`, `*secret*`, `*.pem`, `*.key` patterns.
- The `/tmp` directory contents.

### Secret rotation

The platform must not cache secrets in memory beyond a single use. When a secret is needed (e.g., connecting to an external data source), it is fetched from the secrets manager, used, and discarded. This ensures that secret rotation takes effect immediately without restarting the application.

---

## 4. Data Source Credential Rules

### API validation on write

When `POST` or `PATCH` is called on `/api/v1/agencies/:aid/data-sources`, the `connection_config` field is validated against a blocklist of known secret field names. If any key in the JSON object matches the following patterns (case-insensitive), the request is rejected with `422`:

- `password`
- `secret`
- `token`
- `key` (when it appears to be a credential, not a dictionary key)
- `credential`
- `api_key`
- `apikey`
- `access_key`
- `private_key`
- `client_secret`
- `auth`

### Validation applies recursively

The blocklist check applies to all keys at all nesting levels in the `connection_config` object. A secret nested inside `{ "sftp": { "password": "..." } }` must be caught just as `{ "password": "..." }` would be.

### What is allowed in connection_config

- Hostnames, IP addresses, ports.
- File paths, directory paths, URL paths.
- Database names, schema names, table names.
- Schedule expressions (cron strings).
- Non-secret configuration flags (timeout values, batch sizes).
- Secret manager key references (e.g., `{ "credential_ref": "vault://data-source/sftp-prod" }`).

### How credentials reach workers

When a worker needs to connect to an external data source:
1. Read `connection_config` from the `data_sources` row for non-secret config.
2. Read the `credential_ref` value from `connection_config`.
3. Fetch the actual credential from the secrets manager using the reference.
4. Use the credential for the connection.
5. Do not persist the credential in any database field, log, or audit entry.

---

## 5. Presigned Export URL Rules

### Generation

When `GET .../exports/:export_id/download` is called, the API generates a presigned URL for the file in object storage. The presigned URL is the only way clients access export files.

### Time-to-live

Presigned URLs have a 5-minute TTL. After expiration, the URL returns a `403` from the object storage provider. The client must call the download endpoint again for a fresh URL.

### What is never exposed

- The internal `storage_path` column value is never included in any API response.
- The object storage bucket name is never included in any API response.
- The object storage access credentials are never included in the presigned URL response (they are embedded in the URL signature by the storage SDK, not visible as plaintext).

### Path structure

Export files are stored at: `exports/<tenant_id>/<report_id>/<export_id>.<format>`

The `tenant_id` prefix ensures:
- Even if a presigned URL leaks, it only grants access to one specific file in one specific tenant's namespace.
- Bucket policies can restrict the application role to `exports/<tenant_id>/*` matching the authenticated tenant.

### Presigned URL for the correct tenant only

The API must verify that the export's parent report belongs to the current tenant before generating a presigned URL. RLS provides this check at the database layer, but the application should also verify explicitly to fail fast with a clear error rather than a confusing storage error.

---

## 6. Input Validation Requirements

### Validation layer

All input validation happens in `/api/validators/`. Validators run before the route handler. If validation fails, the request is rejected with `400` or `422` before any database operation occurs.

### General rules

**All string inputs:**
- Maximum length enforced (default: 1000 characters for general text, 255 for names/titles/slugs, 100 for email addresses).
- No null bytes (`\0`). Reject the request if any string field contains a null byte.
- Trimmed of leading/trailing whitespace before storage.

**All UUID inputs (path parameters, foreign keys in request bodies):**
- Must match the UUID v4 format. Reject with `400` if not a valid UUID.
- Never interpolated into SQL strings. Always passed as parameterized query values.

**All enum-like text fields (status, source_type, rule_type, severity, format, report_type, actor_type, triggered_by):**
- Validated against an explicit allowlist of permitted values. Reject with `422` if the value is not in the list.

**All jsonb fields (permissions, definition, parameters, connection_config, content, metadata):**
- Maximum payload size enforced (default: 1 MB). Reject with `413` if exceeded.
- Parsed and validated as valid JSON before storage.
- Specific structural validation per field (see below).

### Field-specific validation

| Field | Validation |
|---|---|
| `tenants.slug` | Lowercase alphanumeric and hyphens only. 3–63 characters. Must start with a letter. Must match `^[a-z][a-z0-9-]{2,62}$`. |
| `users.email` | Must be a syntactically valid email address. Validated against RFC 5322 simplified rules (not a full RFC parser). Must be case-insensitively unique within the tenant. |
| `roles.permissions` | Keys must match the pattern `^[a-z_]+\.[a-z_]+$`. Values must be boolean. Unknown permission keys are rejected (only the 36 defined permission strings are allowed). |
| `compliance_rules.definition` | Structural validation depends on `rule_type`. See section 8 for `custom_sql` restrictions. Other rule types validated by their respective evaluation functions. |
| `reports.parameters` | `date_from` and `date_to` must be valid ISO 8601 dates. `date_from` must be before `date_to`. `rule_ids` must be an array of valid UUIDs (or omitted). `include_passing` must be boolean. |
| `data_sources.connection_config` | Secret-pattern blocklist (section 4). Maximum nesting depth of 5 levels. |

### SQL injection prevention

All database queries use parameterized statements. String concatenation or template interpolation is never used to build SQL. This is a hard rule with no exceptions.

The only place where dynamic SQL exists is the `custom_sql` rule evaluator, which is sandboxed (see section 8).

### XSS prevention

The API returns JSON responses only. It does not render HTML. However, all string values stored in the database are treated as untrusted. If a future frontend renders these values, it must escape them. The API does not pre-escape or sanitize for HTML — that is the rendering layer's responsibility.

---

## 7. Rate Limiting Targets

Rate limiting protects the platform from abuse, runaway clients, and accidental denial of service. Limits are enforced at the API layer (in `/api/middleware/`).

### Per-session limits

| Endpoint Pattern | Limit | Window |
|---|---|---|
| `GET /api/v1/me` | 60 requests | 1 minute |
| All other `GET` endpoints | 300 requests | 1 minute |
| All `POST/PATCH/DELETE` endpoints | 60 requests | 1 minute |
| `POST .../compliance-runs` (trigger) | 10 requests | 1 minute |
| `POST .../exports` | 10 requests | 1 minute |
| `POST .../retry` (any resource) | 10 requests | 1 minute |

### Per-tenant limits

Per-tenant limits protect against one tenant's users collectively overwhelming the system.

| Endpoint Pattern | Limit | Window |
|---|---|---|
| All `GET` endpoints (tenant aggregate) | 3000 requests | 1 minute |
| All `POST/PATCH/DELETE` endpoints (tenant aggregate) | 600 requests | 1 minute |
| `POST .../compliance-runs` (tenant aggregate) | 30 requests | 1 minute |

### Global limits

| Endpoint Pattern | Limit | Window |
|---|---|---|
| `GET /api/v1/health/live` | 600 requests | 1 minute |
| `GET /api/v1/health/ready` | 120 requests | 1 minute |

Health endpoints have global limits (not per-session, since they are unauthenticated) to prevent external scanners from using them as a DoS vector.

### Response on limit exceeded

```
HTTP 429 Too Many Requests
Retry-After: <seconds until reset>
```

```json
{
  "error": {
    "code": "RATE_LIMITED",
    "message": "Too many requests. Try again in <N> seconds.",
    "details": {
      "retry_after": 15
    }
  }
}
```

### What is NOT rate-limited

- Worker jobs. Workers operate on internal queues, not HTTP. Queue throughput is managed by worker concurrency configuration, not rate limiting.
- Database queries from within the application. Rate limiting is an edge concern, not an internal concern.

---

## 8. custom_sql Restrictions

The `custom_sql` rule type allows tenants to define compliance rules using SQL queries. This is the highest-risk feature in the platform because it accepts user-provided SQL and executes it against the database.

### Write-time validation

When a compliance rule with `rule_type = 'custom_sql'` is created or updated via the API, the `definition.sql` field must pass all of the following checks before the rule is stored:

**1. Read-only enforcement.** The SQL must begin with `SELECT` (after stripping leading whitespace and comments). The following keywords are prohibited anywhere in the statement:
- `INSERT`, `UPDATE`, `DELETE`, `DROP`, `ALTER`, `CREATE`, `TRUNCATE`, `GRANT`, `REVOKE`
- `COPY`, `EXECUTE`, `CALL`
- `SET` (prevents `SET LOCAL` manipulation)
- `DO` (prevents anonymous code blocks)

**2. No multiple statements.** The SQL must contain exactly one statement. Semicolons are prohibited (except inside string literals, which the parser must handle).

**3. No function calls that cause side effects.** The following functions are prohibited:
- `pg_sleep` (DoS vector)
- `pg_terminate_backend`, `pg_cancel_backend` (process manipulation)
- `lo_import`, `lo_export` (file system access)
- `pg_read_file`, `pg_read_binary_file` (file system access)
- `dblink`, `dblink_exec` (remote execution)
- `pg_notify` (channel manipulation)

**4. Maximum query length.** 10,000 characters. Reject longer queries with `422`.

### Execution-time controls

When the compliance evaluator worker executes a `custom_sql` rule:

**1. Dedicated read-only role.** The query is executed using a separate database role (`app_custom_sql_reader`) that has:
- `SELECT` only on tenant-scoped tables used for compliance data.
- No `INSERT`, `UPDATE`, `DELETE`, `TRUNCATE`, or DDL on any table.
- No access to system catalogs beyond `pg_catalog` basics.
- RLS applies — the query runs within the current tenant's RLS context.

**2. Statement timeout.** The query has a `statement_timeout` of 30 seconds. Queries exceeding this are terminated by PostgreSQL and the rule result is set to `error`.

**3. Row limit.** The query is wrapped: `SELECT * FROM (<user_sql>) AS q LIMIT 10001`. If more than 10,000 rows are returned, the rule result is set to `error` with a message indicating the result set exceeded the maximum.

**4. No transaction control.** The query runs within the existing transaction. It cannot issue `BEGIN`, `COMMIT`, `ROLLBACK`, or `SAVEPOINT`.

### What custom_sql can access

The custom SQL query can read any table that the `app_custom_sql_reader` role has `SELECT` on, subject to RLS. This includes:
- Ingested data in staging tables.
- `compliance_rules`, `compliance_results`, `compliance_runs`, `ingestion_runs`, `data_sources` (for cross-referencing).

It cannot access:
- `users`, `roles`, `memberships` (authorization data).
- `audit_logs` (audit trail).
- `tenants` (tenant metadata).
- `reports`, `report_exports` (output data).
- System tables beyond `pg_catalog`.

---

## 9. Health Endpoint Exposure Limits

### What health endpoints may expose

| Field | `/health/live` | `/health/ready` |
|---|---|---|
| `status` ("ok") | Yes | Yes |
| `version` (semver) | Yes | Yes |
| `api` ("v1") | Yes | Yes |
| Dependency status ("ok"/"error") | No | Yes (named checks only) |

### What health endpoints must never expose

| Information | Reason |
|---|---|
| Database hostname or IP | Enables targeted attacks against the database |
| Database port or connection string | Same as above |
| Secrets manager endpoint | Reveals infrastructure topology |
| Dependency library versions | Maps to known CVEs |
| Full Git SHA or commit hash | Maps the git history timeline |
| Build timestamp | Narrows the window for vulnerability correlation |
| Environment name ("production", "staging") | Confirms the attacker is hitting the right target |
| Error messages or stack traces | Reveals internal implementation details |
| Connection pool statistics | Reveals capacity and potential DoS thresholds |
| Request latency measurements | Belongs in the metrics pipeline, not a public endpoint |
| Number of tenants or users | Business intelligence leakage |

### Why this matters

Health endpoints are unauthenticated and predictable (`/api/v1/health/live` is the first path an attacker probes). Every piece of information they return is handed to an unauthenticated caller for free. The response must be the absolute minimum needed by load balancers and orchestrators — nothing more.

---

## 10. Security Rules for Tests

### Test isolation

Tests must never connect to production databases, production secrets managers, production object storage, or any production service. This is enforced by:
- Test configuration using environment variables that point to local or test-specific resources.
- No production credentials available in the development or CI environment (stated in `CLAUDE.md` Assumptions).

### Test database

Integration tests use a dedicated test database. The test database:
- Has the same schema as production (applied via the same migrations).
- Has RLS enabled and enforced (tests verify RLS behavior, not bypass it).
- Is wiped between test suites (not between individual tests, for performance).
- Runs on localhost or in a CI-specific container. Never shares a host with production.

### Test secrets

Tests that need credentials for external services use:
- Mock servers (preferred). The test starts a local HTTP server that mimics the external API.
- Fixture credentials that are clearly fake (`test-api-key-do-not-use`, `password: test123`). These must not work against any real system.
- Environment variables prefixed with `TEST_` to distinguish them from production variables.

### What tests must verify

Security-relevant test coverage requirements:

| Requirement | Test Type | Description |
|---|---|---|
| Tenant isolation | Integration | Insert data for tenant A and tenant B. Set RLS context to A. Verify B's data is not returned by any query function. |
| RLS enforcement | Integration | Attempt a query without setting `app.current_tenant_id`. Verify it raises an error, not an empty result. |
| Agency scoping | Unit | Call an agency-scoped route handler with a user who lacks membership in the target agency. Verify `403`. |
| Permission enforcement | Unit | For each permission-gated endpoint, call it with a user who lacks the required permission. Verify `403`. |
| Escalation prevention | Unit | Attempt to assign a role with higher permissions than the caller. Verify `403`. |
| Separation of duties | Unit | Attempt to approve a report where `created_by == current_user`. Verify `403`. |
| Secret blocklist | Unit | Submit a `connection_config` containing each blocklisted key. Verify `422` for each. |
| custom_sql validation | Unit | Submit SQL containing each prohibited keyword. Verify `422` for each. |
| custom_sql timeout | Integration | Submit a SQL rule containing `pg_sleep(60)` or equivalent. Verify the query is terminated within the statement timeout. |
| Presigned URL scoping | Integration | Verify that a presigned URL is generated only for exports belonging to the authenticated tenant. |
| Input length limits | Unit | Submit strings exceeding maximum length for each field. Verify `400` or `422`. |
| UUID format validation | Unit | Submit malformed UUIDs in path parameters and request bodies. Verify `400`. |
| Audit log immutability | Integration | Attempt `UPDATE` and `DELETE` on `audit_logs`. Verify both are rejected by the trigger and/or grants. |
| Error message sanitization | Unit | Trigger worker failures. Verify that `error_message` fields do not contain stack traces, connection strings, or credentials. |
| Rate limiting | Integration | Exceed the rate limit for an endpoint. Verify `429` response with correct `Retry-After`. |

### Tests must not

- Disable RLS for convenience. If a test needs to insert data for a different tenant, it must set the correct tenant context first.
- Use a superuser database role. Tests must use the same restricted application role that production uses.
- Skip permission checks to "simplify" test setup. If a test needs a user with specific permissions, create the role and membership in the test fixture.
- Introduce real credentials into test fixtures or CI configuration.
- Leave test data in any shared database after the test suite completes.
