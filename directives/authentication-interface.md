# Directive: Authentication Interface

## Status
Approved — all token extraction rules, input/output contracts, failure modes, and boundary definitions defined here are the source of truth for the authentication middleware implementation in `/api/middleware/authentication.js`. References `directives/auth-and-permissions.md` for identity resolution logic, `directives/middleware-architecture.md` for chain position and bypass rules, `directives/security-baseline.md` for information exposure limits, and `directives/api-contract.md` for error response shapes and the `/me` endpoint contract.

## Scope
Interface contract for the authentication middleware layer only. Defines what the middleware receives, what it produces, and how it fails. Does not define token formats, signing algorithms, IdP configuration, or any provider-specific behavior — those are implementation concerns resolved at deployment time. Does not define RLS activation (tenant-context middleware), permission checks (authorization middleware), or audit writes (audit-writer middleware).

---

## 1. Authorization Header Format

### Scheme

The platform uses the Bearer authentication scheme as defined in RFC 6750. Every authenticated request must include an `Authorization` header with the following format:

```
Authorization: Bearer <token>
```

### Token

The `<token>` value is an opaque string from the authentication middleware's perspective. It is issued by an external identity provider (IdP) and may be a JWT, a session reference, or any other token format the IdP produces. The authentication middleware must not assume a specific token structure — it delegates token validation to a verification function that can be swapped per deployment.

### Rules

- The header name is case-insensitive (`Authorization`, `authorization`, `AUTHORIZATION` are all accepted — HTTP/1.1 standard behavior handled by Express).
- The scheme keyword `Bearer` is case-insensitive per RFC 6750 section 2.1.
- Exactly one space separates `Bearer` from the token value.
- The token value must contain at least one character. An empty token (`Bearer `) is treated as missing.
- No other authentication schemes are supported in MVP. Requests using `Basic`, `Digest`, or other schemes are treated as missing authentication.

---

## 2. Token Extraction Rules

Token extraction is the first operation performed by the authentication middleware. It is a pure string operation with no database access and no network calls.

### Extraction steps

1. Read the `Authorization` header from the incoming request.
2. If the header is absent, extraction fails — no token is available.
3. Split the header value on the first space to obtain the scheme and the token.
4. If the scheme does not match `Bearer` (case-insensitive comparison), extraction fails.
5. If the token portion is empty or consists only of whitespace, extraction fails.
6. Trim the token of leading and trailing whitespace.
7. The trimmed token value is the extraction result.

### Extraction failure

If extraction fails for any reason, the middleware rejects with `401`. The failure response must not indicate whether the header was absent, the scheme was wrong, or the token was empty — all cases produce the same generic response. (Source: `directives/security-baseline.md` section 9 principles.)

### What extraction does not do

- Does not decode the token.
- Does not validate the token's signature or expiration.
- Does not parse the token as JSON, Base64, or any other format.
- Does not inspect the token's claims or payload.

Extraction determines only that a Bearer token is present and non-empty. All further validation is a separate step.

---

## 3. Authentication Middleware Inputs

The authentication middleware receives these inputs from the environment and from upstream middleware. It must not access anything beyond this set.

### From the HTTP request

| Input | Source | Required |
|---|---|---|
| Authorization header | `req.headers['authorization']` | Yes — absence causes `401` |

### From upstream middleware

| Input | Source | Description |
|---|---|---|
| `req.requestId` | request-id middleware | Available for error correlation but not used in authentication logic |

### From the platform (injected at startup)

| Input | Description |
|---|---|
| Token verification function | A function that accepts a raw token string and returns the verified claims (tenant identifier, user subject, email) or throws on failure. Swappable per deployment — the authentication middleware does not contain IdP-specific logic. |
| User resolution function | A function that accepts tenant and user identifiers and returns the user record with memberships from the database, or null if not found. |

### What the middleware must not access

- Environment variables directly. Configuration is injected at startup, not read at request time.
- The database connection directly. Database access is performed through the injected resolution function.
- Other request headers (except `Authorization`). Authentication is not influenced by `User-Agent`, `Origin`, cookies, or any other header.
- The request body. Authentication is independent of request content.
- The request path. The middleware runs on all authenticated routes — it does not inspect which route is being accessed.

---

## 4. Authentication Middleware Outputs

On success, the middleware populates the request context and calls `next()`. On failure, the middleware sends a `401` response and does not call `next()`.

