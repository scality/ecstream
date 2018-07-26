'use strict'; // eslint-disable-line strict
/* eslint-disable max-len */
/* eslint-disable no-console */

const CPUS = require('os').cpus();
process.UV_THREADPOOL_SIZE = CPUS.length;

const stream = require('stream');
const crypto = require('crypto');
const ReedSolomon = require('@ronomon/reed-solomon');

const ecstream = require('./index');
const { streamMe } = require('./test/utils');


/**
 * Benchmark encoding by buffering everything
 * and encoding in one call
 *
 * @param {Buffer} data - Data to encode
 * @param {Number} k - Number of data parts
 * @param {Number} m - Number of parity parts
 * @param {Number} stripeSize - Length S of stripe (total = (k+m) * S)
 * @param {Number} kill - Number of missing parts
 * @return {Promise} Promise to wait on
 */
function oneShotEncoding(data, k, m, stripeSize, kill) {
    const context = ReedSolomon.create(k, m);
    const sources = (1 << k) - 1;
    const targets = ((1 << m) - 1) << k;

    const start = process.hrtime();
    const dataBuffer = Buffer.alloc(k * stripeSize);
    const parityBuffer = Buffer.alloc(m * stripeSize);
    data.copy(dataBuffer);

    return new Promise(resolve => {
        ReedSolomon.encode(
            context,
            sources,
            targets,
            dataBuffer,
            0,
            dataBuffer.length,
            parityBuffer,
            0,
            parityBuffer.length,
            () => {
                const end = process.hrtime(start);
                const [elapsedS, elapsedNs] = end;
                // Twice, to fake encode + decode
                const latencyMs = 2 * ((elapsedS * 1e9) + elapsedNs) * 1e-6;
                const bandwidth = 2 * data.length / (latencyMs * 1e-3) / (1e6);
                console.log(['buffer', k, m, stripeSize, kill, latencyMs, bandwidth].join(','));
                resolve();
            });
    });
}


/**
 * Benchmark encoding by streaming
 *
 * @param {Buffer} data - Data to encode
 * @param {Number} k - Number of data parts
 * @param {Number} m - Number of parity parts
 * @param {Number} stripeSize - Length S of stripe (total = (k+m) * S)
 * @param {Number} kill - Number of missing parts
 * @return {Promise} Promise to wait on
 */
function streamEncoding(data, k, m, stripeSize, kill) {
    const dataStreams = [...Array(k).keys()].map(
        () => new stream.PassThrough());
    const parityStreams = [...Array(m).keys()].map(
        () => new stream.PassThrough());

    // Input
    const input = streamMe(data);

    // Shoot random parts - up to 'kill'
    const filteredDataStreams = [...dataStreams];
    const filteredParityStreams = [...parityStreams];
    for (let c = 0; c < kill; ++c) {
        const die = Math.floor(Math.random() * (k + m));
        if (die < k) {
            filteredDataStreams[die] = null;
        } else {
            filteredParityStreams[die - k] = null;
        }
    }

    // Output
    const output = new stream.PassThrough();
    output.resume(); // Consume output

    return new Promise(resolve => {
        const startStream = process.hrtime();
        output.on('end', () => {
            const [elapsedS, elapsedNs] = process.hrtime(startStream);
            const latencyMs = ((elapsedS * 1e9) + elapsedNs) * 1e-6;
            // Twice buffer length because we encoded + decoded
            // Note that output checking is also comprised in the measurement.
            const bandwidth = 2 * data.length / (latencyMs * 1e-3) / (1e6);
            console.log(['stream', k, m, stripeSize, kill, latencyMs, bandwidth].join(','));
            resolve();
        });

        // Pipe encoding output to decoder
        ecstream.encode(
            input, data.length,
            dataStreams, parityStreams, stripeSize);
        ecstream.decode(
            output,
            data.length,
            filteredDataStreams,
            filteredParityStreams,
            stripeSize);
    });
}

/**
 * Run all benchmarks
 *
 * @param {[[Number]]} codes - Each entry should be [k, m] to test
 * @param {[Number]} stripeSizes - Stripe sizes to test
 * @return {Promise} Promise to wait on, resolved when all becnhmarks are finished
 */
function benchmark(codes, stripeSizes) {
    const randomBuffer = crypto.randomBytes(64 * 1024 * 1024 + 23);

    // Write CSV header
    console.log('type,k,m,stripeSize,kill,latencyMs,bandwidthMBs');

    let promiseChain = Promise.resolve();

    codes.forEach(code => {
        const [k, m] = code;
        stripeSizes.forEach(stripeSize => {
            for (let kill = 0; kill < m; ++kill) {
                // Chain promises, perform 1 bench at a time
                promiseChain = promiseChain.then(
                    () => oneShotEncoding(
                        randomBuffer, k, m, stripeSize, kill));
                promiseChain = promiseChain.then(
                    () => streamEncoding(
                        randomBuffer, k, m, stripeSize, kill));
            }
        });
    });

    return promiseChain;
}


/* If run as a script */
if (typeof require !== 'undefined' && require.main === module) {
    const codes = [[2, 1], [4, 2], [9, 3], [5, 6], [24, 6]];
    const stripeSizes = [8192, 8192 * 4, 1024 * 1024];
    benchmark(codes, stripeSizes);
}
