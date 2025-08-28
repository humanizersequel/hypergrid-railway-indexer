import pg from 'pg';
import fetch from 'node-fetch';
import { config } from 'dotenv';

const { Pool } = pg;
config();

// Configuration
const INDEXER_DATABASE_URL = process.env.INDEXER_DATABASE_URL;
const PAYMENTS_DATABASE_URL = process.env.PAYMENTS_DATABASE_URL;
const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY;
const USDC_CONTRACT_ADDRESS = process.env.USDC_CONTRACT_ADDRESS || '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const ETHERSCAN_API_URL = process.env.ETHERSCAN_API_URL || 'https://api.etherscan.io/v2/api';
const BASE_CHAIN_ID = process.env.BASE_CHAIN_ID || '8453';
const BLOCK_SAFETY_BUFFER = parseInt(process.env.BLOCK_SAFETY_BUFFER || '10');
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || '600000');

// Production configuration
const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || '50');
const RATE_LIMIT_DELAY_MS = parseInt(process.env.RATE_LIMIT_DELAY_MS || '1000');
const MAX_RETRIES = parseInt(process.env.MAX_RETRIES || '3');
const RETRY_DELAY_MS = parseInt(process.env.RETRY_DELAY_MS || '5000');
const CONNECTION_POOL_SIZE = parseInt(process.env.CONNECTION_POOL_SIZE || '10');
const CONNECTION_TIMEOUT_MS = parseInt(process.env.CONNECTION_TIMEOUT_MS || '30000');

// Global connection pools (singleton pattern)
let indexerPool = null;
let paymentsPool = null;

// Rate limiting state
let lastApiCall = 0;
const apiCallQueue = [];

// Memory management
const memoryThreshold = 500 * 1024 * 1024; // 500MB
let transactionBatch = [];

class RateLimiter {
    constructor(maxCallsPerSecond = 1) {
        this.maxCallsPerSecond = maxCallsPerSecond;
        this.lastCallTime = 0;
    }

    async wait() {
        const now = Date.now();
        const timeSinceLastCall = now - this.lastCallTime;
        const minInterval = 1000 / this.maxCallsPerSecond;
        
        if (timeSinceLastCall < minInterval) {
            const waitTime = minInterval - timeSinceLastCall;
            await new Promise(resolve => setTimeout(resolve, waitTime));
        }
        
        this.lastCallTime = Date.now();
    }
}

class ConnectionManager {
    static getIndexerPool() {
        if (!indexerPool) {
            indexerPool = new Pool({
                connectionString: INDEXER_DATABASE_URL,
                max: CONNECTION_POOL_SIZE,
                idleTimeoutMillis: CONNECTION_TIMEOUT_MS,
                connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
                statement_timeout: 30000,
                query_timeout: 30000
            });

            // Handle pool errors
            indexerPool.on('error', (err) => {
                console.error('Indexer pool error:', err);
                indexerPool = null; // Force recreation on next call
            });
        }
        return indexerPool;
    }

    static getPaymentsPool() {
        if (!paymentsPool) {
            paymentsPool = new Pool({
                connectionString: PAYMENTS_DATABASE_URL,
                max: CONNECTION_POOL_SIZE,
                idleTimeoutMillis: CONNECTION_TIMEOUT_MS,
                connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
                statement_timeout: 30000,
                query_timeout: 30000
            });

            // Handle pool errors
            paymentsPool.on('error', (err) => {
                console.error('Payments pool error:', err);
                paymentsPool = null; // Force recreation on next call
            });
        }
        return paymentsPool;
    }

    static async closeAll() {
        if (indexerPool) {
            await indexerPool.end();
            indexerPool = null;
        }
        if (paymentsPool) {
            await paymentsPool.end();
            paymentsPool = null;
        }
    }
}

// Memory monitoring
function checkMemoryUsage() {
    const memUsage = process.memoryUsage();
    const heapUsed = memUsage.heapUsed;
    
    if (heapUsed > memoryThreshold) {
        console.warn(`Memory usage high: ${(heapUsed / 1024 / 1024).toFixed(2)}MB`);
        
        // Force garbage collection if available
        if (global.gc) {
            global.gc();
            console.log('Garbage collection triggered');
        }
        
        return false;
    }
    return true;
}

