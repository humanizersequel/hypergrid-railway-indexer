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

async function getCurrentBlockHeight() {
    const url = new URL(ETHERSCAN_API_URL);
    url.searchParams.append('module', 'proxy');
    url.searchParams.append('action', 'eth_blockNumber');
    url.searchParams.append('chainid', BASE_CHAIN_ID);
    url.searchParams.append('apikey', ETHERSCAN_API_KEY);
    
    const response = await fetch(url.toString());
    const data = await response.json();
    return parseInt(data.result, 16);
}

async function fetchUsdcTransactions(address, fromBlock, toBlock) {
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
    
    const response = await fetch(url.toString());
    const data = await response.json();
    
    if (data.status === '1') {
        return data.result;
    } else if (data.message === 'No transactions found') {
        return [];
    }
    throw new Error(data.message || 'API request failed');
}

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

async function runPaymentTracker() {
    const indexerDb = new Pool({ connectionString: INDEXER_DATABASE_URL });
    const paymentsDb = new Pool({ connectionString: PAYMENTS_DATABASE_URL });
    
    try {
        console.log('\n=== Payment Tracker Started ===');
        console.log(`Time: ${new Date().toISOString()}`);
        
        // Get current state
        const stateResult = await paymentsDb.query('SELECT last_processed_block FROM global_state WHERE id = 1');
        const lastProcessedBlock = stateResult.rows[0]?.last_processed_block || 0;
        
        // Get current blockchain height
        const currentHeight = await getCurrentBlockHeight();
        const safeHeight = currentHeight - BLOCK_SAFETY_BUFFER;
        
        console.log(`Last processed block: ${lastProcessedBlock}`);
        console.log(`Current height: ${currentHeight}, safe height: ${safeHeight}`);
        
        if (lastProcessedBlock >= safeHeight) {
            console.log('Already up to date');
            return;
        }
        
        // Find grid-beta.hypr namespace
        const gridBetaHyprHash = await findGridBetaHyprNamehash(indexerDb);
        console.log(`Found grid-beta.hypr: ${gridBetaHyprHash}`);
        
        // Get all providers from grid-beta.hypr in indexer
        const providers = await indexerDb.query(`
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
        `, [gridBetaHyprHash]);
        
        // Get all TBAs for validation
        const tbaResult = await indexerDb.query(`
            SELECT LOWER(tba) as tba, full_name 
            FROM entries 
            WHERE tba IS NOT NULL
        `);
        const tbaMap = new Map(tbaResult.rows.map(r => [r.tba, r.full_name]));
        
        console.log(`Processing ${providers.rows.length} providers, ${tbaMap.size} TBAs loaded`);
        
        // Ensure all providers are in the leaderboard
        for (const provider of providers.rows) {
            await paymentsDb.query(`
                INSERT INTO provider_leaderboard (
                    provider_entry_namehash, provider_entry_name, provider_id,
                    wallet_address, total_usdc_received, transaction_count,
                    unique_sender_count
                ) VALUES ($1, $2, $3, $4, 0, 0, 0)
                ON CONFLICT (provider_entry_namehash) DO NOTHING
            `, [provider.namehash, provider.full_name, provider.provider_id, provider.wallet_address.toLowerCase()]);
        }
        
        // Process each provider
        const fromBlock = lastProcessedBlock + 1;
        const toBlock = safeHeight;
        let totalTransactions = 0;
        
        for (const provider of providers.rows) {
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
                        // Insert transaction
                        await paymentsDb.query(`
                            INSERT INTO hypermap_transactions (
                                tx_hash, block_number, timestamp, from_address,
                                from_hypermap_name, to_address, to_provider_id,
                                provider_entry_name, value_usdc, gas_used
                            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                            ON CONFLICT (tx_hash) DO NOTHING
                        `, [
                            tx.hash,
                            parseInt(tx.blockNumber),
                            new Date(parseInt(tx.timeStamp) * 1000),
                            tx.from.toLowerCase(),
                            senderName,
                            tx.to.toLowerCase(),
                            provider.provider_id,
                            provider.full_name,
                            parseFloat(tx.value) / 1e6,
                            parseInt(tx.gasUsed)
                        ]);
                        validTxs++;
                    }
                }
                
                console.log(`  Found ${incomingTxs.length} incoming, ${validTxs} from TBAs`);
                totalTransactions += validTxs;
                
            } catch (error) {
                console.error(`  Error processing ${provider.full_name}:`, error.message);
            }
            
            // Small delay to avoid rate limits
            await new Promise(resolve => setTimeout(resolve, 200));
        }
        
        // Update global state
        await paymentsDb.query(`
            UPDATE global_state 
            SET last_processed_block = $1, updated_at = NOW() 
            WHERE id = 1
        `, [toBlock]);
        
        // Update leaderboard
        console.log('\nUpdating provider leaderboard...');
        const updateResult = await paymentsDb.query(`
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
        
        console.log(`\nProcessed blocks ${fromBlock} to ${toBlock}`);
        console.log(`Added ${totalTransactions} new transactions`);
        console.log('=== Payment Tracker Completed ===\n');
        
    } catch (error) {
        console.error('Payment tracker error:', error);
        throw error;
    } finally {
        await indexerDb.end();
        await paymentsDb.end();
    }
}

// Run modes
if (process.argv.includes('--daemon')) {
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