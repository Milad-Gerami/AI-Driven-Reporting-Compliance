# Directive: Authentication Implementation Plan

## Status
Approved — this plan defines the internal execution algorithm, dependency injection structure, function interface contracts, and test strategy for implementing `/api/middleware/authentication.js`. It refines the external contract defined in `directives/authentication-interface.md` into an implementable specification. All decisions here are consistent with `directives/middleware-architecture.md`, `directives/auth-and-permissions.md`, `directives/security-baseline.md`, and `directives/api-contract.md`.

## Scope
Implementation plan for the authentication middleware only. Covers the internal algorithm, injected function signatures, error handling flow, and test categories. Does not select token libraries, identity providers, or database drivers. Does not define route handlers, other middleware, or database schema changes. The middleware implementation must satisfy this plan without requiring changes to any existing directive.

---

## 1. Middleware Execution Algorithm

The authentication middleware executes a fixed sequence of eight steps on every request. Each step either succeeds (producing an output for the next step) or fails (terminating the sequence and sending a `401` response). No step is optional. No step is reordered.

### Step-by-step algorithm

```
Step 1: Extract token
  Input:  req.headers['authorization']
  Output: rawToken (string)
  Fail:   header missing, scheme not Bearer, token empty → REJECT

Step 2: Verify token
  Input:  rawToken
  Output: claims { tenantIdentifier, userSubject, userEmail }
  Fail:   signature invalid, expired, wrong issuer → REJECT

Step 3: Resolve tenant
  Input:  claims.tenantIdentifier
  Output: tenant { id, name, slug, status }
  Fail:   no matching tenant row → REJECT

Step 4: Resolve user
  Input:  tenant.id, claims.userSubject, claims.userEmail
  Output: user { id, email, display_name, status }
  Fail:   no matching user row, or user.status != 'active' → REJECT

Step 5: Load memberships
  Input:  tenant.id, user.id
  Output: memberships (array of membership objects with joined role and agency data)
  Fail:   database error → REJECT (never fails on empty result — a user with no memberships is valid)

Step 6: Flatten permissions
  Input:  memberships
  Output: effectivePermissions (Set of permission strings)
  Fail:   never fails — produces empty Set if no memberships or no true permissions

Step 7: Populate request context
  Input:  tenant.id, user.id, memberships, effectivePermissions, user (profile fields), tenant (profile fields)
  Output: req.tenantId, req.userId, req.memberships, req.effectivePermissions, req.user, req.tenant
  Fail:   never fails

Step 8: Pass control
  Action: call next() with no arguments
```

### Sequence diagram

```
request arrives
  │
  ▼
┌──────────────────────────────┐
│ Step 1: Extract token        │
│ Read Authorization header    │
│ Validate Bearer scheme       │
│ Validate non-empty token     │
└──────────┬───────────────────┘
           │ rawToken
           ▼
┌──────────────────────────────┐
│ Step 2: Verify token         │◄── injected: verifyToken(rawToken)
│ Validate signature           │
│ Validate expiration          │
│ Validate issuer              │
│ Extract claims               │
└──────────┬───────────────────┘
           │ claims { tenantIdentifier, userSubject, userEmail }
           ▼
┌──────────────────────────────┐
│ Step 3: Resolve tenant       │◄── injected: resolveTenant(tenantIdentifier)
│ Look up tenant by identifier │
│ Confirm tenant exists        │
└──────────┬───────────────────┘
           │ tenant { id, name, slug, status }
           ▼
┌──────────────────────────────┐
│ Step 4: Resolve user         │◄── injected: resolveUser(tenantId, sub, email)
│ Look up user within tenant   │
│ Confirm user exists          │
│ Confirm status is 'active'   │
└──────────┬───────────────────┘
           │ user { id, email, display_name, status }
           ▼
┌──────────────────────────────┐
│ Step 5: Load memberships     │◄── injected: loadMemberships(tenantId, userId)
│ Query memberships + roles    │
│ Join agency names            │
└──────────┬───────────────────┘
           │ memberships [ { id, agency_id, agency_name, role_id, role_name, permissions } ]
           ▼
┌──────────────────────────────┐
│ Step 6: Flatten permissions  │    (pure computation, no injection)
│ Union all true permissions   │
│ across all memberships       │
└──────────┬───────────────────┘
           │ effectivePermissions (Set)
           ▼
┌──────────────────────────────┐
│ Step 7: Populate req context │
│ req.tenantId = tenant.id     │
│ req.userId = user.id         │
│ req.memberships = [...]      │
│ req.effectivePermissions = ⟨⟩│
│ req.user = { profile fields }│
│ req.tenant = { profile }     │
└──────────┬───────────────────┘
           │
           ▼
┌──────────────────────────────┐
│ Step 8: next()               │──→ tenant-context middleware
└──────────────────────────────┘

    ─── At any step, failure triggers ───

┌──────────────────────────────┐
│ REJECT                       │
│ Log internal reason          │
│ Send 401 UNAUTHENTICATED     │
│ Do NOT call next()           │
└──────────────────────────────┘
```

