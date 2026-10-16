-- Data migration (no schema change): dashboard widgets become resizable.
--
-- `grid_w` / `grid_h` have always been stored (default 2 x 1) but never drawn:
-- the grid hard-coded a double-width span for chart cards and a single column
-- for everything else. From this release the stored span is what the grid
-- draws, so the one kind whose drawn width disagreed with its stored width,
-- the budget card (stored 2, drawn 1), is brought in line. Only rows still at
-- the untouched default are rewritten; nothing could resize a widget before
-- this release, so that is every budget card.
UPDATE "dashboard_widgets" SET "grid_w" = 1 WHERE "kind" = 'budget' AND "grid_w" = 2 AND "grid_h" = 1;
