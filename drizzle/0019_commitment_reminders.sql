CREATE TABLE commitment_reminder_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  obligation_id TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  deadline_key TEXT NOT NULL,
  scheduled_at TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','attempted','submitted','failed','cancelled')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  attempted_at TEXT,
  submitted_at TEXT,
  retry_at TEXT,
  failure_code TEXT,
  UNIQUE(obligation_id, deadline_key)
);
--> statement-breakpoint
CREATE INDEX idx_commitment_reminder_due ON commitment_reminder_ledger(state, scheduled_at);
--> statement-breakpoint
CREATE INDEX idx_commitment_reminder_retry ON commitment_reminder_ledger(state, retry_at);
--> statement-breakpoint
CREATE INDEX idx_entities_reminder_due ON entities(type, due_date, id);
--> statement-breakpoint
CREATE INDEX idx_entities_reminder_source ON entities(type, json_extract(CASE WHEN json_valid(metadata) THEN metadata ELSE '{}' END, '$.source_meeting_id'), json_type(CASE WHEN json_valid(metadata) THEN metadata ELSE '{}' END, '$.meeting_regeneration_retired_at'));
--> statement-breakpoint
CREATE INDEX idx_commitment_reminder_alias_target ON commitment_aliases(canonical_id, meeting_id, active);
--> statement-breakpoint
CREATE TABLE commitment_reminder_revision (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), revision INTEGER NOT NULL);
--> statement-breakpoint
INSERT INTO commitment_reminder_revision VALUES (1, 0);
--> statement-breakpoint
CREATE TABLE commitment_reminder_changes (entity_id TEXT PRIMARY KEY, revision INTEGER NOT NULL);
--> statement-breakpoint
CREATE INDEX idx_commitment_reminder_changes_revision ON commitment_reminder_changes(revision, entity_id);
--> statement-breakpoint
CREATE TRIGGER commitment_reminder_entity_insert AFTER INSERT ON entities WHEN NEW.type = 'action_item' BEGIN
  UPDATE commitment_reminder_revision SET revision = revision + 1;
  INSERT OR REPLACE INTO commitment_reminder_changes VALUES (NEW.id, (SELECT revision FROM commitment_reminder_revision));
END;
--> statement-breakpoint
CREATE TRIGGER commitment_reminder_attention_insert AFTER INSERT ON attention_items BEGIN
  UPDATE commitment_reminder_revision SET revision = revision + 1;
  INSERT OR REPLACE INTO commitment_reminder_changes SELECT value, (SELECT revision FROM commitment_reminder_revision)
    FROM json_each(CASE WHEN json_valid(NEW.related_entity_ids_json) THEN NEW.related_entity_ids_json ELSE '[]' END) WHERE type = 'text';
END;
--> statement-breakpoint
CREATE TRIGGER commitment_reminder_attention_update AFTER UPDATE ON attention_items BEGIN
  UPDATE commitment_reminder_revision SET revision = revision + 1;
  INSERT OR REPLACE INTO commitment_reminder_changes SELECT value, (SELECT revision FROM commitment_reminder_revision)
    FROM json_each(CASE WHEN json_valid(NEW.related_entity_ids_json) THEN NEW.related_entity_ids_json ELSE '[]' END) WHERE type = 'text';
  INSERT OR REPLACE INTO commitment_reminder_changes SELECT value, (SELECT revision FROM commitment_reminder_revision)
    FROM json_each(CASE WHEN json_valid(OLD.related_entity_ids_json) THEN OLD.related_entity_ids_json ELSE '[]' END) WHERE type = 'text';
END;
--> statement-breakpoint
CREATE TRIGGER commitment_reminder_attention_delete AFTER DELETE ON attention_items BEGIN
  UPDATE commitment_reminder_revision SET revision = revision + 1;
  INSERT OR REPLACE INTO commitment_reminder_changes SELECT value, (SELECT revision FROM commitment_reminder_revision)
    FROM json_each(CASE WHEN json_valid(OLD.related_entity_ids_json) THEN OLD.related_entity_ids_json ELSE '[]' END) WHERE type = 'text';
END;
--> statement-breakpoint
CREATE TRIGGER commitment_reminder_entity_update AFTER UPDATE ON entities WHEN NEW.type = 'action_item' OR OLD.type = 'action_item' BEGIN
  UPDATE commitment_reminder_revision SET revision = revision + 1;
  INSERT OR REPLACE INTO commitment_reminder_changes VALUES (NEW.id, (SELECT revision FROM commitment_reminder_revision));
END;
--> statement-breakpoint
CREATE TRIGGER commitment_reminder_entity_delete AFTER DELETE ON entities WHEN OLD.type = 'action_item' BEGIN
  UPDATE commitment_reminder_revision SET revision = revision + 1;
  INSERT OR REPLACE INTO commitment_reminder_changes VALUES (OLD.id, (SELECT revision FROM commitment_reminder_revision));
END;
--> statement-breakpoint
CREATE TRIGGER commitment_reminder_alias_insert AFTER INSERT ON commitment_aliases BEGIN
  UPDATE commitment_reminder_revision SET revision = revision + 1;
  INSERT OR REPLACE INTO commitment_reminder_changes VALUES (NEW.extraction_id, (SELECT revision FROM commitment_reminder_revision));
  INSERT OR REPLACE INTO commitment_reminder_changes VALUES (NEW.canonical_id, (SELECT revision FROM commitment_reminder_revision));
END;
--> statement-breakpoint
CREATE TRIGGER commitment_reminder_alias_update AFTER UPDATE ON commitment_aliases BEGIN
  UPDATE commitment_reminder_revision SET revision = revision + 1;
  INSERT OR REPLACE INTO commitment_reminder_changes VALUES (NEW.extraction_id, (SELECT revision FROM commitment_reminder_revision));
  INSERT OR REPLACE INTO commitment_reminder_changes VALUES (NEW.canonical_id, (SELECT revision FROM commitment_reminder_revision));
  INSERT OR REPLACE INTO commitment_reminder_changes VALUES (OLD.canonical_id, (SELECT revision FROM commitment_reminder_revision));
END;
--> statement-breakpoint
CREATE TRIGGER commitment_reminder_alias_delete AFTER DELETE ON commitment_aliases BEGIN
  UPDATE commitment_reminder_revision SET revision = revision + 1;
  INSERT OR REPLACE INTO commitment_reminder_changes VALUES (OLD.extraction_id, (SELECT revision FROM commitment_reminder_revision));
  INSERT OR REPLACE INTO commitment_reminder_changes VALUES (OLD.canonical_id, (SELECT revision FROM commitment_reminder_revision));
END;
--> statement-breakpoint
CREATE TRIGGER commitment_reminder_meeting_delete BEFORE DELETE ON meetings BEGIN
  UPDATE commitment_reminder_revision SET revision = revision + 1;
  INSERT OR REPLACE INTO commitment_reminder_changes SELECT entity_id, (SELECT revision FROM commitment_reminder_revision) FROM meeting_entities WHERE meeting_id = OLD.id;
  INSERT OR REPLACE INTO commitment_reminder_changes SELECT id, (SELECT revision FROM commitment_reminder_revision)
    FROM entities WHERE type = 'action_item' AND json_extract(CASE WHEN json_valid(metadata) THEN metadata ELSE '{}' END, '$.source_meeting_id') = OLD.id;
END;
