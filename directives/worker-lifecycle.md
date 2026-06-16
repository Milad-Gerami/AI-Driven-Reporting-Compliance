# Directive: Worker Lifecycle

## Status
Approved — all worker responsibilities, status transitions, retry policies, idempotency requirements, and failure handling rules defined here are the source of truth for worker implementations in `/workers/`, queue configuration in `/services/worker/`, and the execution logic they invoke from `/execution/logic/`.

## Scope
Lifecycle management for the four background worker types in the platform: ingestion runner, compliance evaluator, report generator, and export renderer. References the schema in `directives/data-model.md`, the API contract in `directives/api-contract.md`, and the audit policy in `directives/audit-policy.md`.

---

## 1. Worker Responsibilities

Each worker type in `/workers/` has a single responsibility. Workers are job handlers pulled from a queue — they do not contain business logic directly. They orchestrate calls to functions in `/execution/logic/` and manage the lifecycle of the database row that represents their work.

### ingestion-runner

Pulls data from an external data source and stores the results. Owns the `ingestion_runs` row lifecycle.

- Reads `data_sources.connection_config` to determine how to connect.
- Fetches data from the external source (API call, SFTP download, database query, file read).
- Stores fetched data in the platform's internal storage (staging tables or object storage, depending on source type).
- Updates the `ingestion_runs` row with status, `records_fetched`, timestamps, and error info.
- On success, enqueues a compliance evaluation job for the completed ingestion run.

### compliance-evaluator

Evaluates compliance rules against data from a completed ingestion run. Owns the `compliance_runs` row lifecycle and writes `compliance_results` rows.

- Loads all active `compliance_rules` applicable to the ingestion run's data source (matching `tenant_id` and `agency_id` or tenant-wide rules).
- Evaluates each rule by calling the appropriate function in `/execution/logic/` based on `rule_type` (`threshold`, `presence`, `format`, `custom_sql`).
- Writes one `compliance_results` row per rule evaluated.
- Updates the `compliance_runs` row with status, counts, timestamps, and error info.

### report-generator

Builds report content from compliance results. Owns the `reports` row lifecycle during the `generating` phase.

- Reads the report's `parameters` to determine date range, rule filters, and inclusion flags.
- Queries `compliance_results` (joined through `compliance_runs`) for the relevant data.
- Assembles structured content into the `reports.content` jsonb field.
- Transitions the report status from `generating` to `review`.

### export-renderer

Renders a report into a downloadable file format. Owns the `report_exports` row lifecycle.

- Reads the report's `content` field.
- Renders it into the requested format (`pdf`, `csv`, `xlsx`).
- Uploads the rendered file to object storage.
- Updates the `report_exports` row with `storage_path` and `file_size_bytes`.

---

## 2. Job Payload and Tenant Context

### Every job payload must include `tenant_id`

The queue job payload for every worker type must contain `tenant_id` as a top-level field. This is non-negotiable. The worker uses this to set the database context before performing any operation.

### Payload structure

All job payloads follow this base structure:

```json
{
  "tenant_id": "uuid",
  "job_type": "string",
  "resource_id": "uuid",
  "enqueued_at": "iso8601",
  "attempt": 1,
  "metadata": {}
}
```

| Field | Required | Description |
|---|---|---|
| `tenant_id` | Yes | The tenant this job belongs to. |
| `job_type` | Yes | One of: `ingestion`, `compliance_evaluation`, `report_generation`, `export_rendering`. |
| `resource_id` | Yes | The primary key of the row the worker will operate on (ingestion_run id, compliance_run id, report id, or report_export id). |
| `enqueued_at` | Yes | When the job was placed on the queue. Used for staleness detection. |
| `attempt` | Yes | Current attempt number. Starts at 1, incremented by the queue on each retry. |
| `metadata` | No | Job-type-specific fields (e.g., `triggered_by` for compliance evaluation). |

### Tenant context setup

Before performing any database operation, the worker must:

1. Validate that `tenant_id` is present and is a valid UUID.
2. Execute `SET LOCAL app.current_tenant_id = '<tenant_id>'` on the database connection.
3. Verify the tenant exists and has status `active`. If the tenant is `suspended` or `offboarded`, discard the job without retry (the work is no longer valid).

This must happen at the start of every job execution, including retries. The tenant context is never carried over from a previous job.

### Multi-tenant workers

A single worker process may handle jobs for multiple tenants. The tenant context is set per-job, not per-process. There is no shared state between jobs for different tenants.

---

## 3. Ingestion Run Lifecycle

### Trigger

