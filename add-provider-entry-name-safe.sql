-- Add provider_entry_name to hypermap_transactions table
-- This migration safely handles existing data and edge cases

BEGIN;

-- Add the provider_entry_name column to hypermap_transactions
ALTER TABLE hypermap_transactions 
ADD COLUMN IF NOT EXISTS provider_entry_name TEXT;

-- Update existing records by joining with provider_leaderboard
UPDATE hypermap_transactions ht
SET provider_entry_name = pl.provider_entry_name
FROM provider_leaderboard pl
WHERE ht.to_address = pl.wallet_address
AND ht.provider_entry_name IS NULL;

-- Check if any records couldn't be matched
DO $$
DECLARE
    unmatched_count INTEGER;
BEGIN
    SELECT COUNT(*) INTO unmatched_count
    FROM hypermap_transactions
    WHERE provider_entry_name IS NULL;
    
    IF unmatched_count > 0 THEN
        RAISE NOTICE 'WARNING: % transactions could not be matched to provider entries', unmatched_count;
        RAISE NOTICE 'These may be from providers that were removed or transactions before tracking began properly';
    END IF;
END $$;

-- For unmatched records, set a placeholder value
UPDATE hypermap_transactions
SET provider_entry_name = 'unknown-' || to_provider_id
WHERE provider_entry_name IS NULL;

-- Now we can safely make it NOT NULL
ALTER TABLE hypermap_transactions
ALTER COLUMN provider_entry_name SET NOT NULL;

-- Add an index for efficient queries
CREATE INDEX IF NOT EXISTS idx_transactions_provider_entry_name 
ON hypermap_transactions(provider_entry_name);

COMMIT;

-- Show summary of the migration
SELECT 
    'Migration completed!' as status,
    COUNT(*) as total_transactions,
    COUNT(DISTINCT provider_entry_name) as unique_provider_entries,
    COUNT(DISTINCT to_provider_id) as unique_provider_ids,
    COUNT(CASE WHEN provider_entry_name LIKE 'unknown-%' THEN 1 END) as unknown_entries
FROM hypermap_transactions;

-- Show any unknown entries if they exist
SELECT DISTINCT 
    provider_entry_name,
    to_provider_id,
    to_address,
    COUNT(*) as transaction_count
FROM hypermap_transactions
WHERE provider_entry_name LIKE 'unknown-%'
GROUP BY provider_entry_name, to_provider_id, to_address
ORDER BY transaction_count DESC;