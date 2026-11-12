-- Where the sweep of expired downloads (`artifacts/` in the runners'
-- bucket) has got to: the listing cursor it goes on from next tick, and
-- when its last pass reached the end. One row.
CREATE TABLE download_sweep (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  cursor TEXT,
  finished_at INTEGER
);