An ingestion run is created when:
- A scheduled job fires based on the data source's configured schedule, or
- A user triggers a retry via `POST .../ingestion-runs/:run_id/retry` (which creates a new ingestion run row and enqueues a job).

### State machine

```
pending → running → success
                  → failed
```

| Transition | Who | When |
|---|---|---|
| → `pending` | API (retry) or scheduler | Job is enqueued |
| `pending` → `running` | Worker | Job is picked up and execution begins |
| `running` → `success` | Worker | Data fetched and stored without error |
| `running` → `failed` | Worker | Unrecoverable error during fetch |

There is no `partial_success` state for ingestion. Ingestion either fetches all requested data or it fails.

### Worker steps

1. **Claim the job.** Set `ingestion_runs.status = 'running'` and `started_at = now()`. Audit: `ingestion_run.started`.
2. **Resolve the data source.** Load `data_sources` row by `data_source_id`. If the data source is `disabled` or `error`, fail immediately (do not attempt connection).
3. **Fetch data.** Call the appropriate fetch function in `/execution/logic/` based on `source_type`. Pass `connection_config` and any schedule-specific parameters.
4. **Store data.** Write fetched records to internal staging. Count records fetched.
5. **On success:**
   - Set `status = 'success'`, `records_fetched = <count>`, `completed_at = now()`.
   - Audit: `ingestion_run.completed`.
   - Enqueue a compliance evaluation job: `{ job_type: 'compliance_evaluation', resource_id: <new compliance_run id>, tenant_id, metadata: { triggered_by: 'automatic' } }`.
   - The compliance run row (`status = 'pending'`, `triggered_by = 'automatic'`) is created in the same transaction as the ingestion success update.
6. **On failure:**
   - Set `status = 'failed'`, `error_message = <message>`, `completed_at = now()`.
   - Audit: `ingestion_run.failed` with `metadata.error_message`.

### Automatic compliance trigger

When an ingestion run succeeds, the worker creates a `compliance_runs` row and enqueues a compliance evaluation job in the same transaction. This guarantees that every successful ingestion is evaluated — there is no window where data exists without a pending evaluation.

---

## 4. Compliance Run Lifecycle

### Trigger

A compliance run is created when:
- An ingestion run completes successfully (automatic, created by the ingestion worker).
- A user triggers manual evaluation via `POST /api/v1/compliance-runs`.
- A user retries a failed run via `POST /api/v1/compliance-runs/:run_id/retry`.

### State machine

```
pending → running → success
                  → partial_failure
                  → failed
```

| Transition | Who | When |
|---|---|---|
| → `pending` | Ingestion worker, API | Run row created, job enqueued |
| `pending` → `running` | Worker | Job picked up, evaluation begins |
| `running` → `success` | Worker | All rules evaluated without error |
| `running` → `partial_failure` | Worker | Some rules evaluated, some errored |
| `running` → `failed` | Worker | Batch-level error before or during evaluation |

### Worker steps

1. **Claim the job.** Set `compliance_runs.status = 'running'` and `started_at = now()`. Audit: `compliance_run.started`.
2. **Load applicable rules.** Query `compliance_rules` where `is_active = true` and (`agency_id` matches the data source's agency OR `agency_id IS NULL` for tenant-wide rules) and `tenant_id` matches.
3. **Evaluate each rule.** For each rule, call the evaluation function in `/execution/logic/` matching the `rule_type`:
   - `threshold` → threshold evaluator
   - `presence` → presence checker
   - `format` → format validator
   - `custom_sql` → SQL executor (read-only, sandboxed)
4. **Write results.** For each rule, insert a `compliance_results` row with `status` (`pass`, `fail`, `error`, `skipped`) and `details`. Each result is written individually, not batched, so partial progress is visible.
5. **Determine outcome:**
   - If all rules evaluated without error → `success`.
   - If some rules returned `error` status → `partial_failure`.
   - If a batch-level error occurred (database timeout, connection loss, out of memory) → `failed`.
6. **Update the run.**
   - Set `status`, `rules_evaluated`, `rules_passed`, `rules_failed`, `completed_at = now()`.
   - Set `error_message` if `failed` or `partial_failure`.
   - Audit: `compliance_run.completed`, `compliance_run.partial_failure`, or `compliance_run.failed`.

### Rule evaluation isolation

Each rule is evaluated independently. A failure in one rule must not prevent other rules from being evaluated. The worker catches errors per-rule and writes a `compliance_results` row with `status = 'error'` for any rule that throws. Only a batch-level error (affecting the worker process itself, not a single rule) causes the entire run to fail.

### Skipped rules

A rule is marked `skipped` if:
- The rule's `rule_type` requires data that is not present in the ingestion (e.g., a `custom_sql` rule referencing a table that the data source didn't populate).
- The rule was deactivated between the time the run was created and the time evaluation began (race condition). The worker re-checks `is_active` at evaluation time.

