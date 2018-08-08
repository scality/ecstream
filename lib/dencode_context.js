'use strict'; // eslint-disable-line strict

const assert = require('assert');
const ReedSolomon = require('@ronomon/reed-solomon');

/* Shared, cached, reusable Reed-Solomon context
 * Thread safe*/
const _contextCache = new Map();


/**
 * Get Reed Solomon context
 *
 * @param {Number} k - Number of data parts
 * @param {Number} m - Number of coding parts
 * @return {Object} a Reed-Solomon context
 * @comment Contexts are cached, never deleted
*/
function getECContext(k, m) {
    assert(typeof k === 'number');
    assert.ok(k > 0);
    assert.ok(k <= ReedSolomon.MAX_K);
    assert(typeof m === 'number');
    assert.ok(m > 0);
    assert.ok(m <= ReedSolomon.MAX_M);

    const key = [k, m].join(',');
    const context = _contextCache.get(key);
    if (context !== undefined) {
        return context;
    }

    // Create an encoding context (can be cached and re-used concurrently):
    const newContext = ReedSolomon.create(k, m);
    _contextCache.set(key, newContext);
    return newContext;
}


class DencodeContext {
    /**
     * Stateful part of the encoding/decoding/repair process
     *
     * Aggregates several useful values and performs
     * stream backpressure to avoid memory blowup whenever
     * encoding/decoding is slower than reading from the stream
     *
     * @constructor
     * @param {Number} k - Number of data parts
     * @param {Number} m - Number of parity parts
     * @param {[stream.Readable]} inputStreams - Streams to read from
     * @param {[stream.Writeable]} outputStreams - Streams to write in
     * @param {Number} size - Length of streams
     *                 (used to know number of stripes and end of last stripe)
     * @param {Number} sources - Bitfields, which streams to use as input
     * @param {Number} targets - Bitfields, which streams to output
     * @param {Number} stripeSize - Stripe size to use (must be multiple of 8)
     */
    constructor(k, m, inputStreams, outputStreams, size,
                sources, targets, stripeSize) {
        assert.strictEqual(stripeSize % 8, 0); // required by Reed-Solomon
        this.k = k;
        this.m = m;
        this.rsContext = getECContext(k, m);
        this.stripeSize = stripeSize;
        this.size = size;

        // Specify data bufffer (no header and no footer)
        this.data = {
            offset: 0,
            size: stripeSize * k,
        };

        // Specify parity bufffer (no header and no footer)
        this.parity = {
            offset: 0,
            size: stripeSize * m,
        };

        this.istreams = inputStreams;
        this.ostreams = outputStreams;

        // Bitfields what parts to use where
        this.sources = sources;
        this.targets = targets;

        // Used for backpressure: avoid too many in-flight
        // encoding and streaming
        this.inFlight = 0;

        this.processedStripe = 0;
        this.nStripe = Math.ceil(size / (k * stripeSize));
    }

    /**
     * Notify context input streams has ended
     * (typically it emitted 'end' event)
     *
     * @return {undefined}
     */
    end() {
        /* Forward end to all downstreams iff
         * everything was sent */
        if (this.inFlight === 0 &&
            this.processedStripe === this.nStripe) {
            this.ostreams.filter(s => s).forEach(
                s => s.push(null));
        }
    }

    /**
     * Notify context an error occured on input stream
     * (typically it emitted 'error' event)
     *
     * @param {Error} err - Received error
     * @return {undefined}
     */
    error(err) {
        this.inputError = err;
        this.ostreams.filter(s => s).forEach(
            s => s.emit('error', err));
    }

    /**
     * Notify a new stripe is being encoded (back pressure part 1)
     * @return {undefined}
     */
    ref() {
        this.inFlight++;
    }

    /**
     * Notify a new stripe has been encoded (back pressure part 2)
     * @return {undefined}
     */
    unref() {
        this.inFlight--;
        this.processedStripe++;
        // Wakeup input streams
        // Required whenever we can read more data
        // than k * stripeSize. First step of encoder
        // will consume only part of the entry.
        // Stream will stay dormant until we try to read.
        this.istreams.filter(s => s).forEach(
            s => s.emit('readable'));
        this.end();
    }

    /**
     * Should we send to encoding? (back pressure part 3)
     *
     * Underlying library is asynchronous, and thus we must
     * either prevent multiple concurrent encodings of same
     * stream or reorder afterwards. For simplicity we chose
     * to linearize dispatches to encoding library
     * (no self concurrency).
     *
     * @return {bool} should stop
     */
    waitEncoding() {
        return (this.inFlight > 0);
    }

    /**
     * Should we keep reading? (back pressure part 4)
     *
     * Waiting functions are separated to allow filling a new stripe
     * while another is processed by the task pool. For simplicity,
     * you may use only waitEncoding to only have a single stripe
     * at a time through the encode/decode pipeline.
     *
     * @return {bool} should stop
     */
    waitReading() {
        // We can fill a new stripe while another is being encoded
        // but that's it.
        return (this.inFlight > 1);
    }

    /**
     * @param {Buffer} dataBuffer - data part of the stripe
     * @param {Buffer} parityBuffer - parity part of the stripe
     * @param {Funcion} dispatcher - Called whenever a stripe has
     *        finish encoding: (DencodeContext, Buffer, Buffer, Error|null) -> ?
     * @return {null|Object} anything returned by underlying EC lib
     */
    encode(dataBuffer, parityBuffer, dispatcher) {
        // We don't need to encode/decode anything, bypass task pool
        if (this.targets === 0) {
            setImmediate(() => dispatcher(
                this, dataBuffer, parityBuffer, null));
            return null;
        }

        return ReedSolomon.encode(
            this.rsContext,
            this.sources,
            this.targets,
            dataBuffer,
            this.data.offset,
            this.data.size,
            parityBuffer,
            this.parity.offset,
            this.parity.size,
            err => dispatcher(
                this, dataBuffer, parityBuffer, err)
        );
    }
}


module.exports = {
    DencodeContext,
};
