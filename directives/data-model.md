# Directive: MVP Data Model

## Status
Approved — all tables, relationships, and policies defined here are the source of truth for migration scripts in `/execution/migrations/`.

## Scope
13-table Postgres schema for a multi-tenant government reporting and compliance platform.

---

## Conventions

- All primary keys are `uuid`, defaulting to `gen_random_uuid()`.
- All tenant-scoped tables carry a `NOT NULL tenant_id` column with a foreign key to `tenants.id`.
- All timestamps are `timestamptz`.
- Tables that track creation time include `created_at` (default `now()`).
- Tables that track modification include `updated_at` (default `now()`, updated via trigger).
- No soft deletes. Deletion events are captured in `audit_logs` with a before-snapshot in `metadata`.
- `jsonb` is used for flexible fields that must remain queryable but whose internal structure varies by tenant or rule type.
- Secrets are never stored in the database. External references (vault key names) are permitted; credentials, tokens, and passwords are not.

---

## Table Definitions

### 1. tenants

**Purpose:** Top-level isolation boundary. Represents an organization (a state government, a federal agency, a municipal authority). Every tenant-scoped table traces back to this table.

| Column | Type | Constraints |
|---|---|---|
| id | uuid | PK, default `gen_random_uuid()` |
| name | text | NOT NULL |
| slug | text | UNIQUE, NOT NULL |
| status | text | NOT NULL; values: `active`, `suspended`, `offboarded` |
| created_at | timestamptz | NOT NULL, default `now()` |
| updated_at | timestamptz | NOT NULL, default `now()` |

**Tenant isolation:** This is the tenant. No `tenant_id` column. Access is controlled by application-layer routing.

**RLS:** Not applied. The application resolves the tenant from the auth context and never queries across tenants at this level.

**Indexes:** Unique index on `slug`.

---

### 2. agencies

**Purpose:** Sub-divisions within a tenant. Agencies represent departments or bureaus (e.g., Department of Health, Bureau of Finance) that operate independently within the same tenant.

| Column | Type | Constraints |
|---|---|---|
| id | uuid | PK |
| tenant_id | uuid | NOT NULL, FK → `tenants.id` |
| name | text | NOT NULL |
| code | text | Nullable; optional short identifier (e.g., `DOH`) |
| created_at | timestamptz | NOT NULL, default `now()` |

**Tenant isolation:** `tenant_id` required.

**Agency scoping:** This is the agency boundary. Other tables reference `agency_id` to inherit agency-level separation.

**RLS:** Tenant-level policy on `tenant_id`.

**Indexes:**
- `(tenant_id)`

---

### 3. users

**Purpose:** Human operators who interact with the platform. A user belongs to exactly one tenant. Cross-tenant access is not supported in MVP.

| Column | Type | Constraints |
|---|---|---|
| id | uuid | PK |
| tenant_id | uuid | NOT NULL, FK → `tenants.id` |
| email | text | NOT NULL |
| display_name | text | Nullable |
| auth_provider_id | text | Nullable; external IdP subject identifier |
| status | text | NOT NULL; values: `active`, `disabled` |
| created_at | timestamptz | NOT NULL, default `now()` |

**Tenant isolation:** `tenant_id` required.

**Agency scoping:** Users are not directly scoped to agencies. Agency access is determined by the `memberships` table.

**RLS:** Tenant-level policy on `tenant_id`.

**Indexes:**
- `(tenant_id)`
- Unique: `(tenant_id, email)`

---

### 4. roles

**Purpose:** Named permission sets. Each tenant can define custom roles. Permissions are stored as a flat JSON map so the authorization middleware can check them without joins.

| Column | Type | Constraints |
|---|---|---|
| id | uuid | PK |
| tenant_id | uuid | NOT NULL, FK → `tenants.id` |
| name | text | NOT NULL |
| permissions | jsonb | NOT NULL; flat map, e.g., `{"reports.create": true}` |
| created_at | timestamptz | NOT NULL, default `now()` |

**Tenant isolation:** `tenant_id` required.

**Agency scoping:** Roles are tenant-wide definitions. Agency-specific assignment happens in `memberships`.

**RLS:** Tenant-level policy on `tenant_id`.

**Indexes:**
- Unique: `(tenant_id, name)`

---

### 5. memberships

**Purpose:** Authorization pivot table. Associates a user with a role, optionally scoped to a specific agency. A `NULL` `agency_id` means the role applies tenant-wide (e.g., tenant administrator).

