const fs = require('fs');

const REWARD_PER_BLOCK = 2137;
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
            blocks: 0,
            reward: 0
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

console.log('');
console.log('=== TH3 POOL UNPAID STATS ===');
console.log('Paid until height:', paidUntilHeight);
console.log('Current counted max height:', maxHeight);
console.log('');

for (const [addr, data] of Object.entries(miners)) {
    const sharePercent = totalShares > 0
        ? data.shares / totalShares
        : 0;

    const estimatedReward = sharePercent * totalBlocks * REWARD_PER_BLOCK;

    console.log('Address:', addr);
    console.log('Shares :', data.shares);
    console.log('Blocks :', data.blocks);
    console.log('Share% :', (sharePercent * 100).toFixed(2) + '%');
    console.log('Reward :', estimatedReward.toFixed(8) + ' TH3');
    console.log('');
}

console.log('Total Shares:', totalShares);
console.log('Total Blocks:', totalBlocks);
console.log('Estimated Pool Reward:', (totalBlocks * REWARD_PER_BLOCK).toFixed(8), 'TH3');