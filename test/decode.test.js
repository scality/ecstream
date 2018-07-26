'use strict'; // eslint-disable-line strict
/* eslint-disable max-len */
/* eslint-disable prefer-arrow-callback */ // Mocha recommends not using => func
/* eslint-disable func-names */

const assert = require('assert');
const mocha = require('mocha');
const stream = require('stream');

const ecstream = require('../index');
const { checkOutStream, streamMe } = require('./utils');

mocha.describe('Erasure decoding test suite', function () {
    mocha.it('Decode bad stripe size', function (done) {
        try {
            ecstream.decode(null, 0, [], [], 7);
            assert.ok(undefined); // Unreachable
        } catch (error) {
            assert.ok(error instanceof assert.AssertionError);
            done();
        }
    });

    mocha.it('Decode k (# data parts)', function (done) {
        try {
            ecstream.decode(null, 0, [], [], 8);
            assert.ok(undefined); // Unreachable
        } catch (error) {
            assert.ok(error instanceof assert.AssertionError);
            done();
        }
    });

    mocha.it('Decode m (# parity parts)', function (done) {
        try {
            ecstream.decode(null, 0, ['fake', 'fake'], [], 8);
            assert.ok(undefined); // Unreachable
        } catch (error) {
            assert.ok(error instanceof assert.AssertionError);
            done();
        }
    });

    mocha.it('Not enough valid parts', function (done) {
        let checked = false;
        const ostream = new stream.PassThrough();
        ostream.on('error', err => {
            assert.ok(err);
            if (checked) {
                done();
            }
            checked = true;
        });
        const validStream = streamMe(Buffer.alloc(4096, 0x42));
        const decoder = ecstream.decode(
            ostream, 4096,
            [null, validStream, validStream, null],
            [validStream, null],
            1024);

        assert.strictEqual(decoder.k, 4);
        assert.strictEqual(decoder.m, 2);
        assert.strictEqual(decoder.sources, 2 + 4 + 16);
        assert.strictEqual(decoder.targets, 1 + 8);
        assert.strictEqual(decoder.inputError.message,
                           'Not enough parts for decoding: 3 < 4');
        if (checked) {
            done();
        }
        checked = true;
    });

    mocha.it('Decode smaller than k * stripe size (only data)', function (done) {
        const dataStream1 = streamMe(Buffer.alloc(512, 0x42));
        const dataStream2 = streamMe(Buffer.concat([Buffer.alloc(488, 0x66),
                                                    Buffer.alloc(24, 0x0)]));
        const parityStream = streamMe(Buffer.concat([Buffer.alloc(488, 0x42 ^ 0x66),
                                                     Buffer.alloc(24, 0x42)]));

        const ostream = new stream.PassThrough();
        checkOutStream(ostream, 0,
                       Buffer.concat([
                           Buffer.alloc(512, 0x42),
                           Buffer.alloc(1000 - 512, 0x66),
                       ]),
                       err => done(err));

        ecstream.decode(ostream, 1000, [dataStream1, dataStream2], [parityStream], 512);
    });

    mocha.it('Decode smaller than k * stripe size (1 data + 1 partiy)', function (done) {
        const dataStream = streamMe(Buffer.alloc(512, 0x42));
        const parityStream = streamMe(Buffer.concat([Buffer.alloc(488, 0x42 ^ 0x66),
                                                     Buffer.alloc(24, 0x42)]));

        const ostream = new stream.PassThrough();
        checkOutStream(ostream, 0,
                       Buffer.concat([
                           Buffer.alloc(512, 0x42),
                           Buffer.alloc(488, 0x66),
                       ]),
                       err => done(err));

        const decoder = ecstream.decode(
            ostream, 1000, [dataStream, null], [parityStream], 512);
        assert.strictEqual(decoder.k, 2);
        assert.strictEqual(decoder.m, 1);
        assert.strictEqual(decoder.sources, 1 + 4);
        assert.strictEqual(decoder.targets, 2);
    });

    mocha.it('Decode multiple ofstripe size (only data)', function (done) {
        const dataStream1 = streamMe(Buffer.alloc(512, 0x42));
        const dataStream2 = streamMe(Buffer.alloc(512, 0x66));

        const ostream = new stream.PassThrough();
        checkOutStream(ostream, 0,
                       Buffer.concat([
                           Buffer.alloc(256, 0x42),
                           Buffer.alloc(256, 0x66),
                           Buffer.alloc(256, 0x42),
                           Buffer.alloc(256, 0x66),
                       ]),
                       err => done(err));

        ecstream.decode(ostream, 1024, [dataStream1, dataStream2], [null], 256);
    });

    mocha.it('Decode multiple of stripe size (1 data + 1 partiy)', function (done) {
        const dataStream = streamMe(Buffer.alloc(512, 0x66));
        const parityStream = streamMe(Buffer.alloc(512, 0x42 ^ 0x66));

        const ostream = new stream.PassThrough();
        checkOutStream(ostream, 0,
                       Buffer.concat([
                           Buffer.alloc(512, 0x42),
                           Buffer.alloc(512, 0x66),
                       ]),
                       err => done(err));

        const decoder = ecstream.decode(
            ostream, 1024, [null, dataStream], [parityStream], 512);
        assert.strictEqual(decoder.k, 2);
        assert.strictEqual(decoder.m, 1);
        assert.strictEqual(decoder.sources, 2 + 4);
        assert.strictEqual(decoder.targets, 1);
    });

    mocha.it('Back pressure', function (done) {
        const dataStream = streamMe(Buffer.alloc(4096, 0x66));
        const parityStream = streamMe(Buffer.alloc(4096, 0x0));

        const ostream = new stream.PassThrough();
        checkOutStream(ostream, 0,
                       Buffer.alloc(8192, 0x66),
                       err => done(err));

        const decoder = ecstream.decode(
            ostream, 8192, [null, dataStream], [parityStream], 1024);
        const encodeMethodBackup = decoder.encode;
        decoder.encode = (dataBuffer, parityBuffer, dispatcher) =>
            setTimeout(
                () => encodeMethodBackup.apply(
                    decoder, [dataBuffer, parityBuffer, dispatcher]),
                300);
    });

    mocha.it('Large stripe size', function (done) {
        const stripeSize = 1024 * 1024 * 8; // 8MB
        const dataStream = streamMe(Buffer.alloc(stripeSize, 0x66));
        const parityStream = streamMe(Buffer.alloc(stripeSize, 0x42 ^ 0x66));

        const ostream = new stream.PassThrough();
        checkOutStream(ostream, 0,
                       Buffer.concat([
                           Buffer.alloc(stripeSize, 0x42),
                           Buffer.alloc(stripeSize, 0x66),
                       ]),
                       err => done(err));

        ecstream.decode(
            ostream, 2 * stripeSize, [null, dataStream], [parityStream], stripeSize);
    });
});
