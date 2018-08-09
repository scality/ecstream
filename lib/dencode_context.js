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


/**
 * Not every stripe sizes are created equal...
 *
 * 1/ Stripe size must a multiple of 8:
 *    required by ReedSolomon lib & Galoid field computations
 * 2/ Below maximum stream.Readable buffer size
 *    Refer to actual implementation of computeNewHighWaterMark
 *    https://github.com/nodejs/node/blob/v6.12.2/lib/_stream_readable.js
 */
const MAX_HWM = 0x800000;

/**
 * Compute a safe stripe size
 *
 * @param {Number} k - Number of data parts
 * @param {Number} m - Number of parity parts
 * @param {Number} hint - StripeSize hint
 * @return {Number} actual stripe size to use
 */
function safeStripeSize(k, m, hint) {
    const alignedHint = Math.ceil(hint / 8) * 8;
    const largest = Math.max(k, m);
    const maximum = Math.floor(MAX_HWM / largest);
    const maximumAligned = Math.floor(maximum / 8) * 8;
    return Math.min(alignedHint, maximumAligned);
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
     * @param {Number} stripeSizeHint - Stripe size hint to use
     */
    constructor(k, m, inputStreams, outputStreams, size,
                sources, targets, stripeSizeHint) {
        this.k = k;
        this.m = m;
        this.rsContext = getECContext(k, m);
        this.stripeSize = safeStripeSize(k, m, stripeSizeHint);
        this.size = size;

        // Specify data bufffer (no header and no footer)
        this.data = {
            offset: 0,
            size: this.stripeSize * k,
        };

        // Specify parity bufffer (no header and no footer)
        this.parity = {
            offset: 0,
            size: this.stripeSize * m,
        };

        // We need to keep all input & output streams as
        // are accessed by offset in Array
        // For dispatch performance though,
        // we keep a filtered one
        this.istreams = inputStreams;
        this.filteredIstreams = inputStreams.filter(s => s);
        this.ostreams = outputStreams;
        this.filteredOstreams = outputStreams.filter(s => s);

        // Bitfields what parts to use where
        this.sources = sources;
        this.targets = targets;

        // Used for backpressure: avoid too many in-flight
        // encoding and streaming
        this.inFlight = false;

        this.processedStripe = 0;
        this.nStripe = Math.ceil(size / (k * this.stripeSize));

        this._stripe = {};
        this._newStripe();
    }

    _newStripe() {
        // Bitfield, track which parts of a stripe are ready
        this._stripe.waiting = this.sources;
        this._stripe.dataBuffer = Buffer.allocUnsafe(this.data.size);
        this._stripe.parityBuffer = Buffer.allocUnsafe(this.parity.size);
    }

    getDataBuffer() {
        return this._stripe.dataBuffer;
    }

    getParityBuffer() {
        return this._stripe.parityBuffer;
    }

    getStripeWaiting() {
        return this._stripe.waiting;
    }

    /**
     * Notify context an error occured on input stream
     * (typically it emitted 'error' event)
     *
     * @param {Error} err - Received error
     * @return {undefined}
     */
    error(err) {
        if (!this.inputError) {
            this.inputError = err;
            this.filteredOstreams.forEach(s => s.emit('error', err));
        }
    }

    /**
     * Notify a new stripe is being encoded (back pressure part 1)
     * @return {undefined}
     */
    ref() {
        // Check stripe really is ready
        assert.strictEqual(this._stripe.waiting, 0);
        this.inFlight = true;
    }

    /**
     * Notify a new stripe has been encoded (back pressure part 2)
     * @return {undefined}
     */
    unref() {
        this.inFlight = false;
        this.processedStripe++;
        /* Forward end to all downstreams iff
         * everything was sent */
        if (this.processedStripe === this.nStripe) {
            this.filteredOstreams.forEach(s => s.emit('end'));
        } else { // prepare new chunk
            this._newStripe();
            // Wakeup input streams
            // Required whenever we can read more data
            // than k * stripeSize. First step of encoder
            // will consume only part of the entry.
            // Stream will stay dormant until we try to read.
            this.filteredIstreams.forEach(s => s.emit('readable'));
        }
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
     * @return {bool} should wait
     */
    wait() {
        return this.inFlight;
    }

    addedToStripe(sources) {
        this._stripe.waiting &= ~sources;
    }

    /**
     * Should we start encoding current stripe?
     *
     * @param {DencodeContext} decodeContext - Context of the stream decoding
     * @return {boolean} true if stripe can be dispatched
     */
    readyForEncoding() {
        return this._stripe.waiting === 0;
    }

    /**
     * Encode current loaded stripe
     *
     * @param {Funcion} dispatcher - Called whenever a stripe has
     *        finish encoding: (DencodeContext, Buffer, Buffer, Error|null) -> ?
     * @return {null|Object} anything returned by underlying EC lib
     */
    encode(dispatcher) {
        assert.ok(this.inFlight);
        // We don't need to encode/decode anything, bypass task pool
        if (this.targets === 0) {
            setImmediate(() => dispatcher(this, null));
            return null;
        }

        return ReedSolomon.encode(
            this.rsContext,
            this.sources,
            this.targets,
            this._stripe.dataBuffer,
            this.data.offset,
            this.data.size,
            this._stripe.parityBuffer,
            this.parity.offset,
            this.parity.size,
            err => dispatcher(this, err)
        );
    }
}


module.exports = {
    safeStripeSize,
    DencodeContext,
};
