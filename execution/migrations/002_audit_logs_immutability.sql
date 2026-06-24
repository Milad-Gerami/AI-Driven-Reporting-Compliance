-- Immutability trigger for audit_logs.
-- Prevents UPDATE and DELETE at the database level; INSERT and SELECT remain allowed.

CREATE OR REPLACE FUNCTION fn_audit_logs_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'audit_logs rows are immutable — % is not allowed', TG_OP;
END;
$$;

CREATE TRIGGER trg_audit_logs_immutable
    BEFORE UPDATE OR DELETE ON audit_logs
    FOR EACH ROW
    EXECUTE FUNCTION fn_audit_logs_immutable();