| Column | Type | Constraints |
|---|---|---|
| id | uuid | PK |
| tenant_id | uuid | NOT NULL, FK → `tenants.id` |
| user_id | uuid | NOT NULL, FK → `users.id` |
| agency_id | uuid | Nullable, FK → `agencies.id` |
| role_id | uuid | NOT NULL, FK → `roles.id` |
| created_at | timestamptz | NOT NULL, default `now()` |

**Tenant isolation:** `tenant_id` required.

**Agency scoping:** `agency_id` is nullable. When present, the role grant applies only within that agency. When null, the role applies across all agencies in the tenant.

**RLS:** Tenant-level policy on `tenant_id`.

**Indexes:**
- Unique: `(tenant_id, user_id, agency_id, role_id)` — prevents duplicate grants
- `(tenant_id, user_id)` — fast lookup for "what can this user do?"

---

### 6. data_sources

**Purpose:** Registered connections to external data. Each data source represents an API, SFTP endpoint, database link, or file upload channel that the platform pulls data from.

| Column | Type | Constraints |
|---|---|---|
| id | uuid | PK |
| tenant_id | uuid | NOT NULL, FK → `tenants.id` |
| agency_id | uuid | Nullable, FK → `agencies.id` |
| name | text | NOT NULL |
| source_type | text | NOT NULL; values: `api`, `sftp`, `database`, `file_upload` |
| connection_config | jsonb | Nullable; non-secret configuration only (host, path, schedule) |
| status | text | NOT NULL; values: `active`, `disabled`, `error` |
| created_at | timestamptz | NOT NULL, default `now()` |

**Tenant isolation:** `tenant_id` required.

**Agency scoping:** `agency_id` is nullable. When null, the data source is tenant-wide. When present, it belongs to a specific agency.

**Secret handling:** `connection_config` must never contain credentials, tokens, passwords, or API keys. Secrets are stored in an external secrets manager and referenced by key name only.

**RLS:** Tenant-level policy on `tenant_id`. Post-MVP: add agency-level policy.

**Indexes:**
- `(tenant_id)`
- `(tenant_id, agency_id)`

---

### 7. ingestion_runs

**Purpose:** Records each execution of a data pull from a data source. Created by worker jobs in `/workers/`. One data source produces many ingestion runs over time.

| Column | Type | Constraints |
|---|---|---|
| id | uuid | PK |
| tenant_id | uuid | NOT NULL, FK → `tenants.id` |
| data_source_id | uuid | NOT NULL, FK → `data_sources.id` |
| status | text | NOT NULL; values: `pending`, `running`, `success`, `failed` |
| records_fetched | integer | Nullable |
| error_message | text | Nullable |
| started_at | timestamptz | Nullable |
| completed_at | timestamptz | Nullable |
| created_at | timestamptz | NOT NULL, default `now()` |

**Tenant isolation:** `tenant_id` required.

**Agency scoping:** Inherited from `data_source → agency_id`. No direct `agency_id` column.

**RLS:** Tenant-level policy on `tenant_id`.

**Indexes:**
- `(tenant_id, data_source_id, created_at DESC)` — latest runs for a source

---

### 8. compliance_rules

**Purpose:** Declarative rule definitions that specify what "compliant" means. Rules are evaluated by deterministic scripts in `/execution/logic/`, never by LLM inference. Each rule produces machine-readable results when run against ingested data.

| Column | Type | Constraints |
|---|---|---|
| id | uuid | PK |
| tenant_id | uuid | NOT NULL, FK → `tenants.id` |
| agency_id | uuid | Nullable, FK → `agencies.id` |
| name | text | NOT NULL |
| rule_type | text | NOT NULL; values: `threshold`, `presence`, `format`, `custom_sql` |
| definition | jsonb | NOT NULL; machine-readable rule spec consumed by execution scripts |
| severity | text | NOT NULL; values: `critical`, `high`, `medium`, `low` |
| is_active | boolean | NOT NULL, default `true` |
| created_at | timestamptz | NOT NULL, default `now()` |
| updated_at | timestamptz | NOT NULL, default `now()` |

**Tenant isolation:** `tenant_id` required.

**Agency scoping:** `agency_id` is nullable. When null, the rule applies to all agencies in the tenant. When present, it applies to that agency only.

**Custom SQL safety:** When `rule_type` is `custom_sql`, the `definition.sql` field must be validated at write time to ensure it is read-only (SELECT only, no DDL/DML).

**RLS:** Tenant-level policy on `tenant_id`. Post-MVP: add agency-level policy.

**Indexes:**
- `(tenant_id, agency_id) WHERE is_active = true` — partial index for active rules

---

### 9. compliance_runs