---

## 5. Report Generation Lifecycle

### Trigger

A report generation job is enqueued when:
- A user creates a report via `POST /api/v1/agencies/:aid/reports`. The API creates the `reports` row with `status = 'generating'` and enqueues the job.

### State machine (worker-managed portion)

```
generating → review
           → failed (implicit — see failure handling)
```

The full report state machine is defined in `directives/api-contract.md`. The worker only manages the `generating → review` transition. All other transitions (`review → approved → published`, `review → draft`) are API-driven.

| Transition | Who | When |
|---|---|---|
| → `generating` | API | Report created, job enqueued |
| `generating` → `review` | Worker | Content assembled successfully |
| `generating` → `draft` | Worker | Generation failed, report reverts to draft for user action |

### Worker steps

1. **Claim the job.** Verify `reports.status = 'generating'`. If the report is in any other status (e.g., the user deleted it while the job was queued), discard the job.
2. **Load parameters.** Read `reports.parameters` for date range, rule filters, and inclusion flags.
3. **Query results.** Load `compliance_results` joined through `compliance_runs` and `ingestion_runs` for the relevant date range, agency, and rules.
4. **Assemble content.** Call the report-building function in `/execution/logic/` to structure the data into the `reports.content` jsonb format.
5. **On success:**
   - Set `reports.content = <structured content>`, `status = 'review'`, `updated_at = now()`.
   - Audit: `report.status_changed` with `metadata.status_from = 'generating'`, `metadata.status_to = 'review'`.
6. **On failure:**
   - Set `status = 'draft'`, `updated_at = now()`. The report reverts to draft so the user can modify parameters or retry.
   - Audit: `report.status_changed` with `metadata.status_from = 'generating'`, `metadata.status_to = 'draft'`, `metadata.error_message`.

### No partial content

Report generation is all-or-nothing. The `content` field is either fully populated or not set. There is no partial-content state.

---

## 6. Export Rendering Lifecycle

### Trigger

An export rendering job is enqueued when:
- A user requests an export via `POST .../reports/:rid/exports`. The API creates the `report_exports` row (without `storage_path`) and enqueues the job.

### State machine

Export rendering does not have an explicit status column on the `report_exports` table. The presence or absence of `storage_path` indicates completion:

- `storage_path IS NULL` → rendering in progress or failed.
- `storage_path IS NOT NULL` → rendering complete, file available.

### Worker steps

1. **Claim the job.** Load the `report_exports` row. If `storage_path` is already set (idempotency — the job was already processed), discard the job.
2. **Load the report.** Read `reports.content` for the parent report. If the report's status has changed to `draft` or `generating` since the export was requested, discard the job (the content is no longer valid).
3. **Render the file.** Call the rendering function in `/execution/logic/` for the requested `format`:
   - `pdf` → PDF renderer
   - `csv` → CSV renderer
   - `xlsx` → XLSX renderer
4. **Upload to object storage.** Write the rendered file to S3/GCS. The storage path follows the pattern: `exports/<tenant_id>/<report_id>/<export_id>.<format>`.
5. **On success:**
   - Set `report_exports.storage_path = <path>`, `file_size_bytes = <size>`.
   - Audit: `report_export.created` with `metadata.format`, `metadata.file_size_bytes`.
6. **On failure:**
   - Do not update the row (leave `storage_path` as null).
   - Audit: `report_export.created` with `metadata.error_message`, `metadata.status = 'failed'`.
   - The user can check export status via the API. A null `storage_path` with no pending job indicates failure. The user may request a new export.

### Storage path security

The storage path includes `tenant_id` as the first path segment. This prevents path traversal between tenants even if a bug constructs an incorrect path. Object storage bucket policies should additionally enforce that the application role can only write to paths matching the authenticated tenant.

---

## 7. Status Transitions Summary

### ingestion_runs

```
pending ──→ running ──→ success
                    └──→ failed
```

Allowed transitions only:
| From | To | Actor |
|---|---|---|
| `pending` | `running` | Worker only |
| `running` | `success` | Worker only |
| `running` | `failed` | Worker only |

No backward transitions. No transition from `success` or `failed` to any other state. A retry creates a new row, not a state change on the existing row.

### compliance_runs

