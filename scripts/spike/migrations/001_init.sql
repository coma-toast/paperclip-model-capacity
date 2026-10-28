-- The spike needs a database declaration to read core tables; it stores nothing.
CREATE TABLE IF NOT EXISTS spike_marker (id integer PRIMARY KEY);
