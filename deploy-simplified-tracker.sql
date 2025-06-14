-- Deploy Simplified Payment Tracker
-- This migration:
-- 1. Creates simplified schema with global state tracking
-- 2. Removes complex per-provider tracking
-- 3. Clears all transaction data for fresh start

BEGIN;

-- Step 1: Create global state table (single source of truth)
CREATE TABLE IF NOT EXISTS global_state (
    id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    last_processed_block BIGINT NOT NULL DEFAULT 0,
    updated_at TIMESTAMP DEFAULT NOW()
);

INSERT INTO global_state (id, last_processed_block) 
VALUES (1, 0) 
ON CONFLICT (id) DO NOTHING;

-- Step 2: Remove complex columns from provider_leaderboard
ALTER TABLE provider_leaderboard 
    DROP COLUMN IF EXISTS last_processed_block,
    DROP COLUMN IF EXISTS last_transaction_block,
    DROP COLUMN IF EXISTS processing_checkpoint,
    DROP COLUMN IF EXISTS state_validation_hash;

-- Step 3: Drop complex tables we don't need
DROP TABLE IF EXISTS block_processing_log;
DROP TABLE IF EXISTS tracker_state;

-- Step 4: Clear all transaction data for fresh start
TRUNCATE TABLE hypermap_transactions CASCADE;

-- Step 5: Reset provider stats
UPDATE provider_leaderboard
SET 
    total_usdc_received = 0,
    transaction_count = 0,
    unique_sender_count = 0,
    first_transaction_at = NULL,
    last_transaction_at = NULL,
    updated_at = NOW();

-- Step 6: Ensure proper indexes exist
CREATE INDEX IF NOT EXISTS idx_transactions_block_number 
    ON hypermap_transactions(block_number);
CREATE INDEX IF NOT EXISTS idx_transactions_to_address 
    ON hypermap_transactions(to_address);

-- Step 7: Show final state
SELECT 
    'DEPLOYMENT COMPLETE' as status,
    COUNT(*) as provider_count
FROM provider_leaderboard;

SELECT 
    'Global state initialized' as status,
    last_processed_block,
    updated_at
FROM global_state;

SELECT 
    'Ready to start indexing from block 0' as message;

COMMIT;