var fs = require('fs');
var path = require('path');
var http = require('http');
var { execSync } = require('child_process');

var myCoin = {
  name: 'TH3Chain',
  symbol: 'TH3',
  algorithm: 'kawpow',
  peerMagic: '54483321',
  peerMagicTestnet: '54483321'
};

var Stratum = require('./lib');

var REWARD_PER_BLOCK = 2137;
var MIN_PAYOUT = 500;
var CONFIRMATION_BUFFER = 5;
var POOL_FEE_PERCENT = 1.5;

var RAVEN_CLI = '/home/ubuntu/TH3Coin/src/raven-cli';

var SHARES_FILE = path.join(__dirname, 'shares.jsonl');
var STATE_FILE = path.join(__dirname, 'pool-state.json');
var PAYOUT_HISTORY_FILE = path.join(__dirname, 'payout-history.jsonl');
var STATS_PORT = 8080;

var poolStats = {
  startedAt: new Date().toISOString(),
  validShares: 0,
  invalidShares: 0,
  validBlocks: 0,
  miners: {}
};

function safeJsonFile(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return fallback;
  }
}

function getCurrentHeight() {
  try {
    return Number(
      execSync(RAVEN_CLI + ' getblockcount', { encoding: 'utf8' }).trim()
    );
  } catch (e) {
    return 0;
  }
}

function ensureMiner(address, worker) {
  if (!poolStats.miners[address]) {
    poolStats.miners[address] = {
      address: address,
      workers: {},
      validShares: 0,
      invalidShares: 0,
      validBlocks: 0,
      lastSeen: null
    };
  }

  if (!poolStats.miners[address].workers[worker]) {
    poolStats.miners[address].workers[worker] = {
      name: worker,
      validShares: 0,
      invalidShares: 0,
      validBlocks: 0,
      lastSeen: null
    };
  }

  return poolStats.miners[address];
}

function getMinerStatus(lastSeen) {
  if (!lastSeen) return 'offline';

  var ageSeconds = (Date.now() - new Date(lastSeen).getTime()) / 1000;

  if (ageSeconds <= 300) return 'mining';
  if (ageSeconds <= 1800) return 'recently_active';

  return 'offline';
}

function recordShare(isValidShare, isValidBlock, data) {
  var worker = data.worker || 'unknown';
  var address = worker.split('.')[0] || worker;
  var now = new Date().toISOString();

  var miner = ensureMiner(address, worker);
  var workerStats = miner.workers[worker];

  miner.lastSeen = now;
  workerStats.lastSeen = now;

  if (isValidShare) {
    poolStats.validShares += 1;
    miner.validShares += 1;
    workerStats.validShares += 1;
  } else {
    poolStats.invalidShares += 1;
    miner.invalidShares += 1;
    workerStats.invalidShares += 1;
  }

  if (isValidBlock) {
    poolStats.validBlocks += 1;
    miner.validBlocks += 1;
    workerStats.validBlocks += 1;
  }

  var shareRecord = {
    time: now,
    address: address,
    worker: worker,
    validShare: Boolean(isValidShare),
    validBlock: Boolean(isValidBlock),
    height: data.height,
    difficulty: data.difficulty,
    shareDiff: data.shareDiff,
    blockHash: data.blockHash || null
  };

  fs.appendFileSync(
    SHARES_FILE,
    JSON.stringify(shareRecord) + '\n'
  );
}

function loadJsonLines(file, limit) {
  try {
    if (!fs.existsSync(file)) return [];

    var content = fs.readFileSync(file, 'utf8').trim();

    if (!content) return [];

    var lines = content.split('\n');

    if (limit) {
      lines = lines.slice(-limit);
    }

    return lines
      .map(function(line) {
        try {
          return JSON.parse(line);
        } catch (e) {
          return null;
        }
      })
      .filter(Boolean);
  } catch (e) {
    return [];
  }
}

function loadRecentShares(limit) {
  return loadJsonLines(SHARES_FILE, limit).reverse();
}

function loadPayoutHistory(limit) {
  return loadJsonLines(PAYOUT_HISTORY_FILE, limit).reverse();
}

