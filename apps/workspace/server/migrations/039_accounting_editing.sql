-- Catalogs and unissued drafts are editable. Financial evidence remains fixed.
ALTER TABLE accounting_contacts ADD COLUMN revision integer NOT NULL DEFAULT 1 CHECK(revision>0);
ALTER TABLE accounting_contacts ADD COLUMN active boolean NOT NULL DEFAULT true;
ALTER TABLE accounting_contacts ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE accounting_documents ADD COLUMN revision integer NOT NULL DEFAULT 1 CHECK(revision>0);
ALTER TABLE accounting_documents ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

CREATE FUNCTION protect_accounting_editable_record() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Accounting records retain their history; archive or discard instead'; END IF;
 IF NEW.id IS DISTINCT FROM OLD.id OR NEW.org_id IS DISTINCT FROM OLD.org_id
  OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
  RAISE EXCEPTION 'Accounting record identity is immutable';
 END IF;
 IF TG_TABLE_NAME='accounting_documents' THEN
  IF EXISTS(SELECT 1 FROM accounting_document_events WHERE org_id=OLD.org_id AND document_id=OLD.id) THEN
   RAISE EXCEPTION 'Issued or discarded accounting documents are append-only';
  END IF;
  IF NEW.kind IS DISTINCT FROM OLD.kind OR NEW.currency IS DISTINCT FROM OLD.currency
   OR NEW.precision IS DISTINCT FROM OLD.precision OR NEW.basis IS DISTINCT FROM OLD.basis THEN
   RAISE EXCEPTION 'Document kind and accounting basis are immutable';
  END IF;
 ELSIF NEW.kind IS DISTINCT FROM OLD.kind AND EXISTS(SELECT 1 FROM accounting_documents WHERE org_id=OLD.org_id AND contact_id=OLD.id) THEN
  RAISE EXCEPTION 'A contact used by accounting documents keeps its type';
 END IF;
 IF NEW.revision<>OLD.revision+1 THEN RAISE EXCEPTION 'Accounting edits require the next revision'; END IF;
 NEW.updated_at=clock_timestamp();
 RETURN NEW;
END;
$$;
DROP TRIGGER immutable_accounting_contacts ON accounting_contacts;
DROP TRIGGER immutable_accounting_documents ON accounting_documents;
CREATE TRIGGER protected_accounting_contacts BEFORE UPDATE OR DELETE ON accounting_contacts FOR EACH ROW EXECUTE FUNCTION protect_accounting_editable_record();
CREATE TRIGGER protected_accounting_document_drafts BEFORE UPDATE OR DELETE ON accounting_documents FOR EACH ROW EXECUTE FUNCTION protect_accounting_editable_record();
