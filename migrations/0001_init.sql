-- CampusPulse learning prototype schema

CREATE TABLE events (
  id TEXT PRIMARY KEY,            -- engage:<id> or post:<uuid>
  source TEXT NOT NULL,           -- engage | post
  name TEXT NOT NULL,
  org TEXT,
  location TEXT,
  lat REAL,
  lng REAL,
  geo_source TEXT,                -- engage | building | user | none
  starts INTEGER NOT NULL,        -- epoch ms
  ends INTEGER NOT NULL,
  free_food INTEGER DEFAULT 0,
  category TEXT,
  rsvp INTEGER,
  url TEXT,
  poster_device TEXT,
  poster_role TEXT,               -- student | staff | officer (informal posts only)
  confirms INTEGER DEFAULT 0,
  gone INTEGER DEFAULT 0,
  status TEXT DEFAULT 'live',     -- live | gone | expired
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL
);
CREATE INDEX idx_events_time ON events(starts, ends);

CREATE TABLE checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  device TEXT NOT NULL,
  event_id TEXT NOT NULL,
  answer TEXT NOT NULL,           -- here | gone | skipped
  via TEXT                        -- sheet | prompt
);

CREATE TABLE logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  device TEXT NOT NULL,
  tester TEXT,                    -- participant code from a test session, if any
  session TEXT,
  type TEXT NOT NULL,             -- open | view | directions | save | filter | post | check | prompt
  event_id TEXT,
  meta TEXT
);
CREATE INDEX idx_logs_device ON logs(device, ts);

CREATE TABLE ingest_runs (
  ts INTEGER PRIMARY KEY,
  fetched INTEGER,
  kept INTEGER,
  engage_coords INTEGER,
  building_coords INTEGER,
  no_coords INTEGER,
  dropped_online INTEGER,
  ms INTEGER
);
