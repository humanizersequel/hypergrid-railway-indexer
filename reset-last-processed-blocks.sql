-- Reset last_processed_block for all providers to force a re-scan
-- Use this if you suspect missed transactions during the buggy period

BEGIN;

-- Show current state before reset
SELECT 
    'BEFORE RESET' as state,
    provider_entry_name,
    wallet_address,
    last_processed_block,
    transaction_count,
    total_usdc_received
FROM provider_leaderboard
ORDER BY last_processed_block DESC;

-- Option 1: Reset to the last known good transaction for each provider
-- This is the safest approach - starts from the last transaction we know about
UPDATE provider_leaderboard pl
SET last_processed_block = COALESCE(
    (SELECT MAX(block_number) 
     FROM hypermap_transactions ht 
     WHERE ht.to_address = pl.wallet_address),
    0
);

-- Option 2: Reset to a specific block number (uncomment to use)
-- UPDATE provider_leaderboard SET last_processed_block = 12000000;

-- Option 3: Full reset to rescan everything (uncomment to use)
-- UPDATE provider_leaderboard SET last_processed_block = 0;

-- Show state after reset
SELECT 
    'AFTER RESET' as state,
    provider_entry_name,
    wallet_address,
    last_processed_block,
    transaction_count,
    total_usdc_received
FROM provider_leaderboard
ORDER BY last_processed_block DESC;

COMMIT;

-- Show how far back we're rescanning
SELECT 
    MIN(last_processed_block) as will_rescan_from_block,
    MAX(last_processed_block) as up_to_block,
    COUNT(*) as providers_affected
FROM provider_leaderboard;