function buildStatsFromFile() {
  var shares = loadJsonLines(SHARES_FILE, 10000);
  var miners = {};
  var validShares = 0;
  var invalidShares = 0;
  var validBlocks = 0;

  shares.forEach(function(share) {
    var address = share.address || 'unknown';
    var worker = share.worker || 'unknown';

    if (!miners[address]) {
      miners[address] = {
        address: address,
        workers: {},
        validShares: 0,
        invalidShares: 0,
        validBlocks: 0,
        lastSeen: null
      };
    }

    if (!miners[address].workers[worker]) {
      miners[address].workers[worker] = {
        name: worker,
        validShares: 0,
        invalidShares: 0,
        validBlocks: 0,
        lastSeen: null
      };
    }

    if (share.validShare) {
      validShares += 1;
      miners[address].validShares += 1;
      miners[address].workers[worker].validShares += 1;
    } else {
      invalidShares += 1;
      miners[address].invalidShares += 1;
      miners[address].workers[worker].invalidShares += 1;
    }

    if (share.validBlock) {
      validBlocks += 1;
      miners[address].validBlocks += 1;
      miners[address].workers[worker].validBlocks += 1;
    }

    miners[address].lastSeen = share.time;
    miners[address].workers[worker].lastSeen = share.time;
  });

  Object.values(miners).forEach(function(miner) {
    miner.status = getMinerStatus(miner.lastSeen);

    Object.values(miner.workers).forEach(function(worker) {
      worker.status = getMinerStatus(worker.lastSeen);
    });
  });

  return {
    startedAt: poolStats.startedAt,
    validShares: validShares,
    invalidShares: invalidShares,
    validBlocks: validBlocks,
    minerCount: Object.keys(miners).length,
    miners: miners,
    recentShares: loadRecentShares(50)
  };
}

function calculatePendingRewards() {
  var state = safeJsonFile(STATE_FILE, {});
  var paidUntilHeight = state.paid_until_height || 0;
  var currentHeight = getCurrentHeight();
  var maxPayableHeight = Math.max(0, currentHeight - CONFIRMATION_BUFFER);

  var shares = loadJsonLines(SHARES_FILE);
  var miners = {};
  var totalShares = 0;
  var totalBlocks = 0;
  var maxHeight = paidUntilHeight;

  shares.forEach(function(share) {
    if (!share.validShare) return;
    if (!share.height || share.height <= paidUntilHeight) return;
    if (share.height > maxPayableHeight) return;

    var address = share.address || 'unknown';

    if (!miners[address]) {
      miners[address] = {
        address: address,
        shares: 0,
        blocks: 0,
        pending: 0
      };
    }

    miners[address].shares += 1;
    totalShares += 1;

    if (share.validBlock) {
      miners[address].blocks += 1;
      totalBlocks += 1;
    }

    if (share.height > maxHeight) {
      maxHeight = share.height;
    }
  });

  var grossReward = totalBlocks * REWARD_PER_BLOCK;
  var poolFee = grossReward * (POOL_FEE_PERCENT / 100);
  var minerReward = grossReward - poolFee;

  Object.values(miners).forEach(function(miner) {
    var ratio = totalShares > 0 ? miner.shares / totalShares : 0;
    miner.pending = Number((ratio * minerReward).toFixed(8));
    miner.sharePercent = Number((ratio * 100).toFixed(4));
  });

  return {
    paidUntilHeight: paidUntilHeight,
    currentHeight: currentHeight,
    maxPayableHeight: maxPayableHeight,
    maxHeight: maxHeight,
    totalShares: totalShares,
    totalBlocks: totalBlocks,
    grossReward: Number(grossReward.toFixed(8)),
    poolFee: Number(poolFee.toFixed(8)),
    minerReward: Number(minerReward.toFixed(8)),
    miners: miners,
    lastPayoutTxids: state.last_payout_txids || {},
    lastPayoutTime: state.last_payout_time || null
  };
}

function getMinerPayoutHistory(address) {
  return loadPayoutHistory(1000)
    .filter(function(row) {
      return row.address === address;
    })
    .slice(0, 50);
}

function sendJson(res, status, data) {
  var body = JSON.stringify(data);

  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store'
  });

  res.end(body);
}

