'use strict'; // eslint-disable-line strict
/* eslint-disable max-len */
/* eslint-disable prefer-arrow-callback */ // Mocha recommends not using => func
/* eslint-disable func-names */

const mocha = require('mocha');
const stream = require('stream');
const crypto = require('crypto');

const ecstream = require('../index');
const { checkOutStream, streamMe } = require('./utils');


function bufferEncodedObject(data, k, m, stripeSize) {
    const input = streamMe(data);
    const dataStreams = [...Array(k).keys()].map(
        () => new stream.PassThrough());
    const parityStreams = [...Array(m).keys()].map(
        () => new stream.PassThrough());

    ecstream.encode(
        input, data.length,
        dataStreams, parityStreams, stripeSize);

    const promises = [...dataStreams, ...parityStreams].map(
        stream => new Promise(resolve => {
            const buffers = [];
            stream.on('data', chunk => buffers.push(chunk));
            stream.on('end', () => resolve(Buffer.concat(buffers)));
        }));

    return Promise.all(promises);
}


mocha.describe('Repair test suite', function () {
    /** Check for decode(encode(s)) === s
     * Largest supported code by underlying lib: (k, m) = (24, 6) */
    const codes = [[2, 1], [4, 2], [9, 3], [5, 6], [24, 6]];
    const stripeSizes = [8192, 8192 * 4, 1024 * 1024];

    const randomBuffer = crypto.randomBytes(8 * 1024 * 1024 + 23);

    codes.forEach(code => {
        const [k, m] = code;
        stripeSizes.forEach(stripeSize => {
            const descr = `RS(${k}, ${m}), stripeSize=${stripeSize}`;

            mocha.it(descr, function (done) {
                // Input, encode & bufferize - step 1
                bufferEncodedObject(randomBuffer, k, m, stripeSize).then(encodedBuffers => {
                    // Repair - step 2
                    // Randomly loose m parts
                    const repairIstreams = encodedBuffers.map(b => streamMe(b));
                    const repairOstreams = Array(k + m);
                    for (let c = 0; c < m; ++c) {
                        const die = Math.floor(Math.random() * (k + m));
                        repairIstreams[die] = null;
                        repairOstreams[die] = new stream.PassThrough();
                    }

                    ecstream.repair(
                        k, m, repairIstreams, repairOstreams,
                        randomBuffer.length, stripeSize);

                    // Decode and check - step 3
                    // Reuse repaired parts
                    const decodeDataStreams = Array(k);
                    const decodeParityStreams = Array(m);
                    let left = k;
                    repairOstreams.forEach((ostream, idx) => {
                        if (ostream) {
                            if (idx < k) {
                                decodeDataStreams[idx] = ostream;
                            } else {
                                decodeParityStreams[idx - k] = ostream;
                            }
                            --left;
                        }
                    });
                    // And complete randomly
                    while (left > 0) {
                        const forward = Math.floor(Math.random() * (k + m));
                        if (forward < k && !decodeDataStreams[forward]) {
                            decodeDataStreams[forward] = streamMe(encodedBuffers[forward]);
                            --left;
                        } else if (k <= forward && !decodeParityStreams[forward - k]) {
                            decodeParityStreams[forward - k] = streamMe(encodedBuffers[forward]);
                            --left;
                        }
                    }

                    const output = new stream.PassThrough();
                    checkOutStream(output, 0, randomBuffer,
                                   err => done(err));
                    ecstream.decode(
                        output,
                        randomBuffer.length,
                        decodeDataStreams,
                        decodeParityStreams,
                        stripeSize);
                });
            });
        });
    });
});
