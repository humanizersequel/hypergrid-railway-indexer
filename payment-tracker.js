import pg from 'pg';
import fetch from 'node-fetch';
import { config } from 'dotenv';
import crypto from 'crypto';

const { Pool } = pg;

config();

const INDEXER_DATABASE_URL = process.env.INDEXER_DATABASE_URL;
const PAYMENTS_DATABASE_URL = process.env.PAYMENTS_DATABASE_URL;
const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY;
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || '600000');
const USDC_CONTRACT_ADDRESS = process.env.USDC_CONTRACT_ADDRESS || '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const ETHERSCAN_API_URL = process.env.ETHERSCAN_API_URL || 'https://api.etherscan.io/v2/api';
const BASE_CHAIN_ID = process.env.BASE_CHAIN_ID || '8453';
const MAX_RETRIES = parseInt(process.env.MAX_RETRIES || '3');
const RETRY_DELAY_MS = parseInt(process.env.RETRY_DELAY_MS || '5000');
const BLOCK_SAFETY_BUFFER = parseInt(process.env.BLOCK_SAFETY_BUFFER || '10'); // Process blocks at least 10 blocks old
const CONSERVATIVE_BLOCK_ADVANCE = parseInt(process.env.CONSERVATIVE_BLOCK_ADVANCE || '100'); // Max blocks to advance when no transactions found

async function findGridBetaHyprNamehash(indexerDb) {
    const hyprResult = await indexerDb.query(`
        SELECT namehash FROM entries 
        WHERE label = 'hypr' 
        AND parent_hash = '0x0000000000000000000000000000000000000000000000000000000000000000'
    `);
    
    if (hyprResult.rows.length === 0) {
        throw new Error('hypr namespace not found');
    }
    
    const hyprHash = hyprResult.rows[0].namehash;
    
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

async function fetchProviderEntries(indexerDb, gridBetaHyprHash) {
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

async function buildTbaLookup(indexerDb) {
    const result = await indexerDb.query(`
        SELECT tba, full_name, namehash 
        FROM entries 
        WHERE tba IS NOT NULL
    `);
    
    const tbaMap = new Map();
    for (const row of result.rows) {
        tbaMap.set(row.tba.toLowerCase(), {
            fullName: row.full_name,
            namehash: row.namehash
        });
    }
    
    return tbaMap;
}

async function getCurrentBlockHeight() {
    const url = new URL(ETHERSCAN_API_URL);
    url.searchParams.append('module', 'proxy');
    url.searchParams.append('action', 'eth_blockNumber');
    url.searchParams.append('chainid', BASE_CHAIN_ID);
    url.searchParams.append('apikey', ETHERSCAN_API_KEY);
    
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            const response = await fetch(url.toString());
            const data = await response.json();
            
            if (data.result) {
                return parseInt(data.result, 16); // Convert from hex to decimal
            }
            
            throw new Error(data.message || 'Failed to get block height');
        } catch (error) {
            if (attempt === MAX_RETRIES) throw error;
            await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
        }
    }
}

async function fetchUsdcTransactions(walletAddress, fromBlock = 0, endBlock = 999999999) {
    const url = new URL(ETHERSCAN_API_URL);
    url.searchParams.append('module', 'account');
    url.searchParams.append('action', 'tokentx');
    url.searchParams.append('chainid', BASE_CHAIN_ID);
    url.searchParams.append('address', walletAddress);
    url.searchParams.append('contractaddress', USDC_CONTRACT_ADDRESS);
    url.searchParams.append('startblock', fromBlock.toString());
    url.searchParams.append('endblock', endBlock.toString());
    url.searchParams.append('sort', 'asc');
    url.searchParams.append('apikey', ETHERSCAN_API_KEY);
    
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            const response = await fetch(url.toString());
            const data = await response.json();
            
            if (data.status === '1') {
                return data.result.filter(tx => 
                    tx.to.toLowerCase() === walletAddress.toLowerCase()
                );
            }
            
            if (data.status === '0' && (data.message === 'No transactions found' || data.result === 'No transactions found')) {
                return [];
            }
            
            throw new Error(data.message || data.result || 'API request failed');
        } catch (error) {
            if (attempt === MAX_RETRIES) throw error;
            await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
        }
    }
}

