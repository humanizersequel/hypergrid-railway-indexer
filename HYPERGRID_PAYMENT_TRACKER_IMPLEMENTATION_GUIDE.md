# Hypergrid Payment Tracker Implementation Guide

## Overview

This document provides exhaustive implementation details for building a Hypergrid payment tracking system that monitors USDC payments to provider wallets from valid Hypermap Token Bound Accounts (TBAs). The system maintains a leaderboard of transactions within the Hypergrid ecosystem.

## System Architecture

### Components

1. **Payment Tracker Service** (`payment-tracker.js`)
   - Connects to the existing Hypermap indexer database (read-only)
   - Connects to a new payments database (read-write)
   - Fetches USDC transactions from Basescan API
   - Validates sender addresses against Hypermap TBAs
   - Updates payment records and leaderboard

2. **Two PostgreSQL Databases**
   - **Existing Indexer DB**: Contains Hypermap entries, notes, and TBAs
   - **New Payments DB**: Stores validated transactions and leaderboard data

3. **Scheduled Execution**
   - Runs every 10 minutes via cron job or scheduler

## Detailed Implementation Steps

### Step 1: Database Schema Setup

Create a new PostgreSQL database on Railway for payments data.

#### SQL Setup Script (`setup-payments-db.sql`)

```sql
-- Create the transactions table
CREATE TABLE IF NOT EXISTS hypermap_transactions (
    id SERIAL PRIMARY KEY,
    tx_hash VARCHAR(66) UNIQUE NOT NULL,
    block_number BIGINT NOT NULL,
    timestamp TIMESTAMP NOT NULL,
    from_address VARCHAR(42) NOT NULL,
    from_hypermap_name TEXT NOT NULL,
    to_address VARCHAR(42) NOT NULL,
    to_provider_id TEXT NOT NULL,
    value_usdc DECIMAL(20, 6) NOT NULL, -- USDC has 6 decimals
    gas_used BIGINT,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Create the leaderboard table
CREATE TABLE IF NOT EXISTS provider_leaderboard (
    id SERIAL PRIMARY KEY,
    provider_entry_namehash VARCHAR(66) UNIQUE NOT NULL,
    provider_entry_name TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    wallet_address VARCHAR(42) NOT NULL,
    total_usdc_received DECIMAL(20, 6) DEFAULT 0,
    transaction_count INTEGER DEFAULT 0,
    unique_sender_count INTEGER DEFAULT 0,
    first_transaction_at TIMESTAMP,
    last_transaction_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Create tracking state table
CREATE TABLE IF NOT EXISTS tracker_state (
    id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    last_run_at TIMESTAMP,
    last_successful_run_at TIMESTAMP,
    last_error TEXT,
    total_runs INTEGER DEFAULT 0,
    successful_runs INTEGER DEFAULT 0,
    failed_runs INTEGER DEFAULT 0
);

-- Create indexes for performance
CREATE INDEX idx_transactions_from ON hypermap_transactions(from_address);
CREATE INDEX idx_transactions_to ON hypermap_transactions(to_address);
CREATE INDEX idx_transactions_block ON hypermap_transactions(block_number);
CREATE INDEX idx_transactions_timestamp ON hypermap_transactions(timestamp);
CREATE INDEX idx_leaderboard_wallet ON provider_leaderboard(wallet_address);
CREATE INDEX idx_leaderboard_total ON provider_leaderboard(total_usdc_received DESC);

-- Initialize tracker state
INSERT INTO tracker_state (id) VALUES (1) ON CONFLICT DO NOTHING;
```

### Step 2: Environment Configuration

Required environment variables:

