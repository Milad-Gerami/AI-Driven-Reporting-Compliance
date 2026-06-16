# Directive: Authentication and Permissions

## Status
Approved — all authentication rules, permission strings, role definitions, and authorization logic defined here are the source of truth for middleware in `/api/middleware/` and seed data in `/execution/seeds/`.

## Scope
Authorization model for a multi-tenant government reporting and compliance platform. References the schema in `directives/data-model.md` and the route contracts in `directives/api-contract.md`.

---

## 1. Authentication Assumptions

### Identity provider
The platform does not manage passwords or authentication flows directly. Authentication is delegated to an external identity provider (Entra ID, Okta, Auth0, or equivalent). The IdP issues a JWT or session token upon successful login.

### What the IdP provides
The auth token contains at minimum:
- `sub` — the IdP subject identifier, stored as `auth_provider_id` on the `users` table
- `email` — used to match the user to a `users` row within the tenant
- `tenant` — a claim or hint identifying which tenant the user belongs to (format depends on IdP configuration)

### What the platform resolves
Auth middleware performs these steps on every authenticated request:

1. **Validate the token.** Verify signature, expiration, and issuer. Reject with `401` if invalid.
2. **Resolve the tenant.** Map the token's tenant claim to a `tenants` row. Reject with `401` if no matching tenant or tenant status is not `active`.
3. **Resolve the user.** Match the token's `sub` or `email` to a `users` row within the resolved tenant. Reject with `401` if no matching user or user status is not `active`.
4. **Load memberships.** Query all `memberships` rows for this user within this tenant, joining `roles` to get permission maps.
5. **Set database context.** Execute `SET LOCAL app.current_tenant_id = '<tenant_id>'` on the database connection so RLS enforces tenant isolation for the duration of the transaction.
6. **Populate request context.** Make `tenant_id`, `user_id`, `memberships`, and `effective_permissions` available to all downstream middleware and route handlers.

### What the platform never does
- Never stores passwords, password hashes, or authentication secrets.
- Never issues its own JWTs or session tokens (the IdP does this).
- Never caches resolved user/membership state between requests. Every request re-queries the database. This ensures that disabled users and revoked memberships take effect immediately, not at next token refresh.

### Unauthenticated endpoints
Only two endpoints skip authentication entirely:
- `GET /api/v1/health/live`
- `GET /api/v1/health/ready`

Every other endpoint requires a valid authenticated session.

---

## 2. Tenant Context Rules

### One tenant per request
Every authenticated request operates within exactly one tenant. There is no cross-tenant query path in the MVP. The tenant is derived from the auth token, never from a query parameter, request body, or URL path.

### RLS enforcement
After resolving the tenant, middleware sets `app.current_tenant_id` via `SET LOCAL` on the database connection. This activates the row-level security policy defined in `directives/data-model.md`:

```
USING  (tenant_id = current_setting('app.current_tenant_id')::uuid)
WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid)
```

This is a defense-in-depth measure. Application code also filters by `tenant_id` in every query, but RLS guarantees isolation even if application code has a bug.

### Suspended tenants
If the tenant's `status` is `suspended` or `offboarded`, all requests are rejected with `401`. There is no read-only mode for suspended tenants in MVP.

### Tenant context is immutable within a request
Once set, the tenant context cannot be changed during request processing. No middleware, handler, or business logic function may call `SET LOCAL` a second time with a different tenant ID.

---

## 3. Agency Membership Rules

### Agency-scoped routes
Routes that include `:agency_id` in the path (e.g., `/api/v1/agencies/:agency_id/data-sources`) require the caller to have access to that agency. Middleware checks this before the route handler executes.

### How agency access is determined
A user has access to an agency if any of these conditions are true:

1. **Direct membership.** The user has a `memberships` row where `agency_id` matches the requested agency.
2. **Tenant-wide membership.** The user has a `memberships` row where `agency_id` is `NULL`. A null agency means the role applies to all agencies in the tenant.

### Agency filtering on list endpoints
For list endpoints that span agencies (e.g., `GET /api/v1/compliance-runs`, `GET /api/v1/audit-logs`):

- **Tenant-wide members** see all records across all agencies (optionally filtered by `?agency_id`).
- **Agency-scoped members** see only records belonging to agencies they have memberships in. The query is filtered automatically — the user does not need to pass `?agency_id`, and passing an unauthorized `?agency_id` returns an empty list (not `403`).

