-- Fix Address Case Sensitivity
-- Ensures all addresses are lowercase for consistent joining

BEGIN;

-- Update provider_leaderboard addresses to lowercase
UPDATE provider_leaderboard
SET wallet_address = LOWER(wallet_address)
WHERE wallet_address != LOWER(wallet_address);

-- Update transaction addresses to lowercase (if any exist)
UPDATE hypermap_transactions
SET 
    from_address = LOWER(from_address),
    to_address = LOWER(to_address)
WHERE 
    from_address != LOWER(from_address) OR 
    to_address != LOWER(to_address);

-- Now update the leaderboard with aggregated stats
UPDATE provider_leaderboard pl
SET 
    total_usdc_received = stats.total_usdc,
    transaction_count = stats.tx_count,
    unique_sender_count = stats.unique_senders,
    first_transaction_at = stats.first_tx,
    last_transaction_at = stats.last_tx,
    updated_at = NOW()
FROM (
    SELECT 
        to_address,
        COUNT(*) as tx_count,
        SUM(value_usdc) as total_usdc,
        COUNT(DISTINCT from_address) as unique_senders,
        MIN(timestamp) as first_tx,
        MAX(timestamp) as last_tx
    FROM hypermap_transactions
    GROUP BY to_address
) stats
WHERE pl.wallet_address = stats.to_address;

-- Show results
SELECT 
    provider_entry_name,
    wallet_address,
    transaction_count,
    total_usdc_received,
    unique_sender_count
FROM provider_leaderboard
WHERE transaction_count > 0
ORDER BY total_usdc_received DESC;

COMMIT;