**Purpose:** Represents a single batch evaluation of compliance rules against data from an ingestion run. This table was added to bridge the gap between `ingestion_runs` (data acquisition) and `compliance_results` (individual rule outcomes).

#### Design Decision

Without this table, the system has no record of the evaluation batch itself — only individual results. This creates three problems:

1. **Failure ambiguity.** If a batch fails halfway, there is no record that evaluation was incomplete. You would have results for some rules and silence for others, with no way to distinguish "not yet evaluated" from "evaluated and passed."

2. **Retry fragility.** Retrying requires diffing existing results against the active rule set to find gaps. A compliance run gives workers a single handle to retry.

3. **Audit gap.** Government auditors ask "when was compliance last evaluated?" The answer must be a first-class record with a timestamp and status, not a derived aggregation.

One ingestion run can have multiple compliance runs (initial evaluation, re-evaluation after rule changes, manual re-trigger). Each compliance run produces its own set of compliance results.

| Column | Type | Constraints |
|---|---|---|
| id | uuid | PK |
| tenant_id | uuid | NOT NULL, FK → `tenants.id` |
| ingestion_run_id | uuid | NOT NULL, FK → `ingestion_runs.id` |
| status | text | NOT NULL; values: `pending`, `running`, `success`, `partial_failure`, `failed` |
| rules_evaluated | integer | Nullable; count of rules attempted |
| rules_passed | integer | Nullable |
| rules_failed | integer | Nullable |
| error_message | text | Nullable; top-level batch error |
| triggered_by | text | NOT NULL; values: `automatic`, `manual`, `retroactive` |
| started_at | timestamptz | Nullable |
| completed_at | timestamptz | Nullable |
| created_at | timestamptz | NOT NULL, default `now()` |

**Denormalized counts:** `rules_evaluated`, `rules_passed`, and `rules_failed` are written once at batch completion. They exist so dashboard queries do not require `COUNT(*)` aggregation over `compliance_results` for every run.

**Tenant isolation:** `tenant_id` required.

**Agency scoping:** Inherited from `ingestion_run → data_source → agency_id`. No direct `agency_id` column.

**RLS:** Tenant-level policy on `tenant_id`.

**Indexes:**
- `(tenant_id, ingestion_run_id, created_at DESC)` — all evaluations of an ingestion
- `(tenant_id, status)` — find failed/pending runs for retry

---

### 10. compliance_results

**Purpose:** The outcome of evaluating a single compliance rule within a single compliance run. This is the leaf-level audit record: one row per rule per evaluation.

| Column | Type | Constraints |
|---|---|---|
| id | uuid | PK |
| tenant_id | uuid | NOT NULL, FK → `tenants.id` |
| compliance_run_id | uuid | NOT NULL, FK → `compliance_runs.id` |
| compliance_rule_id | uuid | NOT NULL, FK → `compliance_rules.id` |
| status | text | NOT NULL; values: `pass`, `fail`, `error`, `skipped` |
| details | jsonb | Nullable; structured evidence (failing records, counts, thresholds) |
| evaluated_at | timestamptz | NOT NULL |
| created_at | timestamptz | NOT NULL, default `now()` |

**FK note:** This table references `compliance_runs.id`, not `ingestion_runs.id` directly. The ingestion run is reachable via `compliance_run → ingestion_run`. This prevents two paths to the same data with no mechanism to guarantee consistency.

**Tenant isolation:** `tenant_id` required.

**Agency scoping:** Inherited through `compliance_run → ingestion_run → data_source → agency_id`.

**RLS:** Tenant-level policy on `tenant_id`. Post-MVP: add agency-level policy.

**Volume note:** This is one of the two highest-volume tables. Consider partitioning by `evaluated_at` post-MVP when volume warrants it.

**Indexes:**
- `(tenant_id, compliance_run_id)` — all results for a run
- `(tenant_id, compliance_rule_id, evaluated_at DESC)` — rule history over time

---

### 11. reports

**Purpose:** A generated compliance report that aggregates results into a reviewable, approvable document. Reports follow a lifecycle from draft through approval to publication.

| Column | Type | Constraints |
|---|---|---|
| id | uuid | PK |
| tenant_id | uuid | NOT NULL, FK → `tenants.id` |
| agency_id | uuid | Nullable, FK → `agencies.id` |
| title | text | NOT NULL |
| report_type | text | NOT NULL; values: `quarterly`, `annual`, `ad_hoc`, `audit_response` |
| status | text | NOT NULL; values: `draft`, `generating`, `review`, `approved`, `published` |
| parameters | jsonb | Nullable; date range, rule filters, inclusion flags |
| content | jsonb | Nullable; structured report body, populated asynchronously |
| created_by | uuid | NOT NULL, FK → `users.id` |
| approved_by | uuid | Nullable, FK → `users.id` |
| created_at | timestamptz | NOT NULL, default `now()` |
| updated_at | timestamptz | NOT NULL, default `now()` |