### Agency validation order
1. Verify the agency exists within the current tenant (return `404` if not).
2. Verify the caller has access to the agency (return `403` if not).
3. Proceed to the route handler.

This order prevents information leakage: a `403` on an unknown agency would confirm the agency exists.

---

## 4. Role and Membership Model

### Roles
A role is a named set of permissions defined at the tenant level. Roles are stored in the `roles` table with a `permissions` jsonb field containing a flat map of permission strings to booleans.

```json
{
  "reports.create": true,
  "reports.read": true,
  "reports.approve": false,
  "compliance_results.read": true
}
```

Only `true` values grant a permission. `false` or absent keys mean the permission is not granted. There is no explicit deny — absence is denial.

### Memberships
A membership associates a user with a role, optionally scoped to an agency:

- `user_id` — who
- `role_id` — what permissions
- `agency_id` — where (null = tenant-wide)

A user can have multiple memberships:
- The same role in different agencies.
- Different roles in the same agency.
- A tenant-wide role plus agency-specific roles.

### Permission accumulation
Permissions are additive across all of a user's memberships. If any membership grants a permission, the user has that permission. There is no subtraction or override.

Example: A user with `analyst` in Agency A and `auditor` in Agency B holds the union of both roles' permissions. When accessing Agency A, they have the analyst permissions. When accessing Agency B, they have the auditor permissions. When accessing a tenant-wide endpoint, they have both.

---

## 5. Permission Strings

All permission strings follow the pattern `resource.action`. The complete set for MVP:

### Tenant administration
| Permission | Controls |
|---|---|
| `tenant.admin` | Update tenant profile; bypasses agency scoping |

### Agency management
| Permission | Controls |
|---|---|
| `agencies.create` | Create agencies |
| `agencies.update` | Update agency name/code |
| `agencies.delete` | Delete agencies |

### User management
| Permission | Controls |
|---|---|
| `users.list` | List all users in the tenant |
| `users.read` | View user detail and memberships |
| `users.create` | Create or invite users |
| `users.update` | Update user profile and status |

### Role management
| Permission | Controls |
|---|---|
| `roles.create` | Create custom roles |
| `roles.update` | Update role name/permissions |
| `roles.delete` | Delete roles |

### Membership management
| Permission | Controls |
|---|---|
| `memberships.read` | View user role assignments |
| `memberships.create` | Assign roles to users |
| `memberships.delete` | Revoke role assignments |

### Data sources
| Permission | Controls |
|---|---|
| `data_sources.read` | View data source configuration |
| `data_sources.create` | Register new data sources |
| `data_sources.update` | Update data source config/status |
| `data_sources.delete` | Remove data sources |

### Ingestion
| Permission | Controls |
|---|---|
| `ingestion_runs.read` | View ingestion run history and status |
| `ingestion_runs.retry` | Queue a retry for failed runs |

### Compliance evaluation
| Permission | Controls |
|---|---|
| `compliance_runs.read` | View compliance run history and status |
| `compliance_runs.trigger` | Manually trigger or retry compliance evaluation |

### Compliance rules
| Permission | Controls |
|---|---|
| `compliance_rules.read` | View rule definitions |
| `compliance_rules.create` | Create rules |
| `compliance_rules.update` | Update rule definition/severity/status |
| `compliance_rules.delete` | Delete rules |

### Compliance results
| Permission | Controls |
|---|---|
| `compliance_results.read` | View evaluation results and summary |

### Reports
| Permission | Controls |
|---|---|
| `reports.read` | View reports |
| `reports.create` | Create new reports |
| `reports.update` | Update report title, advance to review |
| `reports.approve` | Transition report to approved status |
| `reports.publish` | Transition report to published status |
| `reports.delete` | Delete non-approved/non-published reports |

### Report exports
| Permission | Controls |
|---|---|
| `report_exports.read` | View and download exports |
| `report_exports.create` | Generate new exports |

### Audit
| Permission | Controls |
|---|---|
| `audit_logs.read` | View the audit trail |

**Total: 36 permission strings.**

---

## 6. Default MVP Roles

These five roles are seeded per tenant during provisioning. Tenants can create additional custom roles, but these defaults cover the MVP personas. Seed data is implemented in `/execution/seeds/`.

### tenant_admin

The highest-privilege role within a tenant. Manages organizational structure, users, roles, and can publish reports. Always assigned with `agency_id = NULL` (tenant-wide).