### Step boundaries

Steps 1 and 6 are pure computation — no I/O, no injected dependencies. Steps 2–5 each call exactly one injected function. Step 7 is assignment. Step 8 is a single `next()` call. This structure means every I/O boundary is an injected function, making the middleware fully testable with stubs.

---

## 2. Dependency Injection Requirements

The authentication middleware is implemented as a factory function. The factory accepts its dependencies at startup and returns the Express middleware function. This pattern ensures that:

- The middleware has no hidden dependencies on global state, environment variables, or module-level singletons.
- Every dependency can be replaced in tests without mocking modules.
- Different deployments can inject different implementations (e.g., different IdP adapters) without changing the middleware.

### Factory structure (conceptual)

```
createAuthenticationMiddleware({ verifyToken, resolveTenant, resolveUser, loadMemberships })
  → returns function(req, res, next)
```

### Injected dependencies

| Name | Type | I/O | Async |
|---|---|---|---|
| `verifyToken` | function | Network or CPU (depends on IdP) | Yes |
| `resolveTenant` | function | Database read | Yes |
| `resolveUser` | function | Database read | Yes |
| `loadMemberships` | function | Database read | Yes |

### Startup-time validation

The factory must validate at startup (not at request time) that all four dependencies are provided and are functions. If any dependency is missing or not a function, the factory throws immediately. A misconfigured server must fail at boot, not on the first request.

### Why four dependencies instead of two

The `authentication-interface.md` directive describes two injected inputs at the interface level: a token verification function and a user resolution function. This plan refines the second into three separate functions (`resolveTenant`, `resolveUser`, `loadMemberships`) for the following reasons:

1. **Testability.** Each database interaction can be stubbed independently. A test for "tenant not found" does not need to also stub user resolution.
2. **Error attribution.** When a failure occurs, the middleware knows exactly which step failed for internal logging, even though the caller always sees the same `401`.
3. **Query isolation.** Tenant resolution, user resolution, and membership loading are three distinct database queries against three distinct tables. Bundling them into one function creates a monolithic dependency that is harder to maintain and test.

The external contract remains unchanged — downstream middleware sees the same `req.tenantId`, `req.userId`, `req.memberships`, and `req.effectivePermissions` regardless of internal structure.

---

## 3. Token Verification Interface Contract

### Purpose
Validates the authenticity, integrity, and freshness of the raw token string. This is the only function in the authentication chain that interacts with the identity provider (directly or indirectly via cached public keys).

### Function signature (conceptual)

```
verifyToken(rawToken: string) → Promise<claims>
  on success: returns claims object
  on failure: throws an error
```

### Input

| Parameter | Type | Description |
|---|---|---|
| `rawToken` | string | The raw Bearer token value extracted from the Authorization header. Non-empty, trimmed. |

### Output (success)

A claims object with the following properties:

| Property | Type | Required | Description |
|---|---|---|---|
| `tenantIdentifier` | string | Yes | The tenant claim from the token. Format depends on IdP configuration — may be a UUID, a slug, a domain, or a custom claim value. The authentication middleware does not interpret this value; it passes it to `resolveTenant`. |
| `userSubject` | string | Yes | The `sub` claim — the IdP's unique identifier for the user. Stored as `users.auth_provider_id`. |
| `userEmail` | string | Yes | The `email` claim — used as a fallback identifier if `auth_provider_id` matching fails, and as the primary match path for initial user provisioning. |

### Output (failure)

Throws an error. The middleware catches this error, logs it internally, and sends the generic `401` response. The error type or message does not affect the HTTP response — all verification failures produce the same `UNAUTHENTICATED` result.

### What this function must verify