```env
# Existing indexer database (read-only access)
INDEXER_DATABASE_URL=postgresql://user:pass@host:port/indexer_db

# New payments database (read-write access)
PAYMENTS_DATABASE_URL=postgresql://user:pass@host:port/payments_db

# Basescan API key (not Etherscan - Base uses Basescan)
BASESCAN_API_KEY=YOUR_API_KEY_HERE

# Configuration
POLL_INTERVAL_MS=600000  # 10 minutes
USDC_CONTRACT_ADDRESS=0x833589fcd6edb6e08f4c7c32d4f71b54bda02913
BASESCAN_API_URL=https://api.basescan.org/api
GRID_BETA_HYPR_LABEL=grid-beta.hypr
MAX_RETRIES=3
RETRY_DELAY_MS=5000
```

### Step 3: Core Implementation Logic

#### 3.1 Finding grid-beta.hypr's Namehash

```javascript
// The system must first calculate the namehash of "grid-beta.hypr"
// This involves:
// 1. Split the name into labels: ["grid-beta", "hypr"]
// 2. Start from root hash (0x0000...0000)
// 3. For each label from right to left:
//    - Convert label to bytes
//    - namehash = keccak256(parenthash + keccak256(label))

async function findGridBetaHyprNamehash(indexerDb) {
    // First, find "hypr" under root
    const hyprResult = await indexerDb.query(`
        SELECT namehash FROM entries 
        WHERE label = 'hypr' 
        AND parent_hash = '0x0000000000000000000000000000000000000000000000000000000000000000'
    `);
    
    if (hyprResult.rows.length === 0) {
        throw new Error('hypr namespace not found');
    }
    
    const hyprHash = hyprResult.rows[0].namehash;
    
    // Then find "grid-beta" under "hypr"
    const gridBetaResult = await indexerDb.query(`
        SELECT namehash FROM entries 
        WHERE label = 'grid-beta' 
        AND parent_hash = $1
    `, [hyprHash]);
    
    if (gridBetaResult.rows.length === 0) {
        throw new Error('grid-beta.hypr namespace not found');
    }
    
    return gridBetaResult.rows[0].namehash;
}
```

#### 3.2 Fetching Provider Entries and Notes

```javascript
async function fetchProviderEntries(indexerDb, gridBetaHyprHash) {
    // Get all direct children of grid-beta.hypr
    const entriesResult = await indexerDb.query(`
        SELECT 
            e.namehash,
            e.label,
            e.full_name,
            e.tba,
            wallet_note.interpreted_data as wallet_address,
            provider_note.interpreted_data as provider_id
        FROM entries e
        LEFT JOIN notes wallet_note ON 
            wallet_note.entry_hash = e.namehash 
            AND wallet_note.label = '~wallet'
        LEFT JOIN notes provider_note ON 
            provider_note.entry_hash = e.namehash 
            AND provider_note.label = '~provider-id'
        WHERE e.parent_hash = $1
        AND wallet_note.interpreted_data IS NOT NULL
        AND provider_note.interpreted_data IS NOT NULL
    `, [gridBetaHyprHash]);
    
    return entriesResult.rows;
}
```

#### 3.3 Building TBA Address Lookup

```javascript
// Build an efficient lookup of all TBA addresses to their full names
async function buildTbaLookup(indexerDb) {
    const result = await indexerDb.query(`
        SELECT tba, full_name, namehash 
        FROM entries 
        WHERE tba IS NOT NULL
    `);
    
    // Create a Map for O(1) lookups
    const tbaMap = new Map();
    for (const row of result.rows) {
        tbaMap.set(row.tba.toLowerCase(), {
            fullName: row.full_name,
            namehash: row.namehash
        });
    }
    
    return tbaMap;
}
```

#### 3.4 Fetching USDC Transactions from Basescan