```json
{
  "tenant.admin": true,
  "agencies.create": true,
  "agencies.update": true,
  "agencies.delete": true,
  "users.list": true,
  "users.read": true,
  "users.create": true,
  "users.update": true,
  "roles.create": true,
  "roles.update": true,
  "roles.delete": true,
  "memberships.read": true,
  "memberships.create": true,
  "memberships.delete": true,
  "data_sources.read": true,
  "data_sources.create": true,
  "data_sources.update": true,
  "data_sources.delete": true,
  "ingestion_runs.read": true,
  "ingestion_runs.retry": true,
  "compliance_runs.read": true,
  "compliance_runs.trigger": true,
  "compliance_rules.read": true,
  "compliance_rules.create": true,
  "compliance_rules.update": true,
  "compliance_rules.delete": true,
  "compliance_results.read": true,
  "reports.read": true,
  "reports.create": true,
  "reports.update": true,
  "reports.approve": true,
  "reports.publish": true,
  "reports.delete": true,
  "report_exports.read": true,
  "report_exports.create": true,
  "audit_logs.read": true
}
```

**Count:** 36/36 permissions (all).

---

### agency_admin

Manages an agency's resources, users within that agency, and approves reports. Typically assigned with a specific `agency_id`.

```json
{
  "agencies.update": true,
  "users.list": true,
  "users.read": true,
  "users.create": true,
  "users.update": true,
  "memberships.read": true,
  "memberships.create": true,
  "memberships.delete": true,
  "data_sources.read": true,
  "data_sources.create": true,
  "data_sources.update": true,
  "data_sources.delete": true,
  "ingestion_runs.read": true,
  "ingestion_runs.retry": true,
  "compliance_runs.read": true,
  "compliance_runs.trigger": true,
  "compliance_rules.read": true,
  "compliance_rules.create": true,
  "compliance_rules.update": true,
  "compliance_rules.delete": true,
  "compliance_results.read": true,
  "reports.read": true,
  "reports.create": true,
  "reports.update": true,
  "reports.approve": true,
  "reports.delete": true,
  "report_exports.read": true,
  "report_exports.create": true,
  "audit_logs.read": true
}
```

**Count:** 29/36.

**What's excluded and why:**
- `tenant.admin` — agency admins do not manage tenant-level settings.
- `agencies.create`, `agencies.delete` — agency lifecycle is a tenant-level concern.
- `roles.create`, `roles.update`, `roles.delete` — role definitions are tenant-wide; agency admins assign existing roles, not create new ones.
- `reports.publish` — publishing is a tenant-level action with cross-agency visibility implications.

---

### analyst

The primary working role. Creates and configures data sources, rules, and reports. Cannot approve reports (separation of duties). Typically assigned with a specific `agency_id`.

```json
{
  "data_sources.read": true,
  "data_sources.create": true,
  "data_sources.update": true,
  "ingestion_runs.read": true,
  "ingestion_runs.retry": true,
  "compliance_runs.read": true,
  "compliance_runs.trigger": true,
  "compliance_rules.read": true,
  "compliance_rules.create": true,
  "compliance_rules.update": true,
  "compliance_results.read": true,
  "reports.read": true,
  "reports.create": true,
  "reports.update": true,
  "report_exports.read": true,
  "report_exports.create": true
}
```

**Count:** 16/36.

**What's excluded and why:**
- All `tenant.*`, `agencies.*`, `users.*`, `roles.*`, `memberships.*` — analysts don't manage organizational structure.
- `data_sources.delete` — destructive action reserved for admins.
- `compliance_rules.delete` — destructive action reserved for admins.
- `reports.approve`, `reports.publish`, `reports.delete` — report lifecycle control beyond authoring is reserved for admins.
- `audit_logs.read` — audit access is restricted to auditors and admins.

---

### auditor

Read-only access to compliance data, reports, exports, and the audit trail. Can trigger compliance evaluations to verify results but cannot modify rules, data sources, or reports. Typically assigned with a specific `agency_id`.

```json
{
  "compliance_runs.read": true,
  "compliance_runs.trigger": true,
  "compliance_rules.read": true,
  "compliance_results.read": true,
  "reports.read": true,
  "report_exports.read": true,
  "report_exports.create": true,
  "audit_logs.read": true
}
```

**Count:** 8/36.

**What's excluded and why:**
- All write permissions on rules, sources, users, agencies, roles — auditors observe, they don't modify.
- `reports.create`, `reports.update`, `reports.approve`, `reports.publish`, `reports.delete` — auditors read reports, not author or manage them.
- `ingestion_runs.retry` — retriggering ingestion is an operational action, not an audit action.