- **Signature.** The token was signed by a trusted key. (Key management — JWKS rotation, key caching — is internal to this function.)
- **Expiration.** The token's `exp` claim has not passed.
- **Issuer.** The token's `iss` claim matches the expected identity provider.

### What this function must not do

- Query the database. Token verification is a cryptographic operation, not a data operation.
- Cache user or tenant state. It returns claims, not resolved entities.
- Modify the request or response objects. It is a pure function from the middleware's perspective.

### Clock tolerance

The function should allow a small clock skew tolerance (recommended: 30 seconds) when checking `exp` and `nbf` claims. Distributed systems cannot guarantee perfect clock synchronization between the IdP and the application server.

---

## 4. Tenant Resolution Interface Contract

### Purpose
Maps the token's tenant identifier (which may be an IdP-specific format) to a `tenants` row in the database. Confirms the tenant exists.

### Function signature (conceptual)

```
resolveTenant(tenantIdentifier: string) → Promise<tenant | null>
  on success: returns tenant object
  on not found: returns null
  on database error: throws
```

### Input

| Parameter | Type | Description |
|---|---|---|
| `tenantIdentifier` | string | The `tenantIdentifier` value from the verified token claims. May be a UUID (matching `tenants.id`), a slug (matching `tenants.slug`), or another identifier depending on IdP configuration. |

### Output (success)

| Property | Type | Description |
|---|---|---|
| `id` | string (UUID) | `tenants.id` — becomes `req.tenantId` |
| `name` | string | `tenants.name` — needed by the `/me` response |
| `slug` | string | `tenants.slug` — needed by the `/me` response |
| `status` | string | `tenants.status` — authentication checks existence only; tenant-context middleware checks status |

### Output (not found)

Returns `null`. The middleware treats this as an authentication failure.

### Output (error)

Throws on database connectivity errors. The middleware catches this, logs it, and sends `401` (not `500`) — an infrastructure failure in the authentication path is treated as an authentication failure from the caller's perspective, because the alternative (a `500` with error details) leaks information.

### Query behavior

- The query runs without tenant-scoped RLS. The `tenants` table does not have RLS enabled (source: `directives/data-model.md` section 1). This is correct — we are resolving which tenant to activate, not querying within a tenant.
- The function must support matching by multiple identifier types. At minimum: `WHERE id = $1 OR slug = $1`. The matching strategy may be refined when the IdP is configured.

### What this function must not do

- Check tenant status. Returning a `suspended` tenant is correct — the authentication middleware confirms the tenant exists. The tenant-context middleware enforces the active-status requirement. (Source: `directives/authentication-interface.md` section 6.)
- Set `app.current_tenant_id`. That is tenant-context middleware's responsibility.

---

## 5. User Resolution Interface Contract

### Purpose
Maps the token's user identifiers (subject and email) to a `users` row within the resolved tenant. Confirms the user exists and is active.

### Function signature (conceptual)

```
resolveUser(tenantId: string, userSubject: string, userEmail: string) → Promise<user | null>
  on success: returns user object
  on not found: returns null
  on database error: throws
```

### Input

| Parameter | Type | Description |
|---|---|---|
| `tenantId` | string (UUID) | The resolved tenant's `id` from step 3. |
| `userSubject` | string | The `sub` claim from the token — matches `users.auth_provider_id`. |
| `userEmail` | string | The `email` claim from the token — matches `users.email`. |

### Output (success)

| Property | Type | Description |
|---|---|---|
| `id` | string (UUID) | `users.id` — becomes `req.userId` |
| `email` | string | `users.email` — needed by the `/me` response |
| `display_name` | string or null | `users.display_name` — needed by the `/me` response |
| `status` | string | `users.status` — must be `active` for authentication to succeed |

### Output (not found)

Returns `null` if no user matches within the tenant. The middleware treats this as an authentication failure.

### Matching strategy

User matching follows a two-step priority:

1. **Primary match: `auth_provider_id`.** Query `WHERE tenant_id = $1 AND auth_provider_id = $2`. This is the stable identifier from the IdP and does not change if the user's email changes.
2. **Fallback match: `email`.** If no `auth_provider_id` match is found, query `WHERE tenant_id = $1 AND email = $3` (case-insensitive). This supports initial login before `auth_provider_id` is populated, and covers IdPs that do not provide a stable subject identifier.

If neither match produces a result, the function returns `null`.

### Status check

The middleware (not this function) checks `user.status == 'active'` after the function returns. If the user exists but is `disabled`, the middleware rejects. The function returns the user regardless of status — the middleware makes the authorization decision. This keeps the function a pure data accessor.

