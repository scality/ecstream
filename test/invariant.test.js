'use strict'; // eslint-disable-line strict
/* eslint-disable max-len */
/* eslint-disable prefer-arrow-callback */ // Mocha recommends not using => func
/* eslint-disable func-names */

const mocha = require('mocha');
const stream = require('stream');
const crypto = require('crypto');

const ecstream = require('../index');
const { checkOutStream, streamMe } = require('./utils');


mocha.describe('Erasure invariant test suite', function () {
    /** Check for decode(encode(s)) === s
     * Largest supported code by underlying lib: (k, m) = (24, 6) */
    const codes = [[2, 1], [4, 2], [9, 3], [5, 6], [24, 6]];
    const stripeSizes = [8192, 8192 * 4, 1024 * 1024];

    const randomBuffer = crypto.randomBytes(8 * 1024 * 1024 + 23);

    codes.forEach(code => {
        const [k, m] = code;
        stripeSizes.forEach(stripeSize => {
            for (let kill = 0; kill <= m; ++kill) {
                const descr = `RS(${k}, ${m}), stripeSize=${stripeSize}, kill=${kill}`;

                mocha.it(descr, function (done) {
                    const dataStreams = [...Array(k).keys()].map(
                        () => new stream.PassThrough());
                    const parityStreams = [...Array(m).keys()].map(
                        () => new stream.PassThrough());

                    // Input
                    const input = streamMe(randomBuffer);

                    // Output
                    const output = new stream.PassThrough();
                    checkOutStream(output, 0, randomBuffer,
                                   err => done(err));

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

                    // Pipe encoding output to decoder
                    ecstream.encode(
                        input, randomBuffer.length,
                        dataStreams, parityStreams, stripeSize);
                    ecstream.decode(
                        output,
                        randomBuffer.length,
                        filteredDataStreams,
                        filteredParityStreams,
                        stripeSize);
                });
            }
        });
    });
});
