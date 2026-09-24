CREATE TABLE calendar_events (
 id uuid PRIMARY KEY, org_id uuid NOT NULL, creator_id uuid NOT NULL,
 series_id uuid NOT NULL, unit_id uuid, audience text NOT NULL CHECK(audience IN ('personal','unit','organization')),
 title text NOT NULL, description text NOT NULL DEFAULT '', location text NOT NULL DEFAULT '',
 starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL, timezone text NOT NULL,
 version integer NOT NULL DEFAULT 1, cancelled_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(org_id,id), CHECK(ends_at>starts_at), CHECK((audience='unit')=(unit_id IS NOT NULL)),
 FOREIGN KEY(org_id,creator_id) REFERENCES users(org_id,id), FOREIGN KEY(org_id,unit_id) REFERENCES units(org_id,id)
);
CREATE INDEX calendar_window ON calendar_events(org_id,starts_at,ends_at);
CREATE INDEX calendar_series ON calendar_events(org_id,series_id);
CREATE TABLE calendar_revisions (
 org_id uuid NOT NULL, event_id uuid NOT NULL, version integer NOT NULL, actor_id uuid NOT NULL,
 snapshot jsonb NOT NULL, changed_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(event_id,version),
 FOREIGN KEY(org_id,event_id) REFERENCES calendar_events(org_id,id), FOREIGN KEY(org_id,actor_id) REFERENCES users(org_id,id)
);
CREATE TABLE messages (
 id uuid PRIMARY KEY, org_id uuid NOT NULL, sender_id uuid NOT NULL, reply_to uuid,
 subject text NOT NULL, body text NOT NULL, version integer NOT NULL DEFAULT 1,
 sent_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(org_id,id), FOREIGN KEY(org_id,sender_id) REFERENCES users(org_id,id), FOREIGN KEY(org_id,reply_to) REFERENCES messages(org_id,id)
);
CREATE TABLE message_recipients (
 org_id uuid NOT NULL, message_id uuid NOT NULL, user_id uuid NOT NULL, read_at timestamptz, archived_at timestamptz,
 PRIMARY KEY(message_id,user_id), FOREIGN KEY(org_id,message_id) REFERENCES messages(org_id,id), FOREIGN KEY(org_id,user_id) REFERENCES users(org_id,id)
);
CREATE INDEX message_inbox ON message_recipients(org_id,user_id,archived_at);
CREATE INDEX message_sent ON messages(org_id,sender_id,sent_at);