### Query behavior

- The query does not use RLS. At this point in the middleware chain, `SET LOCAL app.current_tenant_id` has not been called. The query explicitly filters by `tenant_id` in the `WHERE` clause. This is safe because the `users` table's `tenant_id` column with an explicit filter provides the same isolation guarantee as RLS for this specific query.

---

## 6. Membership Loading Interface Contract

### Purpose
Loads all membership records for a given user within a given tenant, joined with roles (for permission maps) and agencies (for agency names). This is the data source for both `req.memberships` and `req.effectivePermissions`.

### Function signature (conceptual)

```
loadMemberships(tenantId: string, userId: string) → Promise<Array<membership>>
  on success: returns array of membership objects (may be empty)
  on database error: throws
```

### Input

| Parameter | Type | Description |
|---|---|---|
| `tenantId` | string (UUID) | The resolved tenant's `id`. |
| `userId` | string (UUID) | The resolved user's `id`. |

### Output (success)

An array of membership objects. May be empty — a user with zero memberships is valid (they simply have no permissions). Each element has:

| Property | Type | Source |
|---|---|---|
| `id` | string (UUID) | `memberships.id` |
| `agency_id` | string (UUID) or null | `memberships.agency_id` — null means tenant-wide |
| `agency_name` | string or null | `agencies.name` — null when `agency_id` is null |
| `role_id` | string (UUID) | `memberships.role_id` |
| `role_name` | string | `roles.name` |
| `permissions` | object | `roles.permissions` — flat map of permission strings to booleans |

### Query structure (conceptual)

```
SELECT
  m.id,
  m.agency_id,
  a.name AS agency_name,
  m.role_id,
  r.name AS role_name,
  r.permissions
FROM memberships m
JOIN roles r ON r.id = m.role_id
LEFT JOIN agencies a ON a.id = m.agency_id
WHERE m.tenant_id = <tenantId>
  AND m.user_id = <userId>
```

(Source: `directives/auth-and-permissions.md` section 10, step 1.)

### Why LEFT JOIN on agencies

A membership with `agency_id = NULL` is a tenant-wide grant. There is no agencies row to join. A LEFT JOIN returns `NULL` for `agency_name` in this case, which correctly maps to the `null` value in the membership object.

### Query behavior

- Like user resolution, this query runs before RLS is activated. It explicitly filters by `tenant_id`.
- The query uses parameterized values. No string interpolation. (Source: `directives/security-baseline.md` section 6.)

---

## 7. Permission Flattening Algorithm