// Retry wrapper with exponential backoff
async function withRetry(operation, maxRetries = MAX_RETRIES) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await operation();
        } catch (error) {
            if (attempt === maxRetries) {
                throw error;
            }
            
            const delay = RETRY_DELAY_MS * Math.pow(2, attempt - 1);
            console.warn(`Attempt ${attempt} failed, retrying in ${delay}ms:`, error.message);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
}

// Rate-limited API calls
const rateLimiter = new RateLimiter(1); // 1 call per second

async function getCurrentBlockHeight() {
    await rateLimiter.wait();
    
    return withRetry(async () => {
        const url = new URL(ETHERSCAN_API_URL);
        url.searchParams.append('module', 'proxy');
        url.searchParams.append('action', 'eth_blockNumber');
        url.searchParams.append('chainid', BASE_CHAIN_ID);
        url.searchParams.append('apikey', ETHERSCAN_API_KEY);
        
        const response = await fetch(url.toString(), {
            timeout: 10000,
            headers: { 'User-Agent': 'Hypergrid-Payment-Tracker/1.0' }
        });
        
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        
        const data = await response.json();
        
        if (data.error) {
            throw new Error(`API Error: ${data.error.message}`);
        }
        
        return parseInt(data.result, 16);
    });
}

async function fetchUsdcTransactions(address, fromBlock, toBlock) {
    await rateLimiter.wait();
    
    return withRetry(async () => {
        const url = new URL(ETHERSCAN_API_URL);
        url.searchParams.append('module', 'account');
        url.searchParams.append('action', 'tokentx');
        url.searchParams.append('chainid', BASE_CHAIN_ID);
        url.searchParams.append('address', address);
        url.searchParams.append('contractaddress', USDC_CONTRACT_ADDRESS);
        url.searchParams.append('startblock', fromBlock.toString());
        url.searchParams.append('endblock', toBlock.toString());
        url.searchParams.append('sort', 'asc');
        url.searchParams.append('apikey', ETHERSCAN_API_KEY);
        
        console.log(`  API call: ${address} (blocks ${fromBlock}-${toBlock})`);
        
        const response = await fetch(url.toString(), {
            timeout: 15000,
            headers: { 'User-Agent': 'Hypergrid-Payment-Tracker/1.0' }
        });
        
        if (!response.ok) {
            console.error(`  API error: HTTP ${response.status}: ${response.statusText}`);
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        
        const data = await response.json();
        
        if (data.status === '1') {
            console.log(`  API success: ${data.result?.length || 0} transactions found`);
            return data.result || [];
        } else if (data.message === 'No transactions found') {
            console.log(`  API response: No transactions found`);
            return [];
        } else if (data.message && data.message.includes('rate limit')) {
            console.error(`  API rate limit: ${data.message}`);
            throw new Error('Rate limit exceeded');
        }
        
        console.error(`  API error: ${data.message || 'Unknown error'}`);
        throw new Error(data.message || 'API request failed');
    });
}

async function findGridHyprNamehash(client) {
    const hyprResult = await client.query(`
        SELECT namehash FROM entries 
        WHERE label = 'hypr' 
        AND parent_hash = '0x0000000000000000000000000000000000000000000000000000000000000000'
    `);
    
    if (hyprResult.rows.length === 0) {
        throw new Error('hypr namespace not found');
    }
    
    const hyprHash = hyprResult.rows[0].namehash;
    
    const gridResult = await client.query(`
        SELECT namehash FROM entries 
        WHERE label = 'grid' 
        AND parent_hash = $1
    `, [hyprHash]);
    
    if (gridResult.rows.length === 0) {
        throw new Error('grid.hypr namespace not found');
    }
    
    return gridResult.rows[0].namehash;
}

// Batch transaction insertion
async function insertTransactionBatch(client, transactions) {
    if (transactions.length === 0) return;
    
    const values = transactions.map((tx, index) => {
        const offset = index * 10;
        return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6}, $${offset + 7}, $${offset + 8}, $${offset + 9}, $${offset + 10})`;
    }).join(', ');
    
    const params = transactions.flatMap(tx => [
        tx.hash,
        tx.blockNumber,
        tx.timestamp,
        tx.fromAddress,
        tx.fromHypermapName,
        tx.toAddress,
        tx.toProviderId,
        tx.providerEntryName,
        tx.valueUsdc,
        tx.gasUsed
    ]);
    
    await client.query(`
        INSERT INTO hypermap_transactions (
            tx_hash, block_number, timestamp, from_address,
            from_hypermap_name, to_address, to_provider_id,
            provider_entry_name, value_usdc, gas_used
        ) VALUES ${values}
        ON CONFLICT (tx_hash) DO NOTHING
    `, params);
}

async function runPaymentTracker() {
    const indexerPool = ConnectionManager.getIndexerPool();
    const paymentsPool = ConnectionManager.getPaymentsPool();
    
    // Use transactions for data consistency
    const indexerClient = await indexerPool.connect();
    const paymentsClient = await paymentsPool.connect();
    
    try {
        // Start transaction on payments database
        await paymentsClient.query('BEGIN');
        
        console.log('\n=== Payment Tracker Started ===');
        console.log(`Time: ${new Date().toISOString()}`);
        console.log(`Memory usage: ${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2)}MB`);
        
        // Get current state within transaction
        const stateResult = await paymentsClient.query('SELECT last_processed_block FROM global_state WHERE id = 1');
        const lastProcessedBlock = parseInt(stateResult.rows[0]?.last_processed_block || 0);
        console.log(`Raw from DB: ${stateResult.rows[0]?.last_processed_block}, Parsed: ${lastProcessedBlock}`);
        
        // Get current blockchain height
        const currentHeight = await getCurrentBlockHeight();
        const safeHeight = currentHeight - BLOCK_SAFETY_BUFFER;
        
        console.log(`Last processed block: ${lastProcessedBlock}`);
        console.log(`Current height: ${currentHeight}, safe height: ${safeHeight}`);
        
        if (lastProcessedBlock >= safeHeight) {
            console.log('Already up to date');
            await paymentsClient.query('COMMIT');
            return;
        }
        
        // Find grid.hypr namespace
        const gridHyprHash = await findGridHyprNamehash(indexerClient);
        console.log(`Found grid.hypr: ${gridHyprHash}`);
        
        // Get all providers from grid.hypr in indexer
        const providers = await indexerClient.query(`
            SELECT 
                e.namehash,
                e.full_name,
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
        `, [gridHyprHash]);
        
        // Get all grid-wallet TBAs for validation
        const tbaResult = await indexerClient.query(`
            SELECT LOWER(tba) as tba, full_name 
            FROM entries 
            WHERE tba IS NOT NULL
            AND full_name LIKE 'grid-wallet.%'
        `);
        const tbaMap = new Map(tbaResult.rows.map(r => [r.tba, r.full_name]));
        
        console.log(`Processing ${providers.rows.length} providers, ${tbaMap.size} TBAs loaded`);
        
        // Ensure all providers are in the leaderboard
        for (const provider of providers.rows) {
            await paymentsClient.query(`
                INSERT INTO provider_leaderboard (
                    provider_entry_namehash, provider_entry_name, provider_id,
                    wallet_address, total_usdc_received, transaction_count,
                    unique_sender_count
                ) VALUES ($1, $2, $3, $4, 0, 0, 0)
                ON CONFLICT (provider_entry_namehash) DO NOTHING
            `, [provider.namehash, provider.full_name, provider.provider_id, provider.wallet_address.toLowerCase()]);
        }
        
        // Process each provider with batching
        const fromBlock = lastProcessedBlock + 1;
        const toBlock = safeHeight;
        console.log(`Block range calculation: lastProcessedBlock=${lastProcessedBlock}, fromBlock=${fromBlock}, toBlock=${toBlock}`);
        let totalTransactions = 0;
        transactionBatch = []; // Reset batch
        
        for (const provider of providers.rows) {
            // Memory check
            if (!checkMemoryUsage()) {
                console.warn('Memory threshold exceeded, processing current batch...');
                await insertTransactionBatch(paymentsClient, transactionBatch);
                transactionBatch = [];
            }
            
            console.log(`\nFetching transactions for ${provider.full_name}...`);
            
            try {
                const transactions = await fetchUsdcTransactions(provider.wallet_address, fromBlock, toBlock);
                const incomingTxs = transactions.filter(tx => 
                    tx.to.toLowerCase() === provider.wallet_address.toLowerCase()
                );
                
                let validTxs = 0;
                for (const tx of incomingTxs) {
                    const senderName = tbaMap.get(tx.from.toLowerCase());
                    if (senderName) {
                        // Add to batch instead of individual insert
                        transactionBatch.push({
                            hash: tx.hash,
                            blockNumber: parseInt(tx.blockNumber),
                            timestamp: new Date(parseInt(tx.timeStamp) * 1000),
                            fromAddress: tx.from.toLowerCase(),
                            fromHypermapName: senderName,
                            toAddress: tx.to.toLowerCase(),
                            toProviderId: provider.provider_id,
                            providerEntryName: provider.full_name,
                            valueUsdc: parseFloat(tx.value) / 1e6,
                            gasUsed: parseInt(tx.gasUsed)
                        });
                        validTxs++;
                        
                        // Flush batch if it gets too large
                        if (transactionBatch.length >= BATCH_SIZE) {
                            await insertTransactionBatch(paymentsClient, transactionBatch);
                            totalTransactions += transactionBatch.length;
                            transactionBatch = [];
                        }
                    }
                }
                
                console.log(`  Found ${incomingTxs.length} incoming, ${validTxs} from TBAs`);
                
            } catch (error) {
                console.error(`  Error processing ${provider.full_name}:`, error.message);
                // Continue with other providers instead of failing completely
            }
            
            // Rate limiting delay
            await new Promise(resolve => setTimeout(resolve, RATE_LIMIT_DELAY_MS));
        }
        
        // Insert remaining transactions in batch
        if (transactionBatch.length > 0) {
            await insertTransactionBatch(paymentsClient, transactionBatch);
            totalTransactions += transactionBatch.length;
        }
        
        // Update global state
        await paymentsClient.query(`
            UPDATE global_state 
            SET last_processed_block = $1, updated_at = NOW() 
            WHERE id = 1
        `, [parseInt(toBlock)]);
        
        // Update leaderboard
        console.log('\nUpdating provider leaderboard...');
        const updateResult = await paymentsClient.query(`
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
            WHERE LOWER(pl.wallet_address) = LOWER(stats.to_address)
            RETURNING pl.provider_entry_name, pl.total_usdc_received, pl.transaction_count
        `);
        
        console.log(`Updated ${updateResult.rowCount} providers`);
        for (const row of updateResult.rows) {
            const usdcAmount = parseFloat(row.total_usdc_received) || 0;
            console.log(`  ${row.provider_entry_name}: ${row.transaction_count} txs, $${usdcAmount.toFixed(2)} USDC`);
        }
        
        // Commit transaction
        await paymentsClient.query('COMMIT');
        
        console.log(`\nProcessed blocks ${fromBlock} to ${toBlock}`);
        console.log(`Added ${totalTransactions} new transactions`);
        console.log(`Final memory usage: ${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2)}MB`);
        console.log('=== Payment Tracker Completed ===\n');
        
    } catch (error) {
        // Rollback transaction on error
        try {
            await paymentsClient.query('ROLLBACK');
        } catch (rollbackError) {
            console.error('Rollback failed:', rollbackError);
        }
        
        console.error('Payment tracker error:', error);
        throw error;
    } finally {
        // Release connections back to pool
        indexerClient.release();
        paymentsClient.release();
    }
}

// Graceful shutdown handling
process.on('SIGINT', async () => {
    console.log('\nShutting down gracefully...');
    await ConnectionManager.closeAll();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    console.log('\nShutting down gracefully...');
    await ConnectionManager.closeAll();
    process.exit(0);
});

// Unhandled error handling
process.on('uncaughtException', async (error) => {
    console.error('Uncaught exception:', error);
    await ConnectionManager.closeAll();
    process.exit(1);
});

process.on('unhandledRejection', async (reason, promise) => {
    console.error('Unhandled rejection at:', promise, 'reason:', reason);
    await ConnectionManager.closeAll();
    process.exit(1);
});

// Run modes
if (process.argv.includes('--daemon')) {
    console.log('Starting payment tracker daemon...');
    console.log(`Will run every ${POLL_INTERVAL_MS / 1000 / 60} minutes`);
    console.log(`Batch size: ${BATCH_SIZE}, Rate limit: ${RATE_LIMIT_DELAY_MS}ms`);
    
    runPaymentTracker().catch(console.error);
    setInterval(() => {
        runPaymentTracker().catch(console.error);
    }, POLL_INTERVAL_MS);
} else {
    runPaymentTracker()
        .then(() => {
            ConnectionManager.closeAll();
            process.exit(0);
        })
        .catch(async (error) => {
            console.error(error);
            await ConnectionManager.closeAll();
            process.exit(1);
        });
}