### Success output

The middleware calls `next()` with no arguments, passing control to the tenant-context middleware.

### Failure output

The middleware sends an HTTP response and terminates the middleware chain. No downstream middleware or route handler executes.

### Side effects

None. The authentication middleware does not:
- Write to the database.
- Modify the database connection state (that is tenant-context's responsibility).
- Write audit log entries (authentication failures are logged by the IdP, not the platform — source: `directives/audit-policy.md` section 1, "Actions that are NOT audited").
- Set response headers (except indirectly via the error response).
- Emit events or queue jobs.

---

## 5. Request Context Fields

After successful authentication, the following properties are guaranteed to exist on the request object. Downstream middleware (tenant-context, authorization) and route handlers depend on these properties. Their types, presence, and semantics are part of the authentication middleware's public contract.

### req.tenantId

| | |
|---|---|
| **Type** | `string` (UUID) |
| **Set when** | Token is valid and the tenant claim resolves to an existing tenant row |
| **Guaranteed** | Non-null, non-empty, valid UUID format |
| **Used by** | tenant-context middleware (to activate RLS), authorization middleware (to scope agency checks), audit-writer (to set `tenant_id` on audit entries), all route handlers |
| **Source** | Tenant identifier from the verified token claims, resolved to `tenants.id` |

### req.userId

| | |
|---|---|
| **Type** | `string` (UUID) |
| **Set when** | Token is valid, tenant is resolved, and the user resolves to an active `users` row |
| **Guaranteed** | Non-null, non-empty, valid UUID format |
| **Used by** | authorization middleware (self-access checks, separation of duties), audit-writer (as `actor_id`), route handlers (as the acting user) |
| **Source** | `users.id` for the row matching the token's `sub` or `email` within the resolved tenant |

### req.memberships

| | |
|---|---|
| **Type** | `Array<object>` |
| **Set when** | User is resolved |
| **Guaranteed** | Always an array. May be empty (a user with no memberships has no permissions). |
| **Element shape** | See below |
| **Used by** | authorization middleware (agency membership checks, escalation prevention), `/me` route handler |
| **Source** | All `memberships` rows for this user within this tenant, joined with `roles` for permission maps and role names, and left-joined with `agencies` for agency names |

**Membership element shape:**

```
{
  id:          string (UUID) — memberships.id
  agency_id:   string (UUID) or null — null means tenant-wide
  agency_name: string or null — from agencies.name, null when agency_id is null
  role_id:     string (UUID)
  role_name:   string — from roles.name
  permissions: object — from roles.permissions, flat map of permission strings to booleans
}
```

### req.effectivePermissions

| | |
|---|---|
| **Type** | `Set<string>` |
| **Set when** | Memberships are loaded |
| **Guaranteed** | Always a Set. May be empty (user with no memberships or all permissions are `false`). |
| **Used by** | authorization middleware (permission string checks, escalation prevention) |
| **Derivation** | Iterate all memberships. For each membership's `permissions` map, add every key where the value is `true`. Deduplicate. The result is the flat union of all granted permissions across all roles and agencies. |
| **Source** | Computed from `req.memberships[*].permissions` |

### Contract guarantee

If the authentication middleware calls `next()`, all four properties above are present and correctly typed. Downstream middleware must not re-check for their existence — if they are missing, it is a bug in the authentication middleware, not an expected condition.

---

## 6. Failure Modes and Response Codes

Every authentication failure produces the same HTTP status and the same error code. The response must not reveal which step failed.

### Single failure response

```
HTTP 401 Unauthorized
Content-Type: application/json
```

```
{
  "error": {
    "code": "UNAUTHENTICATED",
    "message": "Authentication required.",
    "request_id": "<req.requestId>"
  }
}
```

### Why all failures look identical

An attacker probing the authentication layer can infer information from differentiated error responses:

- "Invalid token" vs. "Token expired" reveals that the token format was valid.
- "Tenant not found" reveals that the tenant identifier was parsed from the token.
- "User disabled" reveals that the user account exists.

A single generic `UNAUTHENTICATED` response prevents this. The reason for the failure is logged server-side for debugging but never exposed to the caller. (Source: `directives/security-baseline.md` section 9.)

### Failure triggers

| Step | Condition | Internal Reason (logged, not exposed) |
|---|---|---|
| Token extraction | Authorization header missing | No credentials provided |
| Token extraction | Scheme is not Bearer | Unsupported authentication scheme |
| Token extraction | Token value is empty | Empty bearer token |
| Token verification | Signature is invalid | Token tampered or wrong signing key |
| Token verification | Token is expired (`exp` claim) | Session expired |
| Token verification | Issuer does not match (`iss` claim) | Token from unknown identity provider |
| Tenant resolution | Token's tenant claim does not match any `tenants` row | Tenant not found or removed |
| User resolution | Token's `sub` or `email` does not match any `users` row within the tenant | User not provisioned |
| User resolution | Matched user's `status` is not `active` | User account disabled |

### What is not an authentication failure

- **Tenant suspended or offboarded.** The tenant exists and the user is valid, but the organization's status prevents access. This is handled by the tenant-context middleware, not authentication.
- **Missing permissions.** The user is authenticated but lacks a specific permission. This is handled by the authorization middleware.
- **Missing agency membership.** The user is authenticated but does not have access to a specific agency. This is handled by the authorization middleware.

---

## 7. What Authentication Is Responsible For

Authentication owns a specific, bounded set of responsibilities. If a concern is listed here, it belongs in the authentication middleware. If it is not listed here, it does not.

### Responsibilities

1. **Token extraction.** Reading the Bearer token from the Authorization header.
2. **Token verification.** Delegating to the injected verification function to validate the token's authenticity, integrity, and freshness (signature, expiration, issuer).
3. **Tenant resolution.** Mapping the token's tenant claim to a `tenants` row. Confirming the tenant exists.
4. **User resolution.** Mapping the token's subject or email to a `users` row within the resolved tenant. Confirming the user exists and is `active`.
5. **Membership loading.** Querying all `memberships` for the resolved user within the resolved tenant, joined with `roles` and `agencies`.
6. **Permission flattening.** Computing the effective permission set from all loaded memberships.
7. **Request context population.** Setting `req.tenantId`, `req.userId`, `req.memberships`, and `req.effectivePermissions`.
8. **Failure response.** Returning `401` with the generic `UNAUTHENTICATED` error when any step fails.

---

## 8. What Authentication Is NOT Responsible For

These concerns are explicitly outside the authentication middleware's boundary. Other middleware or layers own them.

| Concern | Owner | Why not authentication |
|---|---|---|
| RLS activation (`SET LOCAL`) | tenant-context middleware | Database-layer isolation is a separate concern. Auth resolves the tenant; tenant-context activates it. Separating them allows auth to fail fast without touching the database connection state. |
| Tenant status enforcement (suspended/offboarded) | tenant-context middleware | The tenant exists (auth confirmed it), but its status prevents access. This is an organizational policy decision, not an identity verification. |
| Agency membership validation | authorization middleware | Whether the user can access a specific agency is an access-control decision made against the user's memberships, not an identity question. |
| Permission enforcement | authorization middleware | Whether the user holds a specific permission is an authorization question. Authentication confirms who the user is; authorization decides what they can do. |
| Escalation prevention | authorization middleware | Comparing the caller's permissions against a target role is a policy enforcement concern. |
| Separation of duties | authorization middleware | Checking `created_by != current_user` is a business rule applied at the authorization layer. |
| Input validation | validation middleware | Authentication does not inspect the request body, path parameters, or query parameters. |
| Audit logging | audit-writer middleware | Authentication failures are not audited by the platform — they are logged by the IdP. Successful authentications are not auditable events (only state changes are audited). |
| Rate limiting | rate-limiting middleware (future) | Throttling is an edge concern independent of identity resolution. |
| Token issuance | external IdP | The platform never creates, refreshes, or revokes tokens. |
| Password management | external IdP | The platform never stores, hashes, or validates passwords. |
| Session management | external IdP | Session lifecycle (creation, refresh, revocation) is the IdP's responsibility. |

---

## 9. Relationship Between Authentication, Tenant-Context, and Authorization

These three middleware form a sequential dependency chain. Each one builds on the outputs of its predecessor.

### Dependency diagram

```
authentication
  │
  │  outputs: req.tenantId, req.userId, req.memberships, req.effectivePermissions
  │
  ▼
tenant-context
  │
  │  reads:   req.tenantId
  │  effect:  SET LOCAL app.current_tenant_id (activates RLS)
  │  outputs: (none on req — effect is on the database connection)
  │
  ▼
authorization
  │
  │  reads:   req.memberships, req.effectivePermissions, req.userId
  │  outputs: req.agencyId (agency-scoped routes only)
  │
  ▼
route handler
```

### What each layer answers

| Middleware | Question Answered |
|---|---|
| authentication | "Who is this caller, and what credentials do they carry?" |
| tenant-context | "Is this caller's organization currently allowed to operate?" |
| authorization | "Is this caller allowed to perform this specific action on this specific resource?" |

### Execution guarantee

The middleware chain enforces a strict ordering:
- **Tenant-context never runs without authentication.** `req.tenantId` must exist before `SET LOCAL` can be called.
- **Authorization never runs without tenant-context.** Agency existence checks require the RLS context to be active (the query against `agencies` is tenant-scoped).
- **If authentication rejects, nothing downstream executes.** No tenant-context activation, no authorization check, no route handler, no audit write.

### Failure attribution

| Status Code | Responsible Middleware | Meaning |
|---|---|---|
| `401` | authentication | Identity could not be verified |
| `401` | tenant-context | Identity is valid but the organization is suspended/offboarded |
| `403` | authorization | Identity and organization are valid, but the action is not permitted |
| `404` | authorization | The requested agency does not exist within the tenant |

---

## 10. Requirements for GET /api/v1/me

The `/me` endpoint has a unique relationship with authentication. It is the only route that directly exposes the authentication middleware's outputs as its response body.

### Middleware path

```
request → request-id → authentication → tenant-context → route handler → response
```

Skips: authorization, validation, audit-writer. (Source: `directives/middleware-architecture.md` section 10.)

### Why no authorization check

`GET /api/v1/me` does not require any permission. Authentication alone is sufficient — every authenticated user can retrieve their own profile. This is a hardcoded bypass, not a permission string. (Source: `directives/auth-and-permissions.md` section 10.)

### Why no audit logging

`GET /api/v1/me` is a read operation. Read operations are not audited. (Source: `directives/audit-policy.md` section 1, "Actions that are NOT audited.")

### Data source

The `/me` response is derived entirely from data already loaded by the authentication middleware:
- `req.userId` → `id`
- User's `email`, `display_name`, `status` → from the user resolution step
- `req.tenantId` → `tenant.id`, plus tenant's `name` and `slug`
- `req.memberships` → `memberships` array (reshaped: `permissions` map is excluded per-membership)
- `req.effectivePermissions` → `permissions` array (the Set converted to a sorted array)

### Response shape

As defined in `directives/api-contract.md`:

```
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
    "reports.read"
  ]
}
```

### Real-time guarantee

The `/me` response must reflect the current database state, not cached token claims. Between the time a token was issued and the time `/me` is called:
- An admin could revoke a membership.
- An admin could modify a role's permissions.
- The user could be disabled (caught by authentication — disabled users are rejected).

Because the authentication middleware loads memberships from the database on every request (no caching), the `/me` response is always current. (Source: `directives/auth-and-permissions.md` section 10, "Why re-derive on every request.")

### What /me must not include

| Field | Reason |
|---|---|
| `auth_provider_id` | Internal IdP plumbing. No value to the frontend. (Source: `directives/api-contract.md`, `/me` section.) |
| `created_at` | Not relevant to the caller's current session context. |
| Per-membership `permissions` map | The frontend uses the flattened `permissions` array for UI guards, not per-role breakdowns. |
| `tenant.status` | The tenant is always `active` by the time `/me` is reached (tenant-context middleware rejects otherwise). Including it adds no information. |
| `tenant.created_at`, `tenant.updated_at` | Not relevant to the session context. |

---

## Request Flow Diagrams

### Success path

```
Client                          Authentication Middleware              Database
  │                                      │                                │
  │  GET /api/v1/me                      │                                │
  │  Authorization: Bearer <token>       │                                │
  │─────────────────────────────────────→│                                │
  │                                      │                                │
  │                              1. Extract token                         │
  │                              2. Verify token (signature, exp, iss)    │
  │                                      │                                │
  │                              3. Resolve tenant                        │
  │                                      │  SELECT * FROM tenants         │
  │                                      │  WHERE <tenant_claim match>    │
  │                                      │───────────────────────────────→│
  │                                      │←───────────────────────────────│
  │                                      │  tenant row found, id = T1     │
  │                                      │                                │
  │                              4. Resolve user                          │
  │                                      │  SELECT * FROM users           │
  │                                      │  WHERE tenant_id = T1          │
  │                                      │  AND <sub/email match>         │
  │                                      │───────────────────────────────→│
  │                                      │←───────────────────────────────│
  │                                      │  user row found, active        │
  │                                      │                                │
  │                              5. Load memberships                      │
  │                                      │  SELECT m.*, r.*, a.name       │
  │                                      │  FROM memberships m            │
  │                                      │  JOIN roles r ...              │
  │                                      │  LEFT JOIN agencies a ...      │
  │                                      │  WHERE m.tenant_id = T1        │
  │                                      │  AND m.user_id = U1            │
  │                                      │───────────────────────────────→│
  │                                      │←───────────────────────────────│
  │                                      │  membership rows returned      │
  │                                      │                                │
  │                              6. Flatten permissions                   │
  │                              7. Populate req context:                 │
  │                                 req.tenantId                          │
  │                                 req.userId                            │
  │                                 req.memberships                       │
  │                                 req.effectivePermissions              │
  │                                      │                                │
  │                              8. Call next()                           │
  │                                      │──→ tenant-context ──→ ...      │
```

### Failure path

```
Client                          Authentication Middleware
  │                                      │
  │  GET /api/v1/agencies                │
  │  Authorization: Bearer <bad-token>   │
  │─────────────────────────────────────→│
  │                                      │
  │                              1. Extract token ✓
  │                              2. Verify token ✗ (signature invalid)
  │                                      │
  │                              Send 401, do NOT call next()
  │                                      │
  │  401 Unauthorized                    │
  │  {                                   │
  │    "error": {                        │
  │      "code": "UNAUTHENTICATED",      │
  │      "message": "Authentication      │
  │                  required.",          │
  │      "request_id": "..."             │
  │    }                                 │
  │  }                                   │
  │←─────────────────────────────────────│
  │                                      │
  │  (tenant-context, authorization,     │
  │   route handler — none execute)      │
```

### Example: Authenticated request

```
GET /api/v1/me HTTP/1.1
Host: api.govreport.example
Authorization: Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9...
X-Request-ID: a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d
```

Result: Authentication succeeds. `req.tenantId`, `req.userId`, `req.memberships`, and `req.effectivePermissions` are populated. Control passes to tenant-context middleware.

### Example: Unauthenticated request

```
GET /api/v1/agencies HTTP/1.1
Host: api.govreport.example
```

Result: No `Authorization` header present. Authentication middleware responds immediately:

```
HTTP/1.1 401 Unauthorized
Content-Type: application/json
X-Request-ID: f8e7d6c5-b4a3-4291-8071-6a5b4c3d2e1f

{
  "error": {
    "code": "UNAUTHENTICATED",
    "message": "Authentication required.",
    "request_id": "f8e7d6c5-b4a3-4291-8071-6a5b4c3d2e1f"
  }
}
```

No downstream middleware executes. The request never reaches tenant-context, authorization, or the route handler.

---

## Design Decisions

### Why token verification is injected, not built-in

The authentication middleware accepts a token verification function at startup rather than implementing IdP-specific logic internally. This provides:
- **Deployment flexibility.** Different environments may use different IdPs (Entra ID in production, a local mock in development, Okta for a specific tenant).
- **Testability.** Unit tests inject a stub verification function that returns predetermined claims or throws predetermined errors, without needing a running IdP.
- **Separation of concerns.** Token format and signing details are infrastructure concerns. Authentication middleware is an application concern. Mixing them couples the application to a specific IdP.

### Why user resolution queries the database on every request

Caching user state (memberships, permissions, active status) between requests creates a window where stale data drives authorization decisions. Within that window:
- A revoked membership still grants access.
- A disabled user still authenticates.
- A modified role still carries its old permissions.

For a government compliance platform, this window is unacceptable. The cost of one additional database query per request is low compared to the risk of enforcing stale permissions. (Source: `directives/auth-and-permissions.md` section 10.)

### Why the /me endpoint does not need its own auth logic

The `/me` endpoint is often implemented as a special case with its own user-loading logic. In this architecture, that is unnecessary — the authentication middleware already loads everything `/me` needs. The route handler's only job is to reshape `req.userId`, `req.memberships`, and `req.effectivePermissions` into the API-contract response shape. This avoids duplicate database queries and keeps the authentication contract as the single source of truth for identity data.