**Why `compliance_runs.trigger` is included:** An auditor may need to re-run compliance evaluation against existing data to independently verify results. This is a read-like action (it produces new results without modifying existing data or rules).

**Why `report_exports.create` is included:** Auditors need to generate exports (PDF, CSV) of reports for off-platform review or regulatory submission.

---

### viewer

Minimal read-only access. Can see compliance results and reports but cannot trigger evaluations, create exports, or access the audit trail. Suitable for stakeholders who need visibility without operational capability.

```json
{
  "compliance_results.read": true,
  "reports.read": true
}
```

**Count:** 2/36.

---

## 7. Permission Matrix by Role

| Permission | tenant_admin | agency_admin | analyst | auditor | viewer |
|---|---|---|---|---|---|
| `tenant.admin` | Y | | | | |
| `agencies.create` | Y | | | | |
| `agencies.update` | Y | Y | | | |
| `agencies.delete` | Y | | | | |
| `users.list` | Y | Y | | | |
| `users.read` | Y | Y | | | |
| `users.create` | Y | Y | | | |
| `users.update` | Y | Y | | | |
| `roles.create` | Y | | | | |
| `roles.update` | Y | | | | |
| `roles.delete` | Y | | | | |
| `memberships.read` | Y | Y | | | |
| `memberships.create` | Y | Y | | | |
| `memberships.delete` | Y | Y | | | |
| `data_sources.read` | Y | Y | Y | | |
| `data_sources.create` | Y | Y | Y | | |
| `data_sources.update` | Y | Y | Y | | |
| `data_sources.delete` | Y | Y | | | |
| `ingestion_runs.read` | Y | Y | Y | | |
| `ingestion_runs.retry` | Y | Y | Y | | |
| `compliance_runs.read` | Y | Y | Y | Y | |
| `compliance_runs.trigger` | Y | Y | Y | Y | |
| `compliance_rules.read` | Y | Y | Y | Y | |
| `compliance_rules.create` | Y | Y | Y | | |
| `compliance_rules.update` | Y | Y | Y | | |
| `compliance_rules.delete` | Y | Y | | | |
| `compliance_results.read` | Y | Y | Y | Y | Y |
| `reports.read` | Y | Y | Y | Y | Y |
| `reports.create` | Y | Y | Y | | |
| `reports.update` | Y | Y | Y | | |
| `reports.approve` | Y | Y | | | |
| `reports.publish` | Y | | | | |
| `reports.delete` | Y | Y | | | |
| `report_exports.read` | Y | Y | Y | Y | |
| `report_exports.create` | Y | Y | Y | Y | |
| `audit_logs.read` | Y | Y | | Y | |

---

## 8. Escalation Prevention Rules

Escalation prevention ensures that no user can grant or revoke permissions they do not themselves possess. This applies to membership management operations.

### Rule 1: Cannot assign a role with higher permissions

When `POST /api/v1/users/:user_id/memberships` is called, the API must:

1. Load the target role's `permissions` map.
2. Load the caller's effective permissions (union of all their memberships).
3. For every permission in the target role where the value is `true`, verify the caller also holds that permission.
4. If the target role grants any permission the caller does not hold, reject with `403`.

**Example:** An agency_admin (29 permissions) cannot assign the tenant_admin role (36 permissions) because tenant_admin includes `tenant.admin`, `agencies.create`, `agencies.delete`, `roles.create`, `roles.update`, `roles.delete`, and `reports.publish` which agency_admin does not hold.

**Example:** An analyst (16 permissions) cannot assign the agency_admin role because agency_admin includes `data_sources.delete`, `compliance_rules.delete`, `reports.approve`, `reports.delete`, `audit_logs.read`, and all user/membership management permissions that analyst does not hold.

### Rule 2: Cannot revoke a role with higher permissions

When `DELETE /api/v1/users/:user_id/memberships/:membership_id` is called, the API must:

1. Load the membership being revoked to get its `role_id`.
2. Load that role's `permissions` map.
3. Load the caller's effective permissions.
4. If the target role grants any permission the caller does not hold, reject with `403`.

**Rationale:** Without this rule, a lower-privilege user could revoke a higher-privilege user's admin role, effectively performing a privilege escalation by removal.

### Rule 3: Cannot modify a role to exceed own permissions

When `PATCH /api/v1/roles/:role_id` is called with a `permissions` update, the API must:

