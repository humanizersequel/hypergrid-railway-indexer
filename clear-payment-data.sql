-- Clear payment tracking data without dropping tables or indices
-- This script will remove all data but preserve the table structure

-- Start transaction
BEGIN;

-- Clear transaction records
TRUNCATE TABLE hypermap_transactions CASCADE;

-- Clear leaderboard data
TRUNCATE TABLE provider_leaderboard CASCADE;

-- Reset tracker state but keep the single row
UPDATE tracker_state SET
    last_run_at = NULL,
    last_successful_run_at = NULL,
    last_error = NULL,
    total_runs = 0,
    successful_runs = 0,
    failed_runs = 0
WHERE id = 1;

-- Commit changes
COMMIT;

-- Verify the cleanup
SELECT 'hypermap_transactions' as table_name, COUNT(*) as row_count FROM hypermap_transactions
UNION ALL
SELECT 'provider_leaderboard', COUNT(*) FROM provider_leaderboard
UNION ALL
SELECT 'tracker_state', COUNT(*) FROM tracker_state;