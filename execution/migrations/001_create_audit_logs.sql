CREATE TABLE audit_logs (
    id              uuid            PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid            NOT NULL
                                    REFERENCES tenants(id) ON DELETE RESTRICT,
    actor_id        uuid
                                    REFERENCES users(id) ON DELETE RESTRICT,
    actor_type      text            NOT NULL,
    action          text            NOT NULL,
    resource_type   text            NOT NULL,
    resource_id     uuid            NOT NULL,
    metadata        jsonb           NOT NULL DEFAULT '{}'::jsonb,
    occurred_at     timestamptz     NOT NULL DEFAULT now(),

    CONSTRAINT actor_id_matches_actor_type
        CHECK ((actor_type = 'user') = (actor_id IS NOT NULL))
);

CREATE INDEX idx_audit_logs_tenant_occurred
    ON audit_logs (tenant_id, occurred_at DESC);

CREATE INDEX idx_audit_logs_tenant_resource
    ON audit_logs (tenant_id, resource_type, resource_id);