Permission flattening converts the array of membership objects (each carrying a role's permission map) into a single deduplicated set of granted permission strings. This is a pure computation with no I/O.

### Algorithm

```
Input:  memberships — array of objects, each with a `permissions` property (object)
Output: effectivePermissions — Set of strings

1. Create an empty Set.
2. For each membership in the memberships array:
   a. Read the membership's `permissions` object.
   b. For each key-value pair in the permissions object:
      i.  If the value is strictly `true` (not truthy — the boolean `true`):
          Add the key to the Set.
      ii. If the value is `false`, `null`, `undefined`, or any non-`true` value:
          Skip. Absence is denial. There is no explicit deny mechanism.
3. Return the Set.
```

### Properties

- **Additive.** Permissions accumulate across memberships. If any membership grants a permission, the user has it. (Source: `directives/auth-and-permissions.md` section 4.)
- **Idempotent.** Running the algorithm twice produces the same result. The Set automatically deduplicates.
- **Order-independent.** The result does not depend on the order of memberships or the order of keys within a permission map.
- **Empty-safe.** An empty memberships array produces an empty Set. A membership with an empty permissions map contributes nothing.
- **Strict boolean check.** Only the literal value `true` grants a permission. The value `1`, `"true"`, or any other truthy value does not grant. This prevents type-confusion bugs where a non-boolean value accidentally grants access.

### Edge cases

| Scenario | Result |
|---|---|
| User has zero memberships | Empty Set |
| User has one membership with `{}` permissions | Empty Set |
| User has two memberships granting the same permission | Set contains the permission once (deduplication) |
| Permission map contains a key with value `false` | Key is not added to the Set |
| Permission map contains a key with value `null` | Key is not added to the Set |
| Permission map contains an unknown permission key with value `true` | Key is added to the Set (the authorization middleware, not authentication, validates permission strings) |

### Why authentication does not validate permission keys

The 36 defined permission strings are documented in `directives/auth-and-permissions.md` section 5. However, validating that permission keys match this list is the authorization middleware's concern, not authentication's. Authentication's job is to faithfully represent what the database contains. If a role has an unrecognized permission key, authentication includes it in the Set and lets authorization decide whether it is meaningful.

---

## 8. Authentication Failure Handling Flow

### Unified failure response

Every failure at every step produces the same HTTP response. The middleware contains a single failure function that is reused across all steps.

### Failure function behavior (conceptual)

```
rejectAuthentication(req, res, internalReason)

1. Log the failure:
   - Level: warn
   - Include: req.requestId, internalReason, timestamp
   - Exclude: the raw token (never log tokens)

2. Send response:
   - Status: 401
   - Body:
     {
       "error": {
         "code": "UNAUTHENTICATED",
         "message": "Authentication required.",
         "request_id": req.requestId
       }
     }

3. Do NOT call next().
```

### Step-specific internal reasons

These strings are logged server-side for debugging. They are never sent to the client.

| Step | Condition | Internal Reason |
|---|---|---|
| 1 | Authorization header missing | `auth.header_missing` |
| 1 | Scheme is not Bearer | `auth.scheme_invalid` |
| 1 | Token is empty | `auth.token_empty` |
| 2 | Verification function throws | `auth.token_verification_failed: <error.message>` |
| 3 | `resolveTenant` returns null | `auth.tenant_not_found: <tenantIdentifier>` |
| 3 | `resolveTenant` throws | `auth.tenant_resolution_error` |
| 4 | `resolveUser` returns null | `auth.user_not_found` |
| 4 | User status is not active | `auth.user_inactive: <user.status>` |
| 4 | `resolveUser` throws | `auth.user_resolution_error` |
| 5 | `loadMemberships` throws | `auth.membership_loading_error` |

### Error propagation

Database errors (thrown by `resolveTenant`, `resolveUser`, or `loadMemberships`) are caught by the middleware and treated as authentication failures, not server errors. This is an intentional security decision: a `500` response with an error message during authentication reveals that the infrastructure is reachable but experiencing issues. A `401` reveals nothing. (Source: `directives/authentication-interface.md` section 6.)

### What is never logged

- The raw token value. Tokens are credentials — logging them creates a credential leakage vector.
- The verified claims. Claims may contain personally identifiable information.
- Database query results. User records and membership data are not relevant to failure logging.

---

## 9. Test Strategy

Tests for the authentication middleware are organized into two categories: unit tests (no real database, no real IdP) and integration tests (real database, stubbed IdP). All tests inject stub or test dependencies — they never import real IdP adapters or production database connections.

### Unit test categories

Unit tests exercise the middleware with fully stubbed dependencies. Each dependency is a function that returns predetermined values or throws predetermined errors.

#### Category 1: Token extraction

Tests the pure string parsing in step 1. No injected dependencies needed (extraction happens before any dependency is called).

| Test | Input | Expected |
|---|---|---|
| Missing Authorization header | No header | 401, `UNAUTHENTICATED` |
| Empty Authorization header | `Authorization: ` | 401, `UNAUTHENTICATED` |
| Wrong scheme | `Authorization: Basic abc123` | 401, `UNAUTHENTICATED` |
| Bearer with no token | `Authorization: Bearer ` | 401, `UNAUTHENTICATED` |
| Bearer with whitespace-only token | `Authorization: Bearer    ` | 401, `UNAUTHENTICATED` |
| Valid Bearer token | `Authorization: Bearer abc123` | Extraction succeeds, `verifyToken` called with `abc123` |
| Case-insensitive scheme | `Authorization: bearer abc123` | Extraction succeeds |
| Extra whitespace around token | `Authorization: Bearer  abc123  ` | Extraction succeeds, token is trimmed |

#### Category 2: Token verification failure

Stub `verifyToken` to throw. Verify the middleware sends `401` without calling downstream dependencies.

| Test | Stub behavior | Expected |
|---|---|---|
| Signature invalid | `verifyToken` throws | 401, `resolveTenant` never called |
| Token expired | `verifyToken` throws | 401, `resolveTenant` never called |
| Issuer mismatch | `verifyToken` throws | 401, `resolveTenant` never called |

#### Category 3: Tenant resolution failure

Stub `verifyToken` to succeed. Stub `resolveTenant` to return null or throw.

| Test | Stub behavior | Expected |
|---|---|---|
| Tenant not found | `resolveTenant` returns null | 401, `resolveUser` never called |
| Database error during tenant resolution | `resolveTenant` throws | 401, `resolveUser` never called |

#### Category 4: User resolution failure

Stub `verifyToken` and `resolveTenant` to succeed. Stub `resolveUser` to return null, return an inactive user, or throw.

| Test | Stub behavior | Expected |
|---|---|---|
| User not found | `resolveUser` returns null | 401, `loadMemberships` never called |
| User is disabled | `resolveUser` returns `{ status: 'disabled', ... }` | 401, `loadMemberships` never called |
| Database error during user resolution | `resolveUser` throws | 401, `loadMemberships` never called |

#### Category 5: Membership loading failure

Stub all prior steps to succeed. Stub `loadMemberships` to throw.

| Test | Stub behavior | Expected |
|---|---|---|
| Database error during membership loading | `loadMemberships` throws | 401 |

#### Category 6: Successful authentication

Stub all dependencies to succeed. Verify the full request context is populated.

| Test | Stub behavior | Verified |
|---|---|---|
| Full success with memberships | All succeed, memberships returned | `req.tenantId` is set to tenant.id |
| | | `req.userId` is set to user.id |
| | | `req.memberships` matches the loaded array |
| | | `req.effectivePermissions` is a Set |
| | | `next()` is called with no arguments |
| | | response is NOT sent by middleware |
| Full success with empty memberships | All succeed, empty array | `req.memberships` is `[]` |
| | | `req.effectivePermissions` is empty Set |
| | | `next()` is called |

#### Category 7: Permission flattening

Tests the pure algorithm from section 7 in isolation, without running the full middleware.

| Test | Input | Expected |
|---|---|---|
| Single membership, all true permissions | `[{ permissions: { "a.b": true, "c.d": true } }]` | Set `{"a.b", "c.d"}` |
| Single membership, mixed true/false | `[{ permissions: { "a.b": true, "c.d": false } }]` | Set `{"a.b"}` |
| Multiple memberships, overlapping | Two memberships both granting `"a.b"` | Set `{"a.b"}` (deduplicated) |
| Multiple memberships, complementary | One grants `"a.b"`, other grants `"c.d"` | Set `{"a.b", "c.d"}` |
| Empty memberships array | `[]` | Empty Set |
| Membership with empty permissions | `[{ permissions: {} }]` | Empty Set |
| Permission value is truthy but not `true` | `[{ permissions: { "a.b": 1 } }]` | Empty Set (strict boolean) |
| Permission value is null | `[{ permissions: { "a.b": null } }]` | Empty Set |

#### Category 8: Response format

Verify the `401` response matches the exact shape defined in `directives/authentication-interface.md` section 6.

| Test | Verified |
|---|---|
| Response has status 401 | Status code |
| Body has `error.code` = `"UNAUTHENTICATED"` | Error code string |
| Body has `error.message` = `"Authentication required."` | Error message string |
| Body has `error.request_id` matching `req.requestId` | Request ID correlation |
| Content-Type is `application/json` | Response type |
| Body does not contain stack trace | No information leakage |
| Body does not contain internal reason | No information leakage |

#### Category 9: Factory validation

Test the factory function's startup-time validation.

| Test | Input | Expected |
|---|---|---|
| All dependencies provided | Four functions | Returns middleware function |
| Missing `verifyToken` | Three functions, one undefined | Throws at factory call time |
| Dependency is not a function | `verifyToken: "not a function"` | Throws at factory call time |
| All dependencies missing | Empty object | Throws at factory call time |

### Integration test categories

Integration tests use a real test database (same schema as production, RLS enabled) and stubbed token verification. They verify that the resolution functions work correctly against actual table data.

#### Category 10: Tenant resolution against database

| Test | Setup | Expected |
|---|---|---|
| Tenant found by ID | Insert tenant, use `id` as identifier | Returns tenant object |
| Tenant found by slug | Insert tenant, use `slug` as identifier | Returns tenant object |
| Tenant not found | Use non-existent identifier | Returns null |
| Tenant query does not leak across tenants | Insert two tenants | Each resolves independently |

#### Category 11: User resolution against database

| Test | Setup | Expected |
|---|---|---|
| User found by auth_provider_id | Insert user with auth_provider_id | Returns user |
| User found by email (fallback) | Insert user without auth_provider_id | Returns user by email match |
| User email match is case-insensitive | Insert user with `User@Test.COM` | Match with `user@test.com` |
| auth_provider_id match takes priority | Insert two users, one with matching auth_provider_id, one with matching email | Returns the auth_provider_id match |
| User in wrong tenant not returned | Insert user in tenant A, resolve in tenant B | Returns null |
| Disabled user is returned (middleware rejects) | Insert user with `status: 'disabled'` | Returns user (status check is middleware's job) |

#### Category 12: Membership loading against database

| Test | Setup | Expected |
|---|---|---|
| User with one membership | Insert membership + role | Array with one element, correct shape |
| User with multiple memberships | Insert three memberships, different roles | Array with three elements |
| User with zero memberships | Insert user, no memberships | Empty array |
| Tenant-wide membership | Insert membership with `agency_id = NULL` | Element has `agency_id: null`, `agency_name: null` |
| Agency-scoped membership | Insert membership with agency | Element has `agency_id` and `agency_name` populated |
| Role permissions are included | Insert role with `{ "reports.read": true }` | Membership element has matching `permissions` object |
| Memberships from other tenants not returned | Insert memberships in two tenants | Only current tenant's memberships returned |

#### Category 13: End-to-end middleware with test database

| Test | Setup | Expected |
|---|---|---|
| Full success through middleware | Stub verifyToken, real DB with tenant + user + memberships | `req.tenantId`, `req.userId`, `req.memberships`, `req.effectivePermissions` all populated correctly |
| Token verification failure with real DB | Stub verifyToken to throw, real DB | 401, no DB queries executed |
| User disabled with real DB | Stub verifyToken, real DB with disabled user | 401 |

---

## 10. Future Integration Points

These are the points where future implementation work will connect to the authentication middleware. Each integration point is designed so that it plugs into the existing injection interface without changing the middleware or any directive.

### IdP adapter (verifyToken implementation)

When the identity provider is selected (Entra ID, Okta, Auth0, or other), an adapter module will be created that implements the `verifyToken` interface from section 3. This module:

- Lives in `/config/` or a dedicated `/auth/` directory (not in `/api/middleware/`).
- Handles JWKS endpoint discovery, public key caching, and key rotation.
- Is injected into the authentication factory at server startup in `index.js`.
- Is the only place in the codebase that knows which IdP is in use.

### Database query functions (resolveTenant, resolveUser, loadMemberships implementations)

When the database connection is implemented, three query functions will be created that implement the interfaces from sections 4, 5, and 6. These functions:

- Live in `/execution/logic/` (per `CLAUDE.md` folder rules — pure business logic, no HTTP concerns).
- Accept a database connection or pool as a parameter (not imported globally).
- Use parameterized queries exclusively (source: `directives/security-baseline.md` section 6).
- Are injected into the authentication factory at server startup.

### Test fixtures

When integration tests are implemented, test fixtures will:

- Use a dedicated test database with the same schema as production (source: `directives/security-baseline.md` section 10).
- Insert test tenants, users, roles, memberships, and agencies as setup.
- Use a stub `verifyToken` that returns predetermined claims matching the test data.
- Inject real query functions connected to the test database.

### Server startup wiring

The `index.js` entry point (or a dedicated startup module) will:

1. Initialize the database connection pool.
2. Initialize the IdP adapter (verifyToken function).
3. Create the query functions bound to the pool.
4. Call `createAuthenticationMiddleware({ verifyToken, resolveTenant, resolveUser, loadMemberships })`.
5. Register the returned middleware on the Express app.

This wiring replaces the current skeleton middleware (`authentication.js` that simply calls `next()`) with the real implementation, without changing any route, directive, or other middleware.

### Rate limiting (post-MVP)

When rate limiting is added (source: `directives/security-baseline.md` section 7), it will be registered before the authentication middleware in the chain. The authentication middleware does not need to change — rate limiting is an independent edge concern.

### Middleware bypass mechanism

When the real authentication middleware replaces the skeleton, the bypass rules from `directives/middleware-architecture.md` section 10 must be implemented. Health endpoints (`/health/live`, `/health/ready`) skip authentication entirely. This is implemented at the Express routing level — health routes are registered before the authentication middleware, so the middleware never executes for those paths. This is already the case if health routes are registered on a separate router that does not include the auth middleware. The current `server.js` structure supports this pattern.