1. Load the caller's effective permissions.
2. Compare the new permissions map against the caller's permissions.
3. If the new map includes any `true` permission the caller does not hold, reject with `403`.

**Rationale:** A user who can update roles but not publish reports should not be able to add `reports.publish: true` to a role.

### Rule 4: Self-demotion is allowed

A user may revoke their own memberships or modify their own roles to reduce their permissions. Escalation prevention only blocks increases, not decreases.

---

## 9. Report Separation-of-Duties Rule

### The rule
The user who creates a report (`created_by`) cannot be the user who approves it (`approved_by`). This is enforced at the API level on the `PATCH /api/v1/agencies/:agency_id/reports/:report_id` endpoint when the request transitions the report status to `approved`.

### Enforcement
When a status transition to `approved` is requested:

1. Load the report's `created_by` field.
2. Compare against the current authenticated user's `user_id`.
3. If they match, reject with `403` and error code `SEPARATION_OF_DUTIES`.

```json
{
  "error": {
    "code": "SEPARATION_OF_DUTIES",
    "message": "The report creator cannot approve their own report.",
    "details": {
      "created_by": "uuid",
      "approver": "uuid"
    }
  }
}
```

### What this does not apply to
- **Review transition.** The creator can move their own report from `draft` to `review` (or from `generating` to `review`). Self-review is permitted; self-approval is not.
- **Publish transition.** The publish step requires `reports.publish` (tenant_admin only). There is no additional separation-of-duties check between the approver and the publisher, because these are already different permission levels (agency_admin vs. tenant_admin).
- **Report deletion.** No separation-of-duties check. Any user with `reports.delete` can delete a non-approved/non-published report.

### Why this rule exists
Government compliance reporting requires an independent review step. Regulatory frameworks (SOX, FISMA, state-level equivalents) explicitly prohibit self-certification of compliance reports. This is a hard business requirement, not a nice-to-have.

---

## 10. /me Permission Resolution Rules

The `GET /api/v1/me` endpoint returns the caller's effective permissions and memberships. This section defines exactly how that resolution works.

### Step 1: Load all memberships

Query all `memberships` rows for the current user within the current tenant, joining `roles` to get each role's `permissions` map and `name`, and joining `agencies` to get each agency's `name`.

```
SELECT m.id, m.agency_id, a.name as agency_name,
       m.role_id, r.name as role_name, r.permissions
FROM memberships m
JOIN roles r ON r.id = m.role_id
LEFT JOIN agencies a ON a.id = m.agency_id
WHERE m.tenant_id = <current_tenant_id>
  AND m.user_id = <current_user_id>
```

### Step 2: Build the memberships array

Each membership becomes an entry in the response `memberships` array:

```json
{
  "id": "membership uuid",
  "agency_id": "uuid | null",
  "agency_name": "string | null",
  "role_id": "uuid",
  "role_name": "string"
}
```

The role's `permissions` map is not included per-membership. The frontend does not need to know which role grants which permission — only the aggregate.

### Step 3: Flatten permissions

Iterate over all memberships. For each membership's role, iterate over the `permissions` map. Collect every key where the value is `true` into a deduplicated set.

```
effective_permissions = {}
for each membership:
  for each (key, value) in membership.role.permissions:
    if value == true:
      effective_permissions.add(key)
```

The result is a flat array of permission strings:

```json
["compliance_results.read", "reports.read", "reports.create", "reports.update"]
```

### Step 4: Include in response

The `permissions` array is included in the `/me` response for frontend UI guards only. The backend never uses this pre-computed list — it re-derives permissions from the database on every request that requires authorization.

### Why re-derive on every request
The `/me` response could become stale the moment it's sent. Between the time the frontend caches this response and the time the user takes their next action:
- An admin could revoke a membership.
- An admin could modify a role's permissions.
- The user could be disabled.

If the backend relied on cached permissions, these changes would not take effect until the next `/me` call. By re-deriving on every request, the backend guarantees that authorization decisions are always current.

### Self-access permissions
Regardless of their role, every authenticated user can:
- Call `GET /api/v1/me` (no permission check — authentication is sufficient).
- Call `GET /api/v1/users/:user_id` where `:user_id` is their own ID.
- Call `GET /api/v1/users/:user_id/memberships` where `:user_id` is their own ID.
- Call `PATCH /api/v1/users/:user_id` where `:user_id` is their own ID, but only to update `display_name`.

These self-access rules are hardcoded in middleware, not driven by permission strings. A viewer with only 2 permissions can still see their own profile and memberships.