```javascript
async function fetchUsdcTransactions(walletAddress, fromBlock = 0) {
    const url = new URL(BASESCAN_API_URL);
    url.searchParams.append('module', 'account');
    url.searchParams.append('action', 'tokentx');
    url.searchParams.append('address', walletAddress);
    url.searchParams.append('contractaddress', USDC_CONTRACT_ADDRESS);
    url.searchParams.append('startblock', fromBlock);
    url.searchParams.append('sort', 'asc');
    url.searchParams.append('apikey', BASESCAN_API_KEY);
    
    // Implement retry logic
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            const response = await fetch(url.toString());
            const data = await response.json();
            
            if (data.status === '1') {
                return data.result.filter(tx => 
                    tx.to.toLowerCase() === walletAddress.toLowerCase()
                );
            }
            
            throw new Error(data.message || 'API request failed');
        } catch (error) {
            if (attempt === MAX_RETRIES) throw error;
            await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
        }
    }
}
```

#### 3.5 Processing Transactions

```javascript
async function processProviderTransactions(provider, tbaLookup, paymentsDb) {
    // Get the last processed block for this wallet
    const lastBlockResult = await paymentsDb.query(`
        SELECT MAX(block_number) as last_block 
        FROM hypermap_transactions 
        WHERE to_address = $1
    `, [provider.wallet_address]);
    
    const fromBlock = lastBlockResult.rows[0].last_block 
        ? lastBlockResult.rows[0].last_block + 1 
        : 0;
    
    // Fetch new transactions
    const transactions = await fetchUsdcTransactions(
        provider.wallet_address, 
        fromBlock
    );
    
    // Process each transaction
    const validTransactions = [];
    for (const tx of transactions) {
        const fromAddress = tx.from.toLowerCase();
        const tbaInfo = tbaLookup.get(fromAddress);
        
        if (tbaInfo) {
            // This is a valid TBA transaction
            validTransactions.push({
                txHash: tx.hash,
                blockNumber: parseInt(tx.blockNumber),
                timestamp: new Date(parseInt(tx.timeStamp) * 1000),
                fromAddress: tx.from,
                fromHypermapName: tbaInfo.fullName,
                toAddress: tx.to,
                toProviderId: provider.provider_id,
                valueUsdc: parseFloat(tx.value) / 1e6, // Convert from 6 decimals
                gasUsed: parseInt(tx.gasUsed)
            });
        }
    }
    
    return validTransactions;
}
```

#### 3.6 Updating Database Records

