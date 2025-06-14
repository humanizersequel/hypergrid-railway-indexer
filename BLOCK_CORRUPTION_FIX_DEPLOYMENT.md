# Block Corruption Fix - Deployment Guide

## Problem Summary
The payment tracker was experiencing block number corruption where `last_processed_block` values were being corrupted through string concatenation. For example, block `31522855` became `315228551` (an extra "1" appended), causing the tracker to skip all new transactions.

## Root Cause
PostgreSQL was returning `last_processed_block` as a string in some cases, and JavaScript's `+` operator was performing string concatenation instead of arithmetic addition:
- `"31522855" + 1 = "315228551"` (string concatenation)
- Instead of: `31522855 + 1 = 31522856` (arithmetic)

## Solution Overview

### 1. Database Schema Enhancements
- Added type constraints to prevent invalid block numbers
- Added new tracking columns for better state management
- Created audit log table for block number changes
- **IMPORTANT**: Migration clears all transaction data for a fresh start

### 2. Code Fixes
- Explicit integer parsing for all block numbers
- Self-healing mechanism to detect and fix corruption
- Enhanced logging and monitoring
- Fixed provider name display in logs

### 3. Monitoring Tools
- Diagnostic queries to check system health
- Manual recovery scripts for emergency fixes

## Deployment Steps

### Step 1: Backup Current Data
```bash
# Create a backup of your payments database before proceeding
pg_dump $PAYMENTS_DATABASE_URL > payments_backup_$(date +%Y%m%d_%H%M%S).sql
```

### Step 2: Apply Database Migrations
```bash
# Run the block corruption fix migration
# WARNING: This will CLEAR ALL TRANSACTION DATA and force re-indexing from the beginning!
psql $PAYMENTS_DATABASE_URL < fix-block-corruption.sql

# Verify the migration succeeded by checking the output
# You should see:
# - BEFORE FIX state (showing any corruption)
# - AFTER FIX state (showing corrected structure)
# - FINAL STATE AFTER RESET (showing all counters at 0)
# - Message: "All data cleared. Indexer will start from the beginning on next run."
```

### Step 3: Deploy Updated Code
The updated `payment-tracker.js` includes:
- Type safety for all block number operations
- Self-healing corruption detection
- Enhanced logging
- Proper provider name display

Deploy this through your normal deployment process (git push to Railway).

### Step 4: Monitor Initial Runs
After deployment, monitor the first few runs carefully:

```bash
# Check diagnostic information
psql $PAYMENTS_DATABASE_URL < diagnostic-payment-tracker.sql

# Watch the logs for any corruption detection
# You should see improved logging format like:
# === Payment Tracker Run Started ===
# Current blockchain height: 31530000
# Safe processing height: 31529990 (10 blocks behind)
```

### Step 5: Verify Fix
The system will automatically:
1. Detect any corrupted block numbers
2. Fix them by removing extra digits or resetting to last known good state
3. Log all changes to `block_processing_log` table

## New Features

### 1. Self-Healing
- Automatically detects block numbers > current height + 1000
- Attempts to fix by removing trailing digits
- Falls back to last known transaction if fix fails

### 2. Block Change Logging
All block number updates are logged with:
- Old and new block numbers
- Type of change (normal_advance, corruption_fix, reset, conservative_advance)
- Timestamp

### 3. Enhanced State Tracking
- `last_transaction_block`: Last block with an actual transaction
- `processing_checkpoint`: Safe checkpoint for recovery
- `state_validation_hash`: Integrity check for state

### 4. Improved Logging
- Clear section headers for run start/completion
- Provider names instead of IDs
- Block advancement details
- Validation warnings

## Monitoring Queries

### Check Provider Status
```sql
SELECT provider_entry_name, last_processed_block, 
       CASE WHEN last_processed_block > 100000000 THEN 'CORRUPTED' ELSE 'OK' END as status
FROM provider_leaderboard;
```

### View Recent Block Changes
```sql
SELECT * FROM block_processing_log 
ORDER BY created_at DESC LIMIT 20;
```

### Check for Anomalies
```sql
-- Run the diagnostic script for comprehensive health check
psql $PAYMENTS_DATABASE_URL < diagnostic-payment-tracker.sql
```

## Emergency Recovery

If automatic fixes don't work, use the manual recovery script:
```bash
psql $PAYMENTS_DATABASE_URL < manual-recovery.sql
```

This provides options to:
- Fix specific providers manually
- Reset to last known transaction
- Complete reset if needed

## Expected Behavior After Fix

1. **First Run After Migration**: Will start processing from block 0 for all providers (complete re-index)
2. **Processing Time**: Initial runs will take longer as all historical transactions are re-processed
3. **Subsequent Runs**: Should process normally with proper advancement
4. **Logging**: Clear, informative logs with provider names
5. **No More Corruption**: Type safety prevents future string concatenation issues

## Important Notes

- The migration **CLEARS ALL TRANSACTION DATA**
- All providers will start from block 0
- Historical transactions will be re-fetched and re-processed
- This ensures a clean slate with the new safeguards in place

## Rollback Plan

If issues occur:
1. Restore from backup: `psql $PAYMENTS_DATABASE_URL < payments_backup_[timestamp].sql`
2. Revert code deployment in Railway
3. Investigate logs from `block_processing_log` table

## Long-term Improvements

The fix includes infrastructure for future enhancements:
- Block range processing capability
- State validation and integrity checking
- Comprehensive audit trail
- Better error recovery mechanisms