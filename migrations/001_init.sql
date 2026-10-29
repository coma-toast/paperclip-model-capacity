-- The database declaration exists only so the plugin can read core heartbeat_runs (counting runs, B2 and restart recovery).
-- The host requires a migration in the plugin's own schema: plugin_<slug>_<first 10 hex of sha256(plugin key)>.
CREATE TABLE IF NOT EXISTS plugin_coma_toast_paperclip_model_capacity_b1f617430a.schema_marker (id integer PRIMARY KEY);
