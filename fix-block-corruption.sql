-- Fix Block Number Corruption and Add Safeguards
-- This script:
-- 1. Fixes corrupted block numbers
-- 2. Adds constraints to prevent future issues
-- 3. Creates new tracking columns and tables
-- 4. CLEARS ALL TRANSACTION DATA for a fresh start
--
-- WARNING: This will reset all payment tracking data!
-- Make sure to backup your database before running this migration.

BEGIN;

-- Step 1: Show current corrupted state
SELECT 
    'BEFORE FIX' as status,
    provider_entry_name,
    wallet_address,
    last_processed_block,
    CASE 
        WHEN last_processed_block > 100000000 THEN 'CORRUPTED'
        ELSE 'OK'
    END as block_status
FROM provider_leaderboard
WHERE last_processed_block IS NOT NULL
ORDER BY last_processed_block DESC;

-- Step 2: Fix corrupted block numbers
-- The pattern shows 31522855 became 315228551 (extra "1" appended)
-- We'll detect and fix these by removing trailing digits that make the number unreasonably large
UPDATE provider_leaderboard
SET 
    last_processed_block = CASE
        -- If the block number is unreasonably high (> 100 million), try to fix it
        WHEN last_processed_block > 100000000 THEN
            -- Try to extract the original number by removing the last digit
            FLOOR(last_processed_block / 10)::BIGINT
        ELSE 
            last_processed_block
    END,
    updated_at = NOW()
WHERE last_processed_block > 100000000;

-- Step 3: If the above fix still results in unreasonable numbers, reset to last known good transaction
UPDATE provider_leaderboard pl
SET 
    last_processed_block = COALESCE(
        (SELECT MAX(block_number) 
         FROM hypermap_transactions ht 
         WHERE ht.to_address = pl.wallet_address),
        0
    ),
    updated_at = NOW()
WHERE last_processed_block > 50000000; -- Base blockchain won't reach this for years

-- Step 4: Add a CHECK constraint to prevent future corruption
-- First, we need to drop and recreate the column with proper constraints
-- Note: This preserves the data
ALTER TABLE provider_leaderboard 
    ALTER COLUMN last_processed_block TYPE BIGINT USING last_processed_block::BIGINT;

-- Add a reasonable upper bound check (Base chain started at 0, currently ~31M blocks)
ALTER TABLE provider_leaderboard 
    ADD CONSTRAINT reasonable_block_number 
    CHECK (last_processed_block >= 0 AND last_processed_block < 100000000);

-- Step 5: Add tracking columns for better state management
ALTER TABLE provider_leaderboard
    ADD COLUMN IF NOT EXISTS last_transaction_block BIGINT DEFAULT 0,
    ADD COLUMN IF NOT EXISTS processing_checkpoint BIGINT DEFAULT 0,
    ADD COLUMN IF NOT EXISTS state_validation_hash VARCHAR(64);

-- Step 6: Create indexes for new columns
CREATE INDEX IF NOT EXISTS idx_provider_last_transaction_block 
    ON provider_leaderboard(last_transaction_block);
CREATE INDEX IF NOT EXISTS idx_provider_processing_checkpoint 
    ON provider_leaderboard(processing_checkpoint);

-- Step 7: Update the new columns with current data
UPDATE provider_leaderboard pl
SET 
    last_transaction_block = COALESCE(
        (SELECT MAX(block_number) 
         FROM hypermap_transactions ht 
         WHERE ht.to_address = pl.wallet_address),
        0
    ),
    processing_checkpoint = LEAST(last_processed_block, 50000000), -- Cap at reasonable value
    state_validation_hash = MD5(
        COALESCE(last_processed_block::TEXT, '0') || '|' || 
        COALESCE(total_usdc_received::TEXT, '0') || '|' || 
        COALESCE(transaction_count::TEXT, '0')
    )
WHERE last_processed_block IS NOT NULL;