**Status transitions:**
```
draft → generating → review → approved → published
                       ↘ draft (rejection)
```

**Separation of duties:** `created_by` and `approved_by` must be different users. The API enforces this constraint on the `approved` transition.

**Tenant isolation:** `tenant_id` required.

**Agency scoping:** `agency_id` is nullable. When present, the report is scoped to that agency.

**RLS:** Tenant-level policy on `tenant_id`. Post-MVP: add agency-level policy.

**Indexes:**
- `(tenant_id, agency_id, created_at DESC)`

---

### 12. report_exports

**Purpose:** Physical file exports of a report (PDF, CSV, XLSX). The actual files are stored in object storage (S3/GCS); this table tracks metadata and provides a handle for download URL generation.

| Column | Type | Constraints |
|---|---|---|
| id | uuid | PK |
| tenant_id | uuid | NOT NULL, FK → `tenants.id` |
| report_id | uuid | NOT NULL, FK → `reports.id` |
| format | text | NOT NULL; values: `pdf`, `csv`, `xlsx` |
| storage_path | text | NOT NULL; object storage key, never exposed to clients |
| file_size_bytes | bigint | Nullable |
| exported_by | uuid | NOT NULL, FK → `users.id` |
| created_at | timestamptz | NOT NULL, default `now()` |

**Security:** `storage_path` is an internal reference. Clients receive time-limited presigned URLs generated at request time, never the raw path.

**Tenant isolation:** `tenant_id` required.

**Agency scoping:** Inherited from `report → agency_id`.

**RLS:** Tenant-level policy on `tenant_id`. Post-MVP: add agency-level policy.

**Indexes:**
- `(tenant_id, report_id)`

---

### 13. audit_logs

**Purpose:** Append-only ledger of every significant action in the system. This is the primary audit trail for government compliance. Rows are immutable — they are never updated or deleted.

| Column | Type | Constraints |
|---|---|---|
| id | uuid | PK |
| tenant_id | uuid | NOT NULL, FK → `tenants.id` |
| actor_id | uuid | Nullable, FK → `users.id`; null for system-initiated actions |
| actor_type | text | NOT NULL; values: `user`, `system`, `api_key` |
| action | text | NOT NULL; e.g., `report.approved`, `rule.created`, `export.downloaded` |
| resource_type | text | NOT NULL; table name of the affected resource |
| resource_id | uuid | NOT NULL; primary key of the affected row |
| metadata | jsonb | Nullable; before/after snapshot, IP address, user-agent |
| occurred_at | timestamptz | NOT NULL |

**Immutability requirement:** This table must never have UPDATE or DELETE operations performed against it. Enforce this through:
1. Application-level policy: no update/delete queries are ever written.
2. Database-level policy: a trigger that raises an exception on UPDATE or DELETE operations.
3. RLS policy: the `WITH CHECK` clause permits INSERT only; the application role has no UPDATE or DELETE grants on this table.

All three layers are required. A single layer is insufficient because application bugs, direct database access, or permission changes could bypass any individual control.

**No `updated_at` column.** Rows are write-once.

**No `created_at` column.** `occurred_at` serves this purpose and carries the semantically correct name — the event occurred at a specific time, not "was created."

**Tenant isolation:** `tenant_id` required.

**Agency scoping:** The agency is derivable from the referenced resource. Post-MVP, agency-level RLS prevents agency-scoped auditors from seeing cross-agency entries.

**RLS:** Tenant-level policy on `tenant_id`.

**Partitioning:** Range-partition by `occurred_at` using monthly partitions from day one. Audit logs grow unboundedly and are rarely queried beyond 90 days for operational purposes (though they must be retained per policy). Partitioning keeps recent-data queries fast without affecting retention.

**Indexes:**
- `(tenant_id, occurred_at DESC)` — primary query path
- `(tenant_id, resource_type, resource_id)` — audit trail for a specific resource

---

## Relationship Map

```
tenants
├── agencies
├── users
├── roles
├── memberships ──→ users, roles, agencies (nullable)
├── data_sources ──→ agencies (nullable)
│   └── ingestion_runs
│       └── compliance_runs
│           └── compliance_results ──→ compliance_rules
├── compliance_rules ──→ agencies (nullable)
├── reports ──→ agencies (nullable), users (created_by, approved_by)
│   └── report_exports ──→ users (exported_by)
└── audit_logs ──→ users (actor_id, nullable)
```