async function getProviderCurrentStats(paymentsDb, provider) {
    const result = await paymentsDb.query(`
        SELECT 
            last_processed_block,
            total_usdc_received,
            transaction_count,
            unique_sender_count,
            first_transaction_at,
            last_transaction_at,
            last_transaction_block,
            processing_checkpoint,
            state_validation_hash
        FROM provider_leaderboard
        WHERE provider_entry_namehash = $1
    `, [provider.namehash]);
    
    if (result.rows.length > 0) {
        const stats = result.rows[0];
        // Ensure all numeric fields are properly parsed as integers
        return {
            last_processed_block: parseInt(stats.last_processed_block) || 0,
            total_usdc_received: parseFloat(stats.total_usdc_received) || 0,
            transaction_count: parseInt(stats.transaction_count) || 0,
            unique_sender_count: parseInt(stats.unique_sender_count) || 0,
            first_transaction_at: stats.first_transaction_at,
            last_transaction_at: stats.last_transaction_at,
            last_transaction_block: parseInt(stats.last_transaction_block) || 0,
            processing_checkpoint: parseInt(stats.processing_checkpoint) || 0,
            state_validation_hash: stats.state_validation_hash
        };
    }
    
    return {
        last_processed_block: 0,
        total_usdc_received: 0,
        transaction_count: 0,
        unique_sender_count: 0,
        first_transaction_at: null,
        last_transaction_at: null,
        last_transaction_block: 0,
        processing_checkpoint: 0,
        state_validation_hash: null
    };
}

async function validateAndFixBlockNumber(blockNumber, currentHeight, providerName) {
    const block = parseInt(blockNumber) || 0;
    
    // Check for corruption patterns
    if (block > currentHeight + 1000) {
        console.warn(`CORRUPTION DETECTED: Provider ${providerName} has block ${block} but current height is ${currentHeight}`);
        
        // Try to fix by removing last digit if it looks like string concatenation
        if (block > 100000000) {
            const fixed = Math.floor(block / 10);
            console.log(`Attempting to fix: ${block} -> ${fixed}`);
            return fixed;
        }
        
        // Otherwise cap at current height
        return currentHeight;
    }
    
    return block;
}

async function logBlockChange(paymentsDb, provider, oldBlock, newBlock, changeType) {
    try {
        await paymentsDb.query(`
            INSERT INTO block_processing_log 
            (provider_entry_namehash, provider_entry_name, old_block_number, new_block_number, change_type)
            VALUES ($1, $2, $3, $4, $5)
        `, [provider.namehash, provider.full_name, oldBlock, newBlock, changeType]);
    } catch (error) {
        console.error('Failed to log block change:', error);
    }
}

