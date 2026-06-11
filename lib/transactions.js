var bitcoin = require('bitcoinjs-lib');
var base58 = require('base58-native');
var crypto = require('crypto');
var util = require('./util.js');

var TH3_PUBKEY_PREFIX = Buffer.from([0xc2, 0x6a, 0xe5]);
var TH3_SCRIPT_PREFIX = Buffer.from([0xc2, 0x77, 0xd8]);

function sha256(buffer) {
    return crypto.createHash('sha256').update(buffer).digest();
}

function decodeBase58Check(address) {
    var decoded = Buffer.from(base58.decode(address));
    var payload = decoded.slice(0, -4);
    var checksum = decoded.slice(-4);
    var expected = sha256(sha256(payload)).slice(0, 4);

    if (!checksum.equals(expected)) {
        throw new Error('Invalid Base58Check checksum for address ' + address);
    }

    return payload;
}

function addressHash160(address) {
    var payload = decodeBase58Check(address);

    if (payload.slice(0, TH3_PUBKEY_PREFIX.length).equals(TH3_PUBKEY_PREFIX)) {
        return payload.slice(TH3_PUBKEY_PREFIX.length);
    }

    if (payload.slice(0, TH3_SCRIPT_PREFIX.length).equals(TH3_SCRIPT_PREFIX)) {
        return payload.slice(TH3_SCRIPT_PREFIX.length);
    }

    if (payload.length === 21) {
        return payload.slice(1);
    }

    throw new Error('Unsupported address prefix for ' + address);
}

// public members
var txHash;

exports.txHash = function(){
  return txHash;
};

function scriptCompile(addrHash){
    script = bitcoin.script.compile(
        [
            bitcoin.opcodes.OP_DUP,
            bitcoin.opcodes.OP_HASH160,
            addrHash,
            bitcoin.opcodes.OP_EQUALVERIFY,
            bitcoin.opcodes.OP_CHECKSIG
        ]);
    return script;
}

function scriptFoundersCompile(address){
    script = bitcoin.script.compile(
        [
            bitcoin.opcodes.OP_HASH160,
            address,
            bitcoin.opcodes.OP_EQUAL
        ]);
    return script;
}


exports.createGeneration = function(rpcData, blockReward, feeReward, recipients, poolAddress){
    var _this = this;
    var blockPollingIntervalId;

    var emitLog = function (text) {
        _this.emit('log', 'debug', text);
    };
    var emitWarningLog = function (text) {
        _this.emit('log', 'warning', text);
    };
    var emitErrorLog = function (text) {
        _this.emit('log', 'error', text);
    };
    var emitSpecialLog = function (text) {
        _this.emit('log', 'special', text);
    };

    var poolAddrHash = addressHash160(poolAddress);

    var tx = new bitcoin.Transaction();
    var blockHeight = rpcData.height;
    // input for coinbase tx
    if (blockHeight.toString(16).length % 2 === 0) {
        var blockHeightSerial = blockHeight.toString(16);
    } else {
        var blockHeightSerial = '0' + blockHeight.toString(16);
    }
    var height = Math.ceil((blockHeight << 1).toString(2).length / 8);
    var lengthDiff = blockHeightSerial.length/2 - height;
    for (var i = 0; i < lengthDiff; i++) {
        blockHeightSerial = blockHeightSerial + '00';
    }
    length = '0' + height;
    
    function encodeHeight(height) {
    if (!Number.isSafeInteger(height) || height < 0) {
        throw new Error("Invalid block height");
    }

    if (height === 0) {
        return Buffer.from([0x00, 0x00]);
    }

    if (height >= 1 && height <= 16) {
        return Buffer.from([0x50 + height, 0x01, 0x00]);
    }

    var bytes = [];
    var n = height;

    while (n > 0) {
        bytes.push(n & 0xff);
        n = Math.floor(n / 256);
    }

    if (bytes[bytes.length - 1] & 0x80) {
        bytes.push(0x00);
    }

    return Buffer.concat([
        Buffer.from([bytes.length]),
        Buffer.from(bytes),
        Buffer.from([0x00])
    ]);
}

let serializedBlockHeight = encodeHeight(blockHeight);

console.log("BLOCK HEIGHT =", blockHeight);
console.log("SERIALIZED HEIGHT =", serializedBlockHeight.toString('hex'));

    tx.addInput(new Buffer('0000000000000000000000000000000000000000000000000000000000000000', 'hex'),
        0xFFFFFFFF,
        0xFFFFFFFF,
        new Buffer.concat([serializedBlockHeight,
            Buffer('6b6177706f77', 'hex')])
    );

    console.log("COINBASE SCRIPTSIG =", tx.ins[0].script.toString('hex'));

    // calculate total fees
    var feePercent = 0;
    for (var i = 0; i < recipients.length; i++) {
        feePercent = feePercent + recipients[i].percent;
    }

    tx.addOutput(
        scriptCompile(poolAddrHash),
        Math.floor(blockReward * (1 - (feePercent / 100)))
    );


    for (var i = 0; i < recipients.length; i++) {
       tx.addOutput(
           scriptCompile(addressHash160(recipients[i].address)),
           Math.round((blockReward) * (recipients[i].percent / 100))
       );
    }


    if (rpcData.default_witness_commitment !== undefined) {
        tx.addOutput(new Buffer(rpcData.default_witness_commitment, 'hex'), 0);
    }

    txHex = tx.toHex();

    // this txHash is used elsewhere. Don't remove it.
    txHash = tx.getHash().toString('hex');

    return txHex;
};

module.exports.getFees = function(feeArray){
    var fee = Number();
    feeArray.forEach(function(value) {
        fee = fee + Number(value.fee);
    });
    return fee;
};
