-- Payment Tracker Diagnostic Script
-- Run this to check the current state and health of the payment tracking system

-- 1. Provider Status Overview
SELECT 
    '=== PROVIDER STATUS OVERVIEW ===' as section;

SELECT 
    provider_entry_name,
    wallet_address,
    last_processed_block,
    last_transaction_block,
    processing_checkpoint,
    transaction_count,
    total_usdc_received,
    unique_sender_count,
    CASE 
        WHEN last_processed_block > 100000000 THEN 'CORRUPTED - NEEDS FIX'
        WHEN last_processed_block = 0 THEN 'NOT STARTED'
        WHEN last_transaction_block > 0 AND last_processed_block < last_transaction_block THEN 'BEHIND'
        WHEN last_processed_block > last_transaction_block + 10000 THEN 'TOO FAR AHEAD'
        ELSE 'OK'
    END as status,
    updated_at
FROM provider_leaderboard
ORDER BY last_processed_block DESC;

-- 2. Block Processing Gaps
SELECT 
    '=== BLOCK PROCESSING GAPS ===' as section;

WITH provider_gaps AS (
    SELECT 
        pl.provider_entry_name,
        pl.last_processed_block,
        COALESCE(MAX(ht.block_number), 0) as max_transaction_block,
        pl.last_processed_block - COALESCE(MAX(ht.block_number), 0) as blocks_ahead
    FROM provider_leaderboard pl
    LEFT JOIN hypermap_transactions ht ON ht.to_address = pl.wallet_address
    GROUP BY pl.provider_entry_name, pl.last_processed_block
)
SELECT * FROM provider_gaps
WHERE blocks_ahead != 0
ORDER BY blocks_ahead DESC;

-- 3. Recent Transactions
SELECT 
    '=== RECENT TRANSACTIONS (Last 10) ===' as section;

SELECT 
    provider_entry_name,
    block_number,
    timestamp,
    from_hypermap_name,
    value_usdc,
    tx_hash
FROM hypermap_transactions
ORDER BY block_number DESC
LIMIT 10;

-- 4. Tracker State
SELECT 
    '=== TRACKER STATE ===' as section;

SELECT 
    last_run_at,
    last_successful_run_at,
    total_runs,
    successful_runs,
    failed_runs,
    ROUND(100.0 * successful_runs / NULLIF(total_runs, 0), 2) as success_rate_pct,
    last_error
FROM tracker_state
WHERE id = 1;

-- 5. Block Processing History (Last 20 changes)
SELECT 
    '=== RECENT BLOCK PROCESSING HISTORY ===' as section;

SELECT 
    provider_entry_name,
    old_block_number,
    new_block_number,
    block_difference,
    change_type,
    created_at
FROM block_processing_log
ORDER BY created_at DESC
LIMIT 20;

-- 6. Suspicious Block Changes
SELECT 
    '=== SUSPICIOUS BLOCK CHANGES ===' as section;

SELECT 
    provider_entry_name,
    old_block_number,
    new_block_number,
    block_difference,
    change_type,
    created_at
FROM block_processing_log
WHERE 
    (change_type = 'normal_advance' AND block_difference > 1000) OR
    (block_difference < 0) OR
    (new_block_number > 100000000)
ORDER BY created_at DESC;

-- 7. Provider Transaction Summary
SELECT 
    '=== PROVIDER TRANSACTION SUMMARY ===' as section;

WITH provider_stats AS (
    SELECT 
        pl.provider_entry_name,
        pl.transaction_count as leaderboard_tx_count,
        COUNT(ht.tx_hash) as actual_tx_count,
        pl.total_usdc_received as leaderboard_usdc,
        COALESCE(SUM(ht.value_usdc), 0) as actual_usdc,
        pl.unique_sender_count as leaderboard_unique_senders,
        COUNT(DISTINCT ht.from_address) as actual_unique_senders
    FROM provider_leaderboard pl
    LEFT JOIN hypermap_transactions ht ON ht.to_address = pl.wallet_address
    GROUP BY pl.provider_entry_name, pl.transaction_count, pl.total_usdc_received, pl.unique_sender_count
)
SELECT 
    provider_entry_name,
    leaderboard_tx_count,
    actual_tx_count,
    leaderboard_tx_count - actual_tx_count as tx_count_diff,
    ROUND(leaderboard_usdc::numeric, 2) as leaderboard_usdc,
    ROUND(actual_usdc::numeric, 2) as actual_usdc,
    ROUND((leaderboard_usdc - actual_usdc)::numeric, 2) as usdc_diff,
    leaderboard_unique_senders,
    actual_unique_senders,
    leaderboard_unique_senders - actual_unique_senders as unique_sender_diff
FROM provider_stats
WHERE leaderboard_tx_count != actual_tx_count 
   OR ABS(leaderboard_usdc - actual_usdc) > 0.01
   OR leaderboard_unique_senders != actual_unique_senders;

-- 8. Time Since Last Activity
SELECT 
    '=== TIME SINCE LAST ACTIVITY ===' as section;

SELECT 
    provider_entry_name,
    last_transaction_at,
    CASE 
        WHEN last_transaction_at IS NULL THEN 'Never'
        ELSE EXTRACT(EPOCH FROM (NOW() - last_transaction_at)) / 3600 || ' hours ago'
    END as time_since_last_tx,
    updated_at,
    EXTRACT(EPOCH FROM (NOW() - updated_at)) / 60 || ' minutes ago' as time_since_update
FROM provider_leaderboard
ORDER BY updated_at DESC;