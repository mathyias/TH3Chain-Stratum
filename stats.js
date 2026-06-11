const fs = require('fs');
const { execSync } = require('child_process');

const REWARD_PER_BLOCK = 2137;
const CONFIRMATION_BUFFER = 5;
const POOL_FEE_PERCENT = 1.5;

const STATE_FILE = 'pool-state.json';
const SHARES_FILE = 'shares.jsonl';

const TH3_CLI = '/home/ubuntu/TH3Coin/src/th3-cli';

const currentHeight = Number(
    execSync(`${TH3_CLI} getblockcount`, { encoding: 'utf8' }).trim()
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

const totalReward = totalBlocks * REWARD_PER_BLOCK;
const poolFee = totalReward * (POOL_FEE_PERCENT / 100);
const minerReward = totalReward - poolFee;

console.log('');
console.log('=== TH3 POOL UNPAID STATS ===');
console.log('Paid until height:', paidUntilHeight);
console.log('Current chain height:', currentHeight);
console.log('Max payable height:', maxPayableHeight);
console.log('Current counted max height:', maxHeight);
console.log('');

for (const [addr, data] of Object.entries(miners)) {
    const sharePercent = totalShares > 0
        ? data.shares / totalShares
        : 0;

    const estimatedReward = sharePercent * minerReward;

    console.log('Address:', addr);
    console.log('Shares :', data.shares);
    console.log('Blocks :', data.blocks);
    console.log('Share% :', (sharePercent * 100).toFixed(2) + '%');
    console.log('Reward :', estimatedReward.toFixed(8) + ' TH3');
    console.log('');
}

console.log('Total Shares:', totalShares);
console.log('Total Blocks:', totalBlocks);
console.log('Estimated Gross Reward:', totalReward.toFixed(8), 'TH3');
console.log('Pool Fee:', poolFee.toFixed(8), 'TH3');
console.log('Estimated Miner Reward:', minerReward.toFixed(8), 'TH3');