All arrows from child tables to `tenants` are enforced NOT NULL foreign keys. The `agency_id` foreign key is nullable on `memberships`, `data_sources`, `compliance_rules`, and `reports` — representing tenant-wide scope when null.

---

## Row-Level Security Strategy

### Tenant isolation policy (applied to all 12 tenant-scoped tables)

```
Policy name: tenant_isolation
  USING  (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid)
```

The application sets `app.current_tenant_id` via `SET LOCAL` at the start of each transaction. This guarantees tenant isolation at the database level, independent of application-layer bugs.

### Tables requiring RLS

| Table | Tenant RLS (MVP) | Agency RLS (Post-MVP) |
|---|---|---|
| agencies | Yes | No — users see all agencies they have memberships in |
| users | Yes | No — user list is tenant-scoped |
| roles | Yes | No — roles are tenant-wide definitions |
| memberships | Yes | No — membership queries are user-scoped |
| data_sources | Yes | Yes |
| ingestion_runs | Yes | Yes (via data_source join) |
| compliance_runs | Yes | Yes (via ingestion_run → data_source join) |
| compliance_rules | Yes | Yes |
| compliance_results | Yes | Yes (via compliance_run chain) |
| reports | Yes | Yes |
| report_exports | Yes | Yes (via report join) |
| audit_logs | Yes | Yes |

### Application role grants

The application connects to Postgres with a role that has:
- SELECT, INSERT, UPDATE, DELETE on all tables except `audit_logs`
- SELECT, INSERT only on `audit_logs` (no UPDATE, no DELETE)
- No TRUNCATE, DROP, or DDL permissions
- FORCE ROW LEVEL SECURITY enabled so RLS applies even to table owners

---

## Index Summary

| Table | Index | Purpose |
|---|---|---|
| tenants | Unique on `slug` | Slug-based lookup |
| agencies | `(tenant_id)` | Tenant-scoped listing |
| users | `(tenant_id)` | Tenant-scoped listing |
| users | Unique `(tenant_id, email)` | Prevent duplicate emails within tenant |
| roles | Unique `(tenant_id, name)` | Prevent duplicate role names within tenant |
| memberships | Unique `(tenant_id, user_id, agency_id, role_id)` | Prevent duplicate grants |
| memberships | `(tenant_id, user_id)` | User permission lookup |
| data_sources | `(tenant_id)` | Tenant-scoped listing |
| data_sources | `(tenant_id, agency_id)` | Agency-scoped listing |
| ingestion_runs | `(tenant_id, data_source_id, created_at DESC)` | Latest runs per source |
| compliance_runs | `(tenant_id, ingestion_run_id, created_at DESC)` | Evaluations per ingestion |
| compliance_runs | `(tenant_id, status)` | Failed run lookup for retry |
| compliance_rules | `(tenant_id, agency_id) WHERE is_active = true` | Active rules per agency |
| compliance_results | `(tenant_id, compliance_run_id)` | Results per run |
| compliance_results | `(tenant_id, compliance_rule_id, evaluated_at DESC)` | Rule history |
| reports | `(tenant_id, agency_id, created_at DESC)` | Agency report listing |
| report_exports | `(tenant_id, report_id)` | Exports per report |
| audit_logs | `(tenant_id, occurred_at DESC)` | Chronological audit query |
| audit_logs | `(tenant_id, resource_type, resource_id)` | Resource-specific audit trail |

All composite indexes that include `tenant_id` as the leading column ensure that tenant-scoped queries use index scans rather than sequential scans across all tenants.

---

## Migration Implementation Notes

When implementing this schema as migration scripts in `/execution/migrations/`:

1. **Table creation order matters.** Tables must be created in dependency order: `tenants` first, then tables that reference only `tenants`, then tables that reference those, and so on. A safe order: tenants → agencies → users → roles → memberships → data_sources → ingestion_runs → compliance_rules → compliance_runs → compliance_results → reports → report_exports → audit_logs.

2. **RLS enablement is a separate migration.** Create tables first, then enable RLS and create policies in a follow-up migration. This keeps each migration focused on one responsibility.

3. **The audit_logs immutability trigger is a separate migration.** Create the table, then add the trigger that prevents UPDATE and DELETE.

4. **Audit_logs partitioning is a separate migration.** Create the base table structure, then convert to a partitioned table with monthly ranges.

5. **Each migration is forward-only.** No down migrations in MVP. Rollback is handled by restoring from backup, not by reversing migrations.