-- Step 8: Add a tracking table for block processing history
CREATE TABLE IF NOT EXISTS block_processing_log (
    id SERIAL PRIMARY KEY,
    provider_entry_namehash VARCHAR(66) NOT NULL,
    provider_entry_name VARCHAR(255) NOT NULL,
    old_block_number BIGINT,
    new_block_number BIGINT,
    block_difference BIGINT GENERATED ALWAYS AS (new_block_number - COALESCE(old_block_number, 0)) STORED,
    change_type VARCHAR(50) NOT NULL, -- 'normal_advance', 'corruption_fix', 'reset', 'conservative_advance'
    created_at TIMESTAMP DEFAULT NOW(),
    CONSTRAINT reasonable_block_change CHECK (
        -- Normal advancement should never be more than 10000 blocks at once
        (change_type = 'normal_advance' AND block_difference BETWEEN 0 AND 10000) OR
        -- Other change types can have larger differences
        change_type IN ('corruption_fix', 'reset', 'conservative_advance')
    )
);

-- Create index for efficient queries
CREATE INDEX IF NOT EXISTS idx_block_log_provider_time 
    ON block_processing_log(provider_entry_namehash, created_at DESC);

-- Step 9: Show the fixed state
SELECT 
    'AFTER FIX' as status,
    provider_entry_name,
    wallet_address,
    last_processed_block,
    last_transaction_block,
    processing_checkpoint,
    CASE 
        WHEN last_processed_block > 100000000 THEN 'STILL CORRUPTED - NEEDS MANUAL FIX'
        ELSE 'OK'
    END as block_status
FROM provider_leaderboard
WHERE last_processed_block IS NOT NULL
ORDER BY last_processed_block DESC;

-- Step 10: Clear all data to force re-indexing from the beginning
SELECT 
    'CLEARING ALL TRANSACTION DATA FOR FRESH START' as status;

-- Clear all transaction data
TRUNCATE TABLE hypermap_transactions CASCADE;

-- Reset provider leaderboard while keeping the structure
UPDATE provider_leaderboard
SET 
    total_usdc_received = 0,
    transaction_count = 0,
    unique_sender_count = 0,
    first_transaction_at = NULL,
    last_transaction_at = NULL,
    last_processed_block = 0,
    last_transaction_block = 0,
    processing_checkpoint = 0,
    state_validation_hash = MD5('0|' || provider_entry_namehash),
    updated_at = NOW();

-- Clear the new block processing log
TRUNCATE TABLE block_processing_log CASCADE;

-- Reset tracker state
UPDATE tracker_state 
SET 
    last_run_at = NULL,
    last_successful_run_at = NULL,
    last_error = NULL,
    total_runs = 0,
    successful_runs = 0,
    failed_runs = 0
WHERE id = 1;

-- Log the reset in block processing log
INSERT INTO block_processing_log 
(provider_entry_namehash, provider_entry_name, old_block_number, new_block_number, change_type)
SELECT 
    provider_entry_namehash,
    provider_entry_name,
    NULL,
    0,
    'reset'
FROM provider_leaderboard;

-- Show final state after reset
SELECT 
    'FINAL STATE AFTER RESET' as status,
    provider_entry_name,
    wallet_address,
    last_processed_block,
    last_transaction_block,
    transaction_count,
    total_usdc_received
FROM provider_leaderboard
ORDER BY provider_entry_name;

SELECT 
    'All data cleared. Indexer will start from the beginning on next run.' as message;

COMMIT;

-- Additional diagnostic query (run separately if needed)
/*
SELECT 
    pl.provider_entry_name,
    pl.last_processed_block,
    COUNT(ht.tx_hash) as tx_count,
    MAX(ht.block_number) as max_tx_block,
    MIN(ht.block_number) as min_tx_block,
    pl.last_processed_block - COALESCE(MAX(ht.block_number), 0) as blocks_ahead
FROM provider_leaderboard pl
LEFT JOIN hypermap_transactions ht ON ht.to_address = pl.wallet_address
GROUP BY pl.provider_entry_name, pl.last_processed_block
ORDER BY blocks_ahead DESC;
*/