async function processProviderTransactions(provider, tbaLookup, paymentsDb, safeBlockHeight) {
    const currentStats = await getProviderCurrentStats(paymentsDb, provider);
    
    // Validate and potentially fix the last processed block
    const validatedLastBlock = await validateAndFixBlockNumber(
        currentStats.last_processed_block, 
        safeBlockHeight, 
        provider.full_name
    );
    
    // If we had to fix corruption, update the database
    if (validatedLastBlock !== currentStats.last_processed_block) {
        console.log(`Fixing corrupted block for ${provider.full_name}: ${currentStats.last_processed_block} -> ${validatedLastBlock}`);
        await updateLastProcessedBlock(paymentsDb, provider, validatedLastBlock);
        await logBlockChange(paymentsDb, provider, currentStats.last_processed_block, validatedLastBlock, 'corruption_fix');
        currentStats.last_processed_block = validatedLastBlock;
    }
    
    const fromBlock = parseInt(currentStats.last_processed_block) + 1;
    
    // Don't process beyond the safe block height
    if (fromBlock > safeBlockHeight) {
        console.log(`Provider ${provider.full_name} is at block ${currentStats.last_processed_block}, waiting for safe height ${safeBlockHeight}`);
        return { 
            validTransactions: [], 
            lastProcessedBlock: currentStats.last_processed_block,
            reachedSafeHeight: false 
        };
    }
    
    const transactions = await fetchUsdcTransactions(
        provider.wallet_address, 
        fromBlock,
        safeBlockHeight
    );
    
    const validTransactions = [];
    let maxBlockSeen = fromBlock - 1; // Start with the last processed block
    
    // Sort transactions by block number to ensure proper ordering
    const sortedTransactions = transactions.sort((a, b) => 
        parseInt(a.blockNumber) - parseInt(b.blockNumber)
    );
    
    for (const tx of sortedTransactions) {
        const blockNumber = parseInt(tx.blockNumber);
        
        // Skip transactions beyond our safe height
        if (blockNumber > safeBlockHeight) {
            continue;
        }
        
        // Validate we're not going backwards in blocks
        if (blockNumber < fromBlock) {
            console.warn(`Transaction ${tx.hash} has block ${blockNumber} which is before our fromBlock ${fromBlock}, skipping`);
            continue;
        }
        
        maxBlockSeen = Math.max(maxBlockSeen, blockNumber);
        
        const fromAddress = tx.from.toLowerCase();
        const tbaInfo = tbaLookup.get(fromAddress);
        
        if (tbaInfo) {
            validTransactions.push({
                txHash: tx.hash,
                blockNumber: blockNumber,
                timestamp: new Date(parseInt(tx.timeStamp) * 1000),
                fromAddress: tx.from,
                fromHypermapName: tbaInfo.fullName,
                toAddress: tx.to,
                toProviderId: provider.provider_id,
                valueUsdc: parseFloat(tx.value) / 1e6,
                gasUsed: parseInt(tx.gasUsed)
            });
        }
    }
    
    // Determine how far to advance the block pointer
    let lastProcessedBlock;
    if (transactions.length === 0) {
        // No transactions found. To be safe, only advance by a conservative amount
        // This prevents missing transactions that might not be indexed yet
        const conservativeAdvance = Math.min(
            fromBlock + CONSERVATIVE_BLOCK_ADVANCE, // Advance conservatively when no txs found
            safeBlockHeight
        );
        lastProcessedBlock = conservativeAdvance;
        console.log(`No transactions found for ${provider.full_name} from block ${fromBlock}, conservatively advancing to ${lastProcessedBlock}`);
        await logBlockChange(paymentsDb, provider, currentStats.last_processed_block, lastProcessedBlock, 'conservative_advance');
    } else {
        // We found some transactions, only advance to the highest block we've seen
        lastProcessedBlock = Math.min(maxBlockSeen, safeBlockHeight);
        console.log(`Found ${validTransactions.length} valid transactions for ${provider.full_name}, advancing to block ${lastProcessedBlock}`);
        await logBlockChange(paymentsDb, provider, currentStats.last_processed_block, lastProcessedBlock, 'normal_advance');
    }
    
    const reachedSafeHeight = lastProcessedBlock >= safeBlockHeight;
    
    return { validTransactions, lastProcessedBlock, reachedSafeHeight };
}

