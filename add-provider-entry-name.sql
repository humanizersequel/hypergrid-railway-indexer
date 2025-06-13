-- Add provider_entry_name to hypermap_transactions table
-- This is needed because provider-id alone is insufficient - one provider-id can host multiple provider entries

BEGIN;

-- Add the provider_entry_name column to hypermap_transactions
ALTER TABLE hypermap_transactions 
ADD COLUMN IF NOT EXISTS provider_entry_name TEXT;

-- Update existing records by joining with provider_leaderboard
UPDATE hypermap_transactions ht
SET provider_entry_name = pl.provider_entry_name
FROM provider_leaderboard pl
WHERE ht.to_address = pl.wallet_address;

-- Make the column NOT NULL for future inserts
ALTER TABLE hypermap_transactions
ALTER COLUMN provider_entry_name SET NOT NULL;

-- Add an index for efficient queries
CREATE INDEX IF NOT EXISTS idx_transactions_provider_entry_name 
ON hypermap_transactions(provider_entry_name);

COMMIT;

-- Verify the changes
SELECT 
    COUNT(*) as total_transactions,
    COUNT(DISTINCT provider_entry_name) as unique_provider_entries,
    COUNT(DISTINCT to_provider_id) as unique_provider_ids
FROM hypermap_transactions;