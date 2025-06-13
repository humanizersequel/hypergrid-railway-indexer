-- Add incremental tracking support to the provider_leaderboard table
-- This migration adds a column to track the last processed block for each provider

BEGIN;

-- Add last_processed_block column to track where we left off for each provider
ALTER TABLE provider_leaderboard 
ADD COLUMN IF NOT EXISTS last_processed_block BIGINT DEFAULT 0;

-- Add an index for efficient lookups
CREATE INDEX IF NOT EXISTS idx_leaderboard_last_block 
ON provider_leaderboard(last_processed_block);

-- Update existing rows to set last_processed_block based on their latest transaction
UPDATE provider_leaderboard pl
SET last_processed_block = COALESCE(
    (SELECT MAX(block_number) 
     FROM hypermap_transactions ht 
     WHERE ht.to_address = pl.wallet_address),
    0
);

COMMIT;

-- Verify the changes
SELECT 
    provider_entry_name,
    wallet_address,
    transaction_count,
    last_processed_block
FROM provider_leaderboard
ORDER BY last_processed_block DESC
LIMIT 10;