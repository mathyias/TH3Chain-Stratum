const fs = require('fs');

const REWARD_PER_BLOCK = 2137;
const MIN_PAYOUT = 1;

const STATE_FILE = 'pool-state.json';
const SHARES_FILE = 'shares.jsonl';

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
const payouts = {};

for (const [addr, data] of Object.entries(miners)) {
    const shareRatio = totalShares > 0 ? data.shares / totalShares : 0;
    const amount = shareRatio * totalReward;

    if (amount >= MIN_PAYOUT) {
        payouts[addr] = Number(amount.toFixed(8));
    }
}

console.log('');
console.log('=== TH3 POOL PAYOUT DRY RUN ===');
console.log('Paid until height:', paidUntilHeight);
console.log('Max height to mark paid:', maxHeight);
console.log('Total shares:', totalShares);
console.log('Total blocks:', totalBlocks);
console.log('Total reward:', totalReward.toFixed(8), 'TH3');
console.log('');

console.log('Payouts:');
console.log(JSON.stringify(payouts, null, 2));
console.log('');

console.log('RPC command preview:');
console.log(
    './src/raven-cli sendmany "" ' +
    "'" + JSON.stringify(payouts) + "'"
);
console.log('');

console.log('After successful payout, update pool-state.json to:');
console.log(JSON.stringify({ paid_until_height: maxHeight }, null, 2));