```
pending ──→ running ──→ success
                    ├──→ partial_failure
                    └──→ failed
```

Allowed transitions only:
| From | To | Actor |
|---|---|---|
| `pending` | `running` | Worker only |
| `running` | `success` | Worker only |
| `running` | `partial_failure` | Worker only |
| `running` | `failed` | Worker only |

Same rules as ingestion: no backward transitions, retries create new rows.

### reports (worker-managed transitions only)

```
generating ──→ review
           └──→ draft (on failure)
```

| From | To | Actor |
|---|---|---|
| `generating` | `review` | Worker only |
| `generating` | `draft` | Worker only (failure revert) |

All other report transitions (`draft → generating`, `review → approved`, `review → draft`, `approved → published`) are API-driven and documented in `directives/api-contract.md`.

### Enforcement

Status transitions are enforced at the database level via a check in the update query:

```
UPDATE ingestion_runs
SET status = 'running', started_at = now()
WHERE id = <run_id>
  AND status = 'pending'
RETURNING id
```

If the `WHERE` clause matches zero rows, the transition is invalid (the row is not in the expected state). The worker must handle this as a conflict — another process has already claimed the job.

---

## 8. Retry Rules

### Queue-level retries

The job queue (configured in `/services/worker/`) handles automatic retries for jobs that fail. Retry behavior is configured per job type.

| Job Type | Max Attempts | Backoff | Delay |
|---|---|---|---|
| `ingestion` | 3 | Exponential | 30s, 2m, 8m |
| `compliance_evaluation` | 3 | Exponential | 30s, 2m, 8m |
| `report_generation` | 2 | Fixed | 1m, 1m |
| `export_rendering` | 2 | Fixed | 1m, 1m |

### What is retried vs. what is not

**Retryable failures (queue retries automatically):**
- Network timeouts connecting to external data sources.
- Database connection pool exhaustion.
- Transient object storage errors (503, timeout).
- Out-of-memory kills (the process restarts, the queue re-delivers).

**Non-retryable failures (job is marked failed, no automatic retry):**
- Authentication failure against an external data source (credentials are wrong, not temporarily unavailable).
- Validation errors in compliance rule evaluation (the rule definition is malformed).
- The referenced resource no longer exists (ingestion run deleted, report deleted).
- Tenant is suspended or offboarded.
- Data source status is `disabled`.

### How to distinguish retryable from non-retryable

Worker code must catch errors and classify them:
- Errors from external I/O (network, storage) → throw to the queue for retry.
- Errors from internal logic (validation, state conflict, missing resource) → mark the run as `failed` with `error_message`, do not throw to the queue.

### User-initiated retries

Users can retry failed runs via API endpoints (`POST .../retry`). These always create a new row (new `id`, `status = 'pending'`) and enqueue a fresh job. The original failed row is never modified.

### Retry and audit logging

Each retry attempt that reaches the worker produces its own audit entries. If a job is retried 3 times, there will be 3 `started` audit entries and up to 3 `failed` entries, each with `metadata.attempt` indicating which attempt it was.

---

## 9. Idempotency Rules

Workers must be idempotent. The same job delivered twice must not produce duplicate side effects.

### Why idempotency is required

Job queues guarantee at-least-once delivery, not exactly-once. A job may be delivered multiple times due to:
- Worker crash after processing but before acknowledging the job.
- Network partition between the worker and the queue.
- Queue infrastructure restart.

### Idempotency strategy: status-guarded transitions

The primary idempotency mechanism is the status-guarded update described in section 7. Each state transition uses a conditional update that only succeeds if the row is in the expected current state:

```
UPDATE <table>
SET status = '<next_status>'
WHERE id = <resource_id>
  AND status = '<expected_current_status>'
RETURNING id
```

If this returns zero rows, the transition already happened. The worker must:
1. Log the duplicate delivery (application log, not audit log).
2. Discard the job without error.
3. Not re-enqueue.

### Idempotency by worker type

**ingestion-runner:**
- Guarded by `status = 'pending'` on the `pending → running` transition.
- If the job is delivered twice and the first delivery already moved the run to `running`, the second delivery sees zero rows and exits.
- Risk: if the first delivery crashes after `running` but before completion, the run is stuck in `running`. See section 10 (stale run recovery).

**compliance-evaluator:**
- Guarded by `status = 'pending'` on the `pending → running` transition.
- Additionally, `compliance_results` writes are idempotent by uniqueness: the combination `(compliance_run_id, compliance_rule_id)` should produce at most one result. If a duplicate write is attempted, the worker checks for existing results before inserting.