function startStatsServer() {
  http.createServer(function(req, res) {
    var url = new URL(req.url, 'http://127.0.0.1:' + STATS_PORT);

    if (url.pathname === '/api/pool/stats') {
      var stats = buildStatsFromFile();
      var pending = calculatePendingRewards();

      return sendJson(res, 200, {
        online: true,
        algorithm: 'kawpow',
        stratum: 'stratum+tcp://pool.th3chain.cloud:3333',
        poolFeePercent: POOL_FEE_PERCENT,
        minPayout: MIN_PAYOUT,
        rewardPerBlock: REWARD_PER_BLOCK,
        confirmationBuffer: CONFIRMATION_BUFFER,
        paidUntilHeight: pending.paidUntilHeight,
        maxPayableHeight: pending.maxPayableHeight,
        currentHeight: pending.currentHeight,
        validShares: stats.validShares,
        invalidShares: stats.invalidShares,
        validBlocks: stats.validBlocks,
        minerCount: stats.minerCount,
        pendingGrossReward: pending.grossReward,
        pendingPoolFee: pending.poolFee,
        pendingMinerReward: pending.minerReward,
        lastPayoutTime: pending.lastPayoutTime,
        startedAt: stats.startedAt,
        recentShares: stats.recentShares,
        recentPayouts: loadPayoutHistory(20)
      });
    }

    if (url.pathname === '/api/pool/payouts') {
      return sendJson(res, 200, {
        payouts: loadPayoutHistory(200)
      });
    }

    if (url.pathname.indexOf('/api/miner/') === 0) {
      var address = decodeURIComponent(url.pathname.replace('/api/miner/', ''));
      var stats = buildStatsFromFile();
      var pending = calculatePendingRewards();
      var miner = stats.miners[address];
      var pendingMiner = pending.miners[address];

      if (!miner && !pendingMiner) {
        return sendJson(res, 404, {
          error: 'Miner not found',
          address: address
        });
      }

      miner = miner || {
        address: address,
        workers: {},
        validShares: 0,
        invalidShares: 0,
        validBlocks: 0,
        lastSeen: null,
        status: 'offline'
      };

      pendingMiner = pendingMiner || {
        shares: 0,
        blocks: 0,
        pending: 0,
        sharePercent: 0
      };

      return sendJson(res, 200, {
        address: address,
        status: miner.status,
        validShares: miner.validShares,
        invalidShares: miner.invalidShares,
        validBlocks: miner.validBlocks,
        lastSeen: miner.lastSeen,
        workers: Object.values(miner.workers),
        pendingReward: pendingMiner.pending,
        pendingShares: pendingMiner.shares,
        pendingBlocks: pendingMiner.blocks,
        pendingSharePercent: pendingMiner.sharePercent,
        minPayout: MIN_PAYOUT,
        poolFeePercent: POOL_FEE_PERCENT,
        paidUntilHeight: pending.paidUntilHeight,
        maxPayableHeight: pending.maxPayableHeight,
        lastPayoutTxid: pending.lastPayoutTxids[address] || null,
        lastPayoutTime: pending.lastPayoutTime,
        payouts: getMinerPayoutHistory(address)
      });
    }

    return sendJson(res, 404, {
      error: 'Not found'
    });
  }).listen(STATS_PORT, function() {
    console.log('Pool stats API listening on port ' + STATS_PORT);
  });
}

var pool = Stratum.createPool({

  coin: myCoin,

  address: 'TMayfrrfFTqjNf4esHnXYpFX3MfQ6Qs9BV',

  rewardRecipients: {
    'TMayfrrfFTqjNf4esHnXYpFX3MfQ6Qs9BV': 1.5
  },

  blockRefreshInterval: 1000,
  getNewBlockAfterFound: true,
  jobRebroadcastTimeout: 55,
  connectionTimeout: 1200,
  emitInvalidBlockHashes: false,
  tcpProxyProtocol: false,

  banning: {
    enabled: true,
    time: 600,
    invalidPercent: 50,
    checkThreshold: 500,
    purgeInterval: 300
  },

  ports: {
    '3333': {
      diff: 0.1,
      varDiff: {
        minDiff: 0.0001,
        maxDiff: 512,
        targetTime: 15,
        retargetTime: 90,
        variancePercent: 30
      }
    }
  },

  daemons: [
    {
      host: '127.0.0.1',
      port: 8766,
      user: 'th3rpc',
      password: 'mocnehaslo'
    }
  ],

  p2p: {
    enabled: false,
    host: '127.0.0.1',
    port: 8767,
    disableTransactions: true
  }

}, function(ip, port, workerName, password, extraNonce1, version, callback) {
  console.log(
    'Authorize ' +
    workerName +
    ':' +
    password +
    '@' +
    ip +
    ' extraNonce1:' +
    extraNonce1 +
    ' version' +
    version
  );

  callback({
    error: null,
    authorized: true,
    disconnect: false
  });
});

pool.on('share', function(isValidShare, isValidBlock, data) {
  recordShare(isValidShare, isValidBlock, data);

  if (isValidBlock) {
    console.log('Block found');
  } else if (isValidShare) {
    console.log('Valid share submitted');
  } else if (data.blockHash) {
    console.log('We thought a block was found but it was rejected by the daemon');
  } else {
    console.log('Invalid share submitted');
  }

  console.log('share data: ' + JSON.stringify(data));
});

pool.on('log', function(severity, logKey, logText) {
  console.log(severity + ': ' + '[' + logKey + '] ' + logText);
});

console.log('Starting Pool');
startStatsServer();
pool.start();
console.log('Pool started');