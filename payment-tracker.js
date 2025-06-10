import pg from 'pg';
import fetch from 'node-fetch';
import { config } from 'dotenv';

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

async function fetchUsdcTransactions(walletAddress, fromBlock = 0) {
    const url = new URL(ETHERSCAN_API_URL);
    url.searchParams.append('module', 'account');
    url.searchParams.append('action', 'tokentx');
    url.searchParams.append('chainid', BASE_CHAIN_ID);
    url.searchParams.append('address', walletAddress);
    url.searchParams.append('contractaddress', USDC_CONTRACT_ADDRESS);
    url.searchParams.append('startblock', fromBlock);
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
            
            if (data.status === '0' && data.result === 'No transactions found') {
                return [];
            }
            
            throw new Error(data.message || 'API request failed');
        } catch (error) {
            if (attempt === MAX_RETRIES) throw error;
            await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
        }
    }
}

async function processProviderTransactions(provider, tbaLookup, paymentsDb) {
    const lastBlockResult = await paymentsDb.query(`
        SELECT MAX(block_number) as last_block 
        FROM hypermap_transactions 
        WHERE to_address = $1
    `, [provider.wallet_address]);
    
    const fromBlock = lastBlockResult.rows[0].last_block 
        ? lastBlockResult.rows[0].last_block + 1 
        : 0;
    
    const transactions = await fetchUsdcTransactions(
        provider.wallet_address, 
        fromBlock
    );
    
    const validTransactions = [];
    for (const tx of transactions) {
        const fromAddress = tx.from.toLowerCase();
        const tbaInfo = tbaLookup.get(fromAddress);
        
        if (tbaInfo) {
            validTransactions.push({
                txHash: tx.hash,
                blockNumber: parseInt(tx.blockNumber),
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
    
    return validTransactions;
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
                    value_usdc, gas_used
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                ON CONFLICT (tx_hash) DO NOTHING
            `, [
                tx.txHash, tx.blockNumber, tx.timestamp, tx.fromAddress,
                tx.fromHypermapName, tx.toAddress, tx.toProviderId,
                tx.valueUsdc, tx.gasUsed
            ]);
        }
        
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
        
        for (const provider of providers) {
            try {
                console.log(`Processing provider ${provider.provider_id} (${provider.full_name})...`);
                
                const validTransactions = await processProviderTransactions(
                    provider, 
                    tbaLookup, 
                    paymentsDb
                );
                
                if (validTransactions.length > 0) {
                    await updatePaymentRecords(paymentsDb, provider, validTransactions);
                    console.log(`Processed ${validTransactions.length} transactions for ${provider.provider_id}`);
                } else {
                    console.log(`No new transactions for ${provider.provider_id}`);
                }
                
                await new Promise(resolve => setTimeout(resolve, 1000));
                
            } catch (error) {
                console.error(`Error processing provider ${provider.provider_id}:`, error);
            }
        }
        
        await paymentsDb.query(`
            UPDATE tracker_state 
            SET last_successful_run_at = NOW(), 
                successful_runs = successful_runs + 1,
                last_error = NULL
            WHERE id = 1
        `);
        
        console.log('Payment tracker run completed successfully');
        
    } catch (error) {
        console.error('Payment tracker error:', error);
        
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