**report-generator:**
- Guarded by `status = 'generating'` on the row. If the report has already moved to `review` or `draft`, the worker discards the job.

**export-renderer:**
- Guarded by `storage_path IS NULL`. If `storage_path` is already set, the export was already rendered and the worker discards the job.
- Object storage writes are inherently idempotent (writing the same file to the same path replaces it with identical content).

### What idempotency does NOT cover

Idempotency prevents duplicate database writes and duplicate file uploads. It does not prevent duplicate calls to external systems. If the ingestion runner fetches data from an external API and then crashes before updating the database, the retry will fetch the data again. This is acceptable — ingestion is a read operation against the external source, and re-fetching produces the same data (or fresher data, which is also acceptable).

---

## 10. Failure Handling and Audit Logging

### Failure categories

| Category | Example | Worker Response | Audit Action |
|---|---|---|---|
| **Transient external** | Network timeout to SFTP server | Throw to queue for retry | No audit entry (the attempt didn't start) |
| **Transient internal** | DB connection pool exhaustion | Throw to queue for retry | No audit entry |
| **Permanent external** | Invalid credentials for data source | Mark `failed`, set `error_message` | `*.failed` with `metadata.error_message` |
| **Permanent internal** | Malformed rule definition | Mark `failed`, set `error_message` | `*.failed` with `metadata.error_message` |
| **Per-rule error** | One rule throws during compliance eval | Mark result as `error`, continue others | Captured in `compliance_results.status = 'error'` |
| **Resource gone** | Report deleted while generating | Discard job | No audit entry (nothing to update) |
| **Tenant gone** | Tenant suspended or offboarded | Discard job | No audit entry (tenant context invalid) |

### When audit entries are written

Audit entries are written only when a database state change occurs. If the worker discards a job without touching the database (duplicate delivery, resource gone, tenant gone), no audit entry is written — there is nothing to audit.

If the worker transitions a row to `running` and then encounters a failure, it writes both:
1. The `*.started` audit entry (when transitioning to `running`).
2. The `*.failed` audit entry (when transitioning to `failed`).

Both entries share the same `job_id` in metadata for correlation.

### Transaction boundaries for failure

**Successful completion:** One transaction covers the final status update, all result inserts (for compliance), and audit entries. All committed atomically.

**Failure after starting:** The failure transaction covers only the status update to `failed` and the `*.failed` audit entry. Any partial work (e.g., some compliance results already inserted) remains in the database — these are valid results from rules that succeeded before the batch-level failure.

**Failure before starting:** If the worker fails before transitioning to `running` (e.g., tenant validation fails, resource not found), no database changes are made and no audit entries are written. The job is either retried (transient) or discarded (permanent).

### Error message sanitization

The `error_message` stored on the run row and in audit metadata must not contain:
- Stack traces (internal implementation detail, potential security leak).
- Connection strings or hostnames of external systems.
- Credentials or tokens of any kind.
- Raw SQL query text (may reveal schema details).

Error messages must be human-readable summaries: "Connection to SFTP server timed out after 30 seconds", "Compliance rule 'Budget threshold check' failed with division by zero", "Report content assembly failed: no compliance results found for the specified date range."

### Stale run recovery

A run can become stuck in `running` if the worker process crashes after claiming the job but before completing or failing it. The queue's visibility timeout handles most of these cases (the job becomes available for redelivery after the timeout).

However, if the queue itself loses track of the job, the run remains in `running` indefinitely. A periodic sweep job (configured in `/services/worker/schedules.js`) must:

1. Query for runs where `status = 'running'` and `started_at < now() - interval '<timeout>'`.
2. Transition them to `failed` with `error_message = 'Stale run detected: worker did not complete within timeout'`.
3. Audit: `*.failed` with `metadata.recovery = 'stale_run_sweep'`.

Timeout thresholds per job type:

| Job Type | Stale Threshold |
|---|---|
| `ingestion` | 30 minutes |
| `compliance_evaluation` | 15 minutes |
| `report_generation` | 10 minutes |
| `export_rendering` | 10 minutes |

These are intentionally generous. A run that exceeds these thresholds is almost certainly abandoned, not slow.

### Dead letter queue

Jobs that exhaust all retry attempts are moved to a dead letter queue (DLQ). The DLQ is a separate queue that is monitored but not automatically processed. Ops team reviews DLQ entries to:
- Identify systemic failures (e.g., all ingestion jobs for a specific source type failing).
- Decide whether to fix the root cause and re-enqueue, or discard.
- The run row in the database is already marked `failed` by this point — the DLQ entry is for operational visibility, not data integrity.