```javascript
async function updatePaymentRecords(paymentsDb, provider, validTransactions) {
    const client = await paymentsDb.connect();
    
    try {
        await client.query('BEGIN');
        
        // Insert new transactions
        for (const tx of validTransactions) {
            await client.query(`
                INSERT INTO hypermap_transactions (
                    tx_hash, block_number, timestamp, from_address,
                    from_hypermap_name, to_address, to_provider_id,
                    value_usdc, gas_used
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                ON CONFLICT (tx_hash) DO NOTHING
            `, [
                tx.txHash, tx.blockNumber, tx.timestamp, tx.fromAddress,
                tx.fromHypermapName, tx.toAddress, tx.toProviderId,
                tx.valueUsdc, tx.gasUsed
            ]);
        }
        
        // Update leaderboard
        const stats = await client.query(`
            SELECT 
                COUNT(*) as tx_count,
                SUM(value_usdc) as total_usdc,
                COUNT(DISTINCT from_address) as unique_senders,
                MIN(timestamp) as first_tx,
                MAX(timestamp) as last_tx
            FROM hypermap_transactions
            WHERE to_address = $1
        `, [provider.wallet_address]);
        
        const { tx_count, total_usdc, unique_senders, first_tx, last_tx } = stats.rows[0];
        
        await client.query(`
            INSERT INTO provider_leaderboard (
                provider_entry_namehash, provider_entry_name, provider_id,
                wallet_address, total_usdc_received, transaction_count,
                unique_sender_count, first_transaction_at, last_transaction_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            ON CONFLICT (provider_entry_namehash) DO UPDATE SET
                total_usdc_received = $5,
                transaction_count = $6,
                unique_sender_count = $7,
                first_transaction_at = $8,
                last_transaction_at = $9,
                updated_at = NOW()
        `, [
            provider.namehash, provider.full_name, provider.provider_id,
            provider.wallet_address, total_usdc || 0, tx_count || 0,
            unique_senders || 0, first_tx, last_tx
        ]);
        
        await client.query('COMMIT');
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}
```

### Step 4: Main Execution Flow

```javascript
async function runPaymentTracker() {
    const indexerDb = new Pool({ connectionString: INDEXER_DATABASE_URL });
    const paymentsDb = new Pool({ connectionString: PAYMENTS_DATABASE_URL });
    
    try {
        // Update tracker state
        await paymentsDb.query(`
            UPDATE tracker_state 
            SET last_run_at = NOW(), total_runs = total_runs + 1
        `);
        
        // Find grid-beta.hypr namespace
        const gridBetaHyprHash = await findGridBetaHyprNamehash(indexerDb);
        
        // Get all provider entries
        const providers = await fetchProviderEntries(indexerDb, gridBetaHyprHash);
        console.log(`Found ${providers.length} providers under grid-beta.hypr`);
        
        // Build TBA lookup
        const tbaLookup = await buildTbaLookup(indexerDb);
        console.log(`Loaded ${tbaLookup.size} TBA addresses`);
        
        // Process each provider
        for (const provider of providers) {
            try {
                const validTransactions = await processProviderTransactions(
                    provider, 
                    tbaLookup, 
                    paymentsDb
                );
                
                if (validTransactions.length > 0) {
                    await updatePaymentRecords(paymentsDb, provider, validTransactions);
                    console.log(`Processed ${validTransactions.length} transactions for ${provider.provider_id}`);
                }
                
                // Rate limit protection
                await new Promise(resolve => setTimeout(resolve, 1000));
                
            } catch (error) {
                console.error(`Error processing provider ${provider.provider_id}:`, error);
            }
        }
        
        // Update successful run
        await paymentsDb.query(`
            UPDATE tracker_state 
            SET last_successful_run_at = NOW(), 
                successful_runs = successful_runs + 1,
                last_error = NULL
        `);
        
    } catch (error) {
        console.error('Payment tracker error:', error);
        
        // Update failed run
        await paymentsDb.query(`
            UPDATE tracker_state 
            SET failed_runs = failed_runs + 1,
                last_error = $1
        `, [error.message]);
        
        throw error;
    } finally {
        await indexerDb.end();
        await paymentsDb.end();
    }
}
```

### Step 5: Package Configuration

#### `package.json`

```json
{
  "name": "hypergrid-payment-tracker",
  "version": "1.0.0",
  "description": "Tracks USDC payments to Hypergrid providers from Hypermap TBAs",
  "main": "payment-tracker.js",
  "scripts": {
    "start": "node payment-tracker.js",
    "setup-db": "psql $PAYMENTS_DATABASE_URL < setup-payments-db.sql",
    "test-run": "node payment-tracker.js --test"
  },
  "dependencies": {
    "pg": "^8.11.5",
    "node-fetch": "^3.3.2",
    "web3": "^4.8.0"
  },
  "engines": {
    "node": ">=18"
  }
}
```

### Step 6: Scheduling Options

#### Option 1: Using Node.js Internal Scheduler

```javascript
// Add to payment-tracker.js
if (process.argv.includes('--daemon')) {
    console.log('Starting payment tracker daemon...');
    
    // Run immediately
    runPaymentTracker().catch(console.error);
    
    // Schedule every 10 minutes
    setInterval(() => {
        runPaymentTracker().catch(console.error);
    }, POLL_INTERVAL_MS);
}
```

#### Option 2: Using Railway Cron Jobs

In Railway, set up a cron job with expression `*/10 * * * *` to run every 10 minutes.

#### Option 3: Using System Cron

```bash
# Add to crontab
*/10 * * * * cd /app && node payment-tracker.js >> /var/log/payment-tracker.log 2>&1
```

### Step 7: Error Handling and Resilience

1. **API Rate Limiting**
   - Implement exponential backoff
   - Track API usage in database
   - Use multiple API keys if available

2. **Database Connection Failures**
   - Implement connection pooling with retry
   - Use read replicas for indexer database
   - Transaction rollback on failures

3. **Data Consistency**
   - Use database transactions for all updates
   - Implement idempotent operations
   - Track processing state per wallet

### Step 8: Monitoring and Alerting

#### Health Check Queries

```sql
-- Check tracker health
SELECT * FROM tracker_state;

-- Check recent transactions
SELECT * FROM hypermap_transactions 
ORDER BY timestamp DESC 
LIMIT 10;

-- View leaderboard
SELECT 
    provider_entry_name,
    provider_id,
    total_usdc_received,
    transaction_count,
    unique_sender_count
FROM provider_leaderboard
ORDER BY total_usdc_received DESC;

-- Check for stale data
SELECT 
    provider_id,
    wallet_address,
    last_transaction_at,
    NOW() - last_transaction_at as time_since_last_tx
FROM provider_leaderboard
WHERE last_transaction_at < NOW() - INTERVAL '24 hours'
ORDER BY last_transaction_at;
```

### Step 9: Performance Optimizations

1. **Batch API Requests**
   - Group multiple wallet queries when possible
   - Cache API responses for short periods

2. **Database Optimizations**
   - Use prepared statements
   - Batch insert transactions
   - Implement database partitioning for large datasets

3. **Memory Management**
   - Stream large result sets
   - Clear caches periodically
   - Monitor memory usage

### Step 10: Security Considerations

1. **API Key Management**
   - Store API keys in environment variables
   - Rotate keys regularly
   - Monitor for unauthorized usage

2. **Database Security**
   - Use read-only credentials for indexer database
   - Implement row-level security if needed
   - Regular backups of payments database

3. **Input Validation**
   - Validate all addresses are valid Ethereum addresses
   - Sanitize provider IDs and names
   - Check transaction values are reasonable

## Deployment Instructions

1. **Create New Database on Railway**
   - Add a new PostgreSQL service
   - Note the `DATABASE_URL`

2. **Run Database Setup**
   ```bash
   psql $PAYMENTS_DATABASE_URL < setup-payments-db.sql
   ```

3. **Configure Environment Variables**
   - Set all required environment variables in Railway

4. **Deploy the Service**
   - Push code to repository
   - Railway will auto-deploy

5. **Verify Operation**
   - Check logs for successful runs
   - Query database to verify data population

## Troubleshooting Guide

### Common Issues

1. **"grid-beta.hypr namespace not found"**
   - Ensure the indexer has processed the grid-beta.hypr minting
   - Check the label spelling and parent relationships

2. **API Rate Limits**
   - Reduce batch sizes
   - Increase delays between requests
   - Use multiple API keys

3. **Missing Transactions**
   - Check wallet address formatting
   - Verify USDC contract address
   - Ensure TBA lookup is complete

4. **Database Connection Issues**
   - Verify DATABASE_URL format
   - Check network connectivity
   - Ensure proper SSL configuration

## Testing Strategy

1. **Unit Tests**
   - Test namehash calculation
   - Test transaction filtering
   - Test database operations

2. **Integration Tests**
   - Test with known wallet addresses
   - Verify TBA validation
   - Test error handling

3. **Load Tests**
   - Test with high transaction volumes
   - Verify performance under load
   - Test API rate limit handling

## Future Enhancements

1. **Real-time Updates**
   - WebSocket connections for live transactions
   - Event-driven architecture

2. **Advanced Analytics**
   - Transaction patterns analysis
   - Provider performance metrics
   - Predictive modeling

3. **Multi-chain Support**
   - Support other chains beyond Base
   - Cross-chain transaction tracking

4. **API Endpoints**
   - REST API for leaderboard data
   - GraphQL for complex queries
   - WebSocket for real-time updates