async function updatePaymentRecords(paymentsDb, provider, validTransactions) {
    const client = await paymentsDb.connect();
    
    try {
        await client.query('BEGIN');
        
        for (const tx of validTransactions) {
            await client.query(`
                INSERT INTO hypermap_transactions (
                    tx_hash, block_number, timestamp, from_address,
                    from_hypermap_name, to_address, to_provider_id,
                    provider_entry_name, value_usdc, gas_used
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                ON CONFLICT (tx_hash) DO NOTHING
            `, [
                tx.txHash, tx.blockNumber, tx.timestamp, tx.fromAddress,
                tx.fromHypermapName, tx.toAddress, tx.toProviderId,
                provider.full_name, tx.valueUsdc, tx.gasUsed
            ]);
        }
        
        await client.query('COMMIT');
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

async function updateLastProcessedBlock(paymentsDb, provider, lastProcessedBlock) {
    // Ensure block number is an integer
    const safeBlockNumber = parseInt(lastProcessedBlock) || 0;
    
    // Double-check for sanity
    if (safeBlockNumber > 100000000) {
        throw new Error(`Refusing to set unreasonable block number: ${safeBlockNumber}`);
    }
    
    const stateHash = require('crypto').createHash('md5')
        .update(`${safeBlockNumber}|${provider.namehash}`)
        .digest('hex');
    
    await paymentsDb.query(`
        INSERT INTO provider_leaderboard (
            provider_entry_namehash, provider_entry_name, provider_id,
            wallet_address, total_usdc_received, transaction_count,
            unique_sender_count, last_processed_block, processing_checkpoint,
            state_validation_hash
        ) VALUES ($1, $2, $3, $4, 0, 0, 0, $5, $5, $6)
        ON CONFLICT (provider_entry_namehash) DO UPDATE SET
            last_processed_block = EXCLUDED.last_processed_block,
            processing_checkpoint = GREATEST(
                provider_leaderboard.processing_checkpoint, 
                EXCLUDED.last_processed_block - 1000
            ),
            state_validation_hash = EXCLUDED.state_validation_hash,
            updated_at = NOW()
    `, [
        provider.namehash, provider.full_name, provider.provider_id,
        provider.wallet_address, safeBlockNumber, stateHash
    ]);
}

async function updateLeaderboardStatsIncremental(paymentsDb, provider, newTransactions, lastProcessedBlock) {
    const client = await paymentsDb.connect();
    
    try {
        await client.query('BEGIN');
        
        const currentStats = await getProviderCurrentStats(paymentsDb, provider);
        
        const newTotalUsdc = newTransactions.reduce((sum, tx) => sum + tx.valueUsdc, 0);
        const newTxCount = newTransactions.length;
        
        const uniqueNewSenders = [...new Set(newTransactions.map(tx => tx.fromAddress.toLowerCase()))];
        
        let newUniqueSenderCount = currentStats.unique_sender_count;
        if (uniqueNewSenders.length > 0) {
            const existingSendersResult = await client.query(`
                SELECT COUNT(DISTINCT from_address) as existing_count
                FROM hypermap_transactions
                WHERE to_address = $1
                AND from_address = ANY($2)
                AND block_number < $3
            `, [provider.wallet_address, uniqueNewSenders, newTransactions[0].blockNumber]);
            
            const existingCount = parseInt(existingSendersResult.rows[0].existing_count) || 0;
            const actuallyNewSenders = uniqueNewSenders.length - existingCount;
            newUniqueSenderCount = currentStats.unique_sender_count + actuallyNewSenders;
        }
        
        const firstTx = currentStats.first_transaction_at || newTransactions[0]?.timestamp;
        const lastTx = newTransactions[newTransactions.length - 1]?.timestamp || currentStats.last_transaction_at;
        
        await client.query(`
            INSERT INTO provider_leaderboard (
                provider_entry_namehash, provider_entry_name, provider_id,
                wallet_address, total_usdc_received, transaction_count,
                unique_sender_count, first_transaction_at, last_transaction_at,
                last_processed_block, last_transaction_block, state_validation_hash
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
            ON CONFLICT (provider_entry_namehash) DO UPDATE SET
                total_usdc_received = provider_leaderboard.total_usdc_received + EXCLUDED.total_usdc_received,
                transaction_count = provider_leaderboard.transaction_count + EXCLUDED.transaction_count,
                unique_sender_count = $7,
                first_transaction_at = COALESCE(provider_leaderboard.first_transaction_at, EXCLUDED.first_transaction_at),
                last_transaction_at = GREATEST(provider_leaderboard.last_transaction_at, EXCLUDED.last_transaction_at),
                last_processed_block = EXCLUDED.last_processed_block,
                last_transaction_block = EXCLUDED.last_transaction_block,
                processing_checkpoint = GREATEST(
                    provider_leaderboard.processing_checkpoint,
                    EXCLUDED.last_processed_block - 1000
                ),
                state_validation_hash = EXCLUDED.state_validation_hash,
                updated_at = NOW()
        `, [
            provider.namehash, provider.full_name, provider.provider_id,
            provider.wallet_address, newTotalUsdc, newTxCount,
            newUniqueSenderCount, firstTx, lastTx, 
            parseInt(lastProcessedBlock) || 0,  // Ensure integer
            parseInt(lastProcessedBlock) || 0,  // last_transaction_block
            crypto.createHash('md5')
                .update(`${lastProcessedBlock}|${newTotalUsdc}|${currentStats.transaction_count + newTxCount}`)
                .digest('hex')
        ]);
        
        await client.query('COMMIT');
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

async function runPaymentTracker() {
    const indexerDb = new Pool({ connectionString: INDEXER_DATABASE_URL });
    const paymentsDb = new Pool({ connectionString: PAYMENTS_DATABASE_URL });
    
    try {
        await paymentsDb.query(`
            UPDATE tracker_state 
            SET last_run_at = NOW(), total_runs = total_runs + 1
            WHERE id = 1
        `);
        
        const gridBetaHyprHash = await findGridBetaHyprNamehash(indexerDb);
        console.log(`Found grid-beta.hypr namespace: ${gridBetaHyprHash}`);
        
        const providers = await fetchProviderEntries(indexerDb, gridBetaHyprHash);
        console.log(`Found ${providers.length} providers under grid-beta.hypr`);
        
        const tbaLookup = await buildTbaLookup(indexerDb);
        console.log(`Loaded ${tbaLookup.size} TBA addresses`);
        
        // Get current block height and calculate safe block height
        const currentBlockHeight = await getCurrentBlockHeight();
        const safeBlockHeight = currentBlockHeight - BLOCK_SAFETY_BUFFER;
        console.log(`\n=== Payment Tracker Run Started ===`);
        console.log(`Current blockchain height: ${currentBlockHeight}`);
        console.log(`Safe processing height: ${safeBlockHeight} (${BLOCK_SAFETY_BUFFER} blocks behind)`);
        console.log(`Time: ${new Date().toISOString()}`);
        
        for (const provider of providers) {
            try {
                console.log(`\nProcessing provider: ${provider.full_name}`);
                console.log(`  Wallet: ${provider.wallet_address}`);
                console.log(`  Current block: ${currentStats.last_processed_block}`);
                
                const { validTransactions, lastProcessedBlock, reachedSafeHeight } = await processProviderTransactions(
                    provider, 
                    tbaLookup, 
                    paymentsDb,
                    safeBlockHeight
                );
                
                if (validTransactions.length > 0) {
                    await updatePaymentRecords(paymentsDb, provider, validTransactions);
                    await updateLeaderboardStatsIncremental(paymentsDb, provider, validTransactions, lastProcessedBlock);
                    console.log(`✓ Processed ${validTransactions.length} transactions for ${provider.full_name}`);
                    console.log(`  Advanced from block ${currentStats.last_processed_block} to ${lastProcessedBlock}`);
                } else if (reachedSafeHeight) {
                    // Only update the block if we've actually scanned up to the safe height
                    await updateLastProcessedBlock(paymentsDb, provider, lastProcessedBlock);
                    console.log(`✓ No new transactions for ${provider.full_name}`);
                    console.log(`  Advanced from block ${currentStats.last_processed_block} to ${lastProcessedBlock}`);
                } else {
                    console.log(`✓ ${provider.full_name} is already up to date at block ${lastProcessedBlock}`);
                }
                
                await new Promise(resolve => setTimeout(resolve, 1000));
                
            } catch (error) {
                console.error(`Error processing provider ${provider.full_name}:`, error);
                // Log the error for tracking
                await paymentsDb.query(`
                    UPDATE tracker_state 
                    SET last_error = $1
                    WHERE id = 1
                `, [`Provider ${provider.full_name}: ${error.message}`]);
            }
        }
        
        await paymentsDb.query(`
            UPDATE tracker_state 
            SET last_successful_run_at = NOW(), 
                successful_runs = successful_runs + 1,
                last_error = NULL
            WHERE id = 1
        `);
        
        console.log(`\n=== Payment Tracker Run Completed ===`);
        console.log(`Time: ${new Date().toISOString()}`);
        console.log('Status: SUCCESS');
        
    } catch (error) {
        console.error('\n=== Payment Tracker Error ===');
        console.error('Time:', new Date().toISOString());
        console.error('Error:', error);
        
        await paymentsDb.query(`
            UPDATE tracker_state 
            SET failed_runs = failed_runs + 1,
                last_error = $1
            WHERE id = 1
        `, [error.message]);
        
        throw error;
    } finally {
        await indexerDb.end();
        await paymentsDb.end();
    }
}

if (process.argv.includes('--test')) {
    console.log('Running payment tracker in test mode...');
    runPaymentTracker()
        .then(() => console.log('Test run completed'))
        .catch(error => {
            console.error('Test run failed:', error);
            process.exit(1);
        });
} else if (process.argv.includes('--daemon')) {
    console.log('Starting payment tracker daemon...');
    console.log(`Will run every ${POLL_INTERVAL_MS / 1000 / 60} minutes`);
    
    runPaymentTracker().catch(console.error);
    
    setInterval(() => {
        runPaymentTracker().catch(console.error);
    }, POLL_INTERVAL_MS);
} else {
    runPaymentTracker()
        .then(() => process.exit(0))
        .catch(error => {
            console.error(error);
            process.exit(1);
        });
}