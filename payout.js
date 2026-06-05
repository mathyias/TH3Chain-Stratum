const fs = require('fs');
const { execSync } = require('child_process');

const REWARD_PER_BLOCK = 2137;
const MIN_PAYOUT = 500;
const CONFIRMATION_BUFFER = 5;
const POOL_FEE_PERCENT = 1.5;

const STATE_FILE = 'pool-state.json';
const SHARES_FILE = 'shares.jsonl';
const PAYOUT_HISTORY_FILE = 'payout-history.jsonl';

const RAVEN_CLI = '/home/ubuntu/TH3Coin/src/raven-cli';

const SEND = process.argv.includes('--send');

const currentHeight = Number(
    execSync(`${RAVEN_CLI} getblockcount`, { encoding: 'utf8' }).trim()
);

const maxPayableHeight = Math.max(0, currentHeight - CONFIRMATION_BUFFER);

const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
const paidUntilHeight = state.paid_until_height || 0;

const content = fs.existsSync(SHARES_FILE)
    ? fs.readFileSync(SHARES_FILE, 'utf8').trim()
    : '';

const lines = content ? content.split('\n') : [];

const miners = {};
let totalShares = 0;
let totalBlocks = 0;
let maxHeight = paidUntilHeight;

for (const line of lines) {
    const share = JSON.parse(line);

    if (!share.validShare) continue;
    if (!share.height || share.height <= paidUntilHeight) continue;
    if (share.height > maxPayableHeight) continue;

    const addr = share.address;

    if (!miners[addr]) {
        miners[addr] = {
            shares: 0,
            blocks: 0
        };
    }

    miners[addr].shares++;
    totalShares++;

    if (share.validBlock) {
        miners[addr].blocks++;
        totalBlocks++;
    }

    if (share.height > maxHeight) {
        maxHeight = share.height;
    }
}

const totalReward = totalBlocks * REWARD_PER_BLOCK;
const poolFee = totalReward * (POOL_FEE_PERCENT / 100);
const minerReward = totalReward - poolFee;
const payouts = {};

for (const [addr, data] of Object.entries(miners)) {
    const shareRatio = totalShares > 0 ? data.shares / totalShares : 0;
    const amount = shareRatio * minerReward;

    if (amount >= MIN_PAYOUT) {
        payouts[addr] = Number(amount.toFixed(8));
    }
}

console.log('');
console.log('=== TH3 POOL PAYOUT ===');
console.log('Mode:', SEND ? 'SEND REAL PAYOUT' : 'DRY RUN');
console.log('Paid until height:', paidUntilHeight);
console.log('Current chain height:', currentHeight);
console.log('Max payable height:', maxPayableHeight);
console.log('Max height to mark paid:', maxHeight);
console.log('Total shares:', totalShares);
console.log('Total blocks:', totalBlocks);
console.log('Gross reward:', totalReward.toFixed(8), 'TH3');
console.log('Pool fee:', poolFee.toFixed(8), 'TH3');
console.log('Miner reward:', minerReward.toFixed(8), 'TH3');
console.log('');

console.log('Payouts:');
console.log(JSON.stringify(payouts, null, 2));
console.log('');

if (Object.keys(payouts).length === 0) {
    console.log('Nothing to pay.');
    process.exit(0);
}

if (!SEND) {
    console.log('Dry run only. To send real payout, run:');
    console.log('node payout.js --send');
    process.exit(0);
}

console.log('Sending payout...');

try {
    const txids = {};

    for (const [addr, amount] of Object.entries(payouts)) {
        const command = `${RAVEN_CLI} sendtoaddress ${addr} ${amount}`;

        console.log('Executing:');
        console.log(command);

        const txid = execSync(command, { encoding: 'utf8' }).trim();
        txids[addr] = txid;

        fs.appendFileSync(
            PAYOUT_HISTORY_FILE,
            JSON.stringify({
                time: new Date().toISOString(),
                height: maxHeight,
                address: addr,
                amount,
                txid,
                poolFeePercent: POOL_FEE_PERCENT
            }) + '\n'
        );

        console.log(`Paid ${amount} TH3 to ${addr}`);
        console.log(`TXID: ${txid}`);
    }

    console.log('');
    console.log('Payout sent successfully.');

    const newState = {
        paid_until_height: maxHeight,
        last_payout_txids: txids,
        last_payout_time: new Date().toISOString(),
        pool_fee_percent: POOL_FEE_PERCENT
    };

    fs.writeFileSync(
        STATE_FILE,
        JSON.stringify(newState, null, 2) + '\n'
    );

    console.log('');
    console.log('Updated pool-state.json:');
    console.log(JSON.stringify(newState, null, 2));

} catch (err) {
    console.error('');
    console.error('Payout failed.');
    console.error(err.stdout ? err.stdout.toString() : '');
    console.error(err.stderr ? err.stderr.toString() : '');
    process.exit(1);
}