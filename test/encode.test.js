'use strict'; // eslint-disable-line strict
/* eslint-disable max-len */
/* eslint-disable prefer-arrow-callback */ // Mocha recommends not using => func
/* eslint-disable func-names */

const assert = require('assert');
const mocha = require('mocha');
const stream = require('stream');

const ecstream = require('../index');
const { checkOutStream, streamMe } = require('./utils');


mocha.describe('Erasure encoding test suite', function () {
    mocha.it('Encode bad stripe size', function (done) {
        try {
            ecstream.encode(null, 0, [], [], 7);
            assert.ok(undefined); // Unreachable
        } catch (error) {
            assert.ok(error instanceof assert.AssertionError);
            done();
        }
    });

    mocha.it('Encode k (# data parts)', function (done) {
        try {
            ecstream.encode(null, 0, [], [], 8);
            assert.ok(undefined); // Unreachable
        } catch (error) {
            assert.ok(error instanceof assert.AssertionError);
            done();
        }
    });

    mocha.it('Encode m (# parity parts)', function (done) {
        try {
            ecstream.encode(null, 0, ['fake', 'fake'], [], 8);
            assert.ok(undefined); // Unreachable
        } catch (error) {
            assert.ok(error instanceof assert.AssertionError);
            done();
        }
    });

    mocha.it('Input smaller than k * stripe size', function (done) {
        const content = Buffer.concat([
            Buffer.alloc(512, 0x1),
            Buffer.alloc(511, 0x2),
        ]);
        const input = streamMe(content);
        let waiting = 3;
        const finalizer = err => {
            --waiting;
            if (err) {
                done(err);
                waiting = 0; // avoid multiple calls to done()
            } else if (waiting === 0) {
                done();
            }
        };

        const data1 = new stream.PassThrough();
        const expectedContent1 = Buffer.alloc(512, 0x1);
        checkOutStream(data1, 0, expectedContent1, finalizer);

        const data2 = new stream.PassThrough();
        const expectedContent2 = Buffer.concat([
            Buffer.alloc(511, 0x2),
            Buffer.alloc(1, 0x0),
        ]);
        checkOutStream(data2, 1, expectedContent2, finalizer);

        const parity = new stream.PassThrough();
        const expectedContentParity = Buffer.concat([
            Buffer.alloc(511, 0x1 ^ 0x2),
            Buffer.alloc(1, 0x1),
        ]);
        checkOutStream(parity, 2, expectedContentParity, finalizer);

        ecstream.encode(
            input, content.length,
            [data1, data2], [parity],
            512);
    });

    mocha.it('Input equal to k * stripe size', function (done) {
        const content = Buffer.concat([
            Buffer.alloc(512, 0x1),
            Buffer.alloc(512, 0x2),
        ]);
        const input = streamMe(content);
        let waiting = 3;
        const finalizer = err => {
            --waiting;
            if (err) {
                done(err);
                waiting = 0; // avoid multiple calls to done()
            } else if (waiting === 0) {
                done();
            }
        };

        const data1 = new stream.PassThrough();
        const expectedContent1 = Buffer.alloc(512, 0x1);
        checkOutStream(data1, 0, expectedContent1, finalizer);

        const data2 = new stream.PassThrough();
        const expectedContent2 = Buffer.alloc(512, 0x2);
        checkOutStream(data2, 1, expectedContent2, finalizer);

        const parity = new stream.PassThrough();
        const expectedContentParity = Buffer.alloc(512, 0x1 ^ 0x2);
        checkOutStream(parity, 2, expectedContentParity, finalizer);

        ecstream.encode(
            input, content.length,
            [data1, data2], [parity],
            512);
    });

    mocha.it('Input larger than k * stripe size', function (done) {
        const content = Buffer.concat([
            Buffer.alloc(256, 0x1),
            Buffer.alloc(256, 0x2),
            Buffer.alloc(256, 0x1),
            Buffer.alloc(243, 0x2),
        ]);
        const input = streamMe(content);
        let waiting = 3;
        const finalizer = err => {
            --waiting;
            if (err) {
                done(err);
                waiting = 0; // avoid multiple calls to done()
            } else if (waiting === 0) {
                done();
            }
        };

        const data1 = new stream.PassThrough();
        const expectedContent1 = Buffer.alloc(512, 0x1);
        checkOutStream(data1, 0, expectedContent1, finalizer);

        const data2 = new stream.PassThrough();
        const expectedContent2 = Buffer.concat([
            Buffer.alloc(256 + 243, 0x2),
            Buffer.alloc(256 - 243, 0x0),
        ]);
        checkOutStream(data2, 1, expectedContent2, finalizer);

        const parity = new stream.PassThrough();
        const expectedContentParity = Buffer.concat([
            Buffer.alloc(256 + 243, 0x1 ^ 0x2),
            Buffer.alloc(256 - 243, 0x1),
        ]);
        checkOutStream(parity, 2, expectedContentParity, finalizer);

        ecstream.encode(
            input, content.length,
            [data1, data2], [parity],
            256);
    });

    mocha.it('Input stream error', function (done) {
        const content = Buffer.concat([
            Buffer.alloc(1023, 0x1),
        ]);
        const input = new stream.PassThrough();

        // Put partial input
        input.write(content.slice(0, 177));
        // Emit error after a timeout
        const error = new Error('On purpose...');
        setTimeout(() => input.emit('error', error), 20);

        let waiting = 3;
        const finalizer = err => {
            --waiting;
            assert.strictEqual(err.message, 'On purpose...');
            if (waiting === 0) {
                done();
            }
        };

        const data1 = new stream.PassThrough();
        data1.on('error', err => finalizer(err));

        const data2 = new stream.PassThrough();
        data2.on('error', err => finalizer(err));

        const parity = new stream.PassThrough();
        parity.on('error', err => finalizer(err));

        ecstream.encode(
            input, content.length,
            [data1, data2], [parity],
            512);
    });

    mocha.it('Back pressure', function (done) {
        const content = Buffer.alloc(2 * 4096, 0x1);
        const input = streamMe(content);
        let waiting = 3;
        const finalizer = err => {
            --waiting;
            if (err) {
                done(err);
                return;
            } else if (waiting === 0) {
                done();
            }
        };

        const data1 = new stream.PassThrough();
        const expectedContent1 = Buffer.alloc(4096, 0x1);
        checkOutStream(data1, 0, expectedContent1, finalizer);

        const data2 = new stream.PassThrough();
        const expectedContent2 = Buffer.alloc(4096, 0x1);
        checkOutStream(data2, 1, expectedContent2, finalizer);

        const parity = new stream.PassThrough();
        const expectedContentParity = Buffer.alloc(4096, 0x1 ^ 0x1);
        checkOutStream(parity, 2, expectedContentParity, finalizer);

        ecstream.encode(
            input, content.length,
            [data1, data2], [parity],
            128);
    });

    mocha.it('Large stripe size', function (done) {
        const stripeSize = 1024 * 1024 * 8; // 8MB
        const content = Buffer.alloc(2 * stripeSize, 0x1);
        const input = streamMe(content);
        let waiting = 3;
        const finalizer = err => {
            --waiting;
            if (err) {
                done(err);
                waiting = 0; // avoid multiple calls to done()
            } else if (waiting === 0) {
                done();
            }
        };

        const data1 = new stream.PassThrough();
        const expectedContent1 = Buffer.alloc(stripeSize, 0x1);
        checkOutStream(data1, 0, expectedContent1, finalizer);

        const data2 = new stream.PassThrough();
        const expectedContent2 = Buffer.alloc(stripeSize, 0x1);
        checkOutStream(data2, 1, expectedContent2, finalizer);

        const parity = new stream.PassThrough();
        const expectedContentParity = Buffer.alloc(stripeSize, 0x1 ^ 0x1);
        checkOutStream(parity, 2, expectedContentParity, finalizer);

        ecstream.encode(
            input, content.length,
            [data1, data2], [parity],
            stripeSize);
    });
});
