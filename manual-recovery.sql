-- Manual Recovery Script for Payment Tracker
-- Use this if automatic fixes don't resolve the issues

-- IMPORTANT: Review each section before running!

-- 1. Show current problematic state
SELECT 
    'Current Problematic Providers:' as info,
    provider_entry_name,
    last_processed_block,
    CASE 
        WHEN last_processed_block > 100000000 THEN 'Block number corrupted'
        WHEN last_processed_block > 50000000 THEN 'Block number suspiciously high'
        ELSE 'Check manually'
    END as issue
FROM provider_leaderboard
WHERE last_processed_block > 50000000
ORDER BY last_processed_block DESC;

-- 2. Manual fix for specific provider (CUSTOMIZE THIS)
-- Uncomment and modify the provider name and block number as needed
/*
UPDATE provider_leaderboard
SET 
    last_processed_block = 31522855,  -- Set to correct block number
    processing_checkpoint = 31522000,  -- Set checkpoint slightly behind
    state_validation_hash = MD5('31522855|' || provider_entry_namehash),
    updated_at = NOW()
WHERE provider_entry_name = 'weatherapi.grid-beta.hypr'
RETURNING provider_entry_name, last_processed_block as new_block;
*/

-- 3. Reset a provider to its last known transaction
-- Uncomment and modify the provider name as needed
/*
UPDATE provider_leaderboard pl
SET 
    last_processed_block = COALESCE(
        (SELECT MAX(block_number) 
         FROM hypermap_transactions ht 
         WHERE ht.to_address = pl.wallet_address),
        0
    ),
    last_transaction_block = COALESCE(
        (SELECT MAX(block_number) 
         FROM hypermap_transactions ht 
         WHERE ht.to_address = pl.wallet_address),
        0
    ),
    processing_checkpoint = GREATEST(
        COALESCE(
            (SELECT MAX(block_number) - 1000
             FROM hypermap_transactions ht 
             WHERE ht.to_address = pl.wallet_address),
            0
        ),
        0
    ),
    state_validation_hash = MD5(
        COALESCE(
            (SELECT MAX(block_number)::TEXT 
             FROM hypermap_transactions ht 
             WHERE ht.to_address = pl.wallet_address),
            '0'
        ) || '|' || provider_entry_namehash
    ),
    updated_at = NOW()
WHERE provider_entry_name = 'weatherapi.grid-beta.hypr'
RETURNING provider_entry_name, last_processed_block as new_block;
*/

-- 4. Complete reset for a provider (start from beginning)
-- WARNING: This will cause reprocessing of all transactions!
-- Uncomment and modify the provider name as needed
/*
UPDATE provider_leaderboard
SET 
    last_processed_block = 0,
    last_transaction_block = 0,
    processing_checkpoint = 0,
    state_validation_hash = MD5('0|' || provider_entry_namehash),
    updated_at = NOW()
WHERE provider_entry_name = 'weatherapi.grid-beta.hypr'
RETURNING provider_entry_name, last_processed_block as new_block;

-- Also log this reset
INSERT INTO block_processing_log 
(provider_entry_namehash, provider_entry_name, old_block_number, new_block_number, change_type)
SELECT 
    provider_entry_namehash,
    provider_entry_name,
    last_processed_block,
    0,
    'reset'
FROM provider_leaderboard
WHERE provider_entry_name = 'weatherapi.grid-beta.hypr';
*/

-- 5. View block processing log for a specific provider
-- Uncomment and modify the provider name as needed
/*
SELECT 
    old_block_number,
    new_block_number,
    block_difference,
    change_type,
    created_at
FROM block_processing_log
WHERE provider_entry_name = 'weatherapi.grid-beta.hypr'
ORDER BY created_at DESC
LIMIT 50;
*/

-- 6. Emergency: Reset all providers to safe state
-- DANGER: Only use this as last resort!
/*
BEGIN;

-- Reset all providers to their last transaction
UPDATE provider_leaderboard pl
SET 
    last_processed_block = COALESCE(sub.max_block, 0),
    last_transaction_block = COALESCE(sub.max_block, 0),
    processing_checkpoint = GREATEST(COALESCE(sub.max_block, 0) - 1000, 0),
    state_validation_hash = MD5(COALESCE(sub.max_block::TEXT, '0') || '|' || pl.provider_entry_namehash),
    updated_at = NOW()
FROM (
    SELECT 
        to_address,
        MAX(block_number) as max_block
    FROM hypermap_transactions
    GROUP BY to_address
) sub
WHERE pl.wallet_address = sub.to_address
   OR pl.last_processed_block > 50000000;

-- Log all resets
INSERT INTO block_processing_log 
(provider_entry_namehash, provider_entry_name, old_block_number, new_block_number, change_type)
SELECT 
    provider_entry_namehash,
    provider_entry_name,
    last_processed_block,
    COALESCE(
        (SELECT MAX(block_number) 
         FROM hypermap_transactions ht 
         WHERE ht.to_address = provider_leaderboard.wallet_address),
        0
    ),
    'reset'
FROM provider_leaderboard
WHERE last_processed_block > 50000000;

-- Show results
SELECT 
    provider_entry_name,
    last_processed_block,
    last_transaction_block,
    processing_checkpoint
FROM provider_leaderboard
ORDER BY provider_entry_name;

-- COMMIT;  -- Uncomment to apply changes
-- ROLLBACK;  -- Uncomment to cancel changes
*/