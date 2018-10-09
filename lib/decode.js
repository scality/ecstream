'use strict'; // eslint-disable-line strict

/**
 * Decode a stream of data with a Reed-Solomon (k, m) systematic code
 *
 * Overall operation is done in 3 steps:
 * 1/ Filling a stripe buffer from every sources
 * 2/ Actual decoding
 * 3/ Dispatch potentially reconstructed data to output stream
 *
 * Example: k = 3, m = 2
 * dddddddddddddddddddddddddddd.......
 * |     chunk  1          | chunk 2 <- each chunk of size k * S
 * | data1 | data2 | data3 | <- dispatch data part  (step 3)
 * | data1 | data2 | data3 | par2 | par3    (step 2)
 *     ^       ^      ^        ^      ^
 *     |       |      |        |      |     (step 1)
 *           input streams
 *
 * Step 1 - Filling stripe buffer
 * We need to read from all the various 'sources' streams,
* each filling its own part of a buffer (data or parity).
 *
 * Step 2 - Actual encoding, offloading to underlying library
 * Dispatching to task pool.
 *
 * Step 3 - Dispatch to output stream
 * All the data buffer should now be properly filled and in
 * correct order, simply needs to send away (except last stripe, see below).
 *
 * ---Final stripe ---
 * The last stripe is most likely not full, and is filled with 0s. This is
 * why contrary to 'encode' path we require the desired output size, to be
 * able to truncate the last stripe.
 */

const assert = require('assert');

const { DencodeContext } = require('./dencode_context');


/**
 * Dispatch encoded stripe into output streams - Step 3
 *
 * @param {DencodeContext} decodeContext - Context of the stream decoding
 * @param {null|Error} error - Decoding error
 * @return {undefined}
 */
function decodeDispatchStep(decodeContext, error) {
    if (error) {
        decodeContext.error(error);
        decodeContext.unref();
        return;
    }

    let toPush = decodeContext.getDataBuffer();
    if (decodeContext.processedStripe + 1 === decodeContext.nStripe) {
        const pushedBytes = decodeContext.processedStripe *
                  decodeContext.stripeSize * decodeContext.k;
        const leftover = decodeContext.size - pushedBytes;
        toPush = toPush.slice(0, leftover);
    }

    let nPending = decodeContext.filteredOstreams.length;
    decodeContext.filteredOstreams.forEach(
        s => {
            /* Bumped here to handle write callback
             * and potentially waiting for 'drain' event
             */
            nPending++;
            const writeOk = s.write(
                toPush,
                null, /* binary encoding */
                () => {
                    nPending--;
                    if (nPending === 0) {
                        decodeContext.unref();
                    }
                });
            if (!writeOk) {
                s.once('drain', () => {
                    nPending--;
                    if (nPending === 0) {
                        decodeContext.unref();
                    }
                });
            } else {
                nPending--;
            }
        });
}


/**
 * Decode passed buffer - Step 2
 *
 * @param {DencodeContext} decodeCtx - Context of the stream decoding
 * @return {null|Object} anything returned by underlying EC lib
 */
function decodeStep(decodeCtx) {
    return decodeCtx.encode(decodeDispatchStep);
}


/**
 * Fill corresponding part of the stripe buffers with input data
 *
 * @param {DencodeContext} decodeContext - Context of the stream decoding
 * @param {Number} istreamId - StreamId to read from
 * @return {boolean} filled the buffer or not
 */
function fillStripeBuffers(decodeContext, istreamId) {
    const size = decodeContext.stripeSize;
    const bytes = decodeContext.istreams[istreamId].read(size);
    // Not enough data to fill part of the stripe
    if (bytes === null) {
        return false;
    }

    if (istreamId < decodeContext.k) {// data
        const copied = bytes.copy(decodeContext.getDataBuffer(),
                                  istreamId * size);
        assert.strictEqual(copied, bytes.length);
    } else {
        const copied = bytes.copy(decodeContext.getParityBuffer(),
                                  (istreamId - decodeContext.k) * size);
        assert.strictEqual(copied, bytes.length);
    }

    return true;
}


/**
 * Bufferize stream stripes - Step 1
 *
 * @param {DencodeContext} decodeContext - Context of the stream decoding
 * @param {Number} istreamId - StreamId to read from
 * @param {Function} nextStep - Callback to next pipeline step
 *                              (dencodeContext, Buffer, Buffer) -> ?
 * @return {undefined}
 */
function decodeBufferStep(decodeContext, istreamId, nextStep) {
    // Backpressure - avoids memory blow-up
    if (decodeContext.wait()) {
        return;
    }

    // Already filled this part of the stripe, or not using it
    if ((decodeContext.getStripeWaiting() & (1 << istreamId)) === 0) {
        return;
    }

    // Fill part of the stripe buffer
    const filled = fillStripeBuffers(decodeContext, istreamId);
    if (!filled) {
        return;
    }

    decodeContext.addedToStripe(1 << istreamId);

    if (decodeContext.readyForEncoding()) {
        decodeContext.ref();
        nextStep(decodeContext);
    }
}

/**
 * Select which to reconstruct and what source to use
 *
 * @param {[stream.Writable]} dataStreams - data streams to decode
 * @param {[stream.Writable]} parityStreams - parity streams to decode
 * @return {Object} selected roles
 * @return {Number} sources (bitfield) - what to use as input
 * @return {Number} targets (bitfield) - what to reconstruct
 *                                       (0 if all data available)
 * @return {Number} available - Number of valid input sources (must be === k)
 */
function getPartRoles(dataStreams, parityStreams) {
    const k = dataStreams.length;
    const m = parityStreams.length;

    let sources = 0;
    let targets = 0;
    let available = 0;

    for (let i = 0; i < k; ++i) {
        if (dataStreams[i]) { // Available
            sources |= (1 << i);
            ++available;
            if (available === k) {
                break; // We have enough sources
            }
        } else { // Reconstruct
            targets |= (1 << i);
        }
    }

    if (available < k) {
        for (let i = 0; i < m; ++i) {
            if (parityStreams[i]) { // Available
                sources |= (1 << (k + i));
                ++available;
                if (available === k) {
                    break; // We have enough sources
                }
            }
        }
    }

    return { sources, targets, available };
}


/**
 * Decode a stream using Reed-Solomon (k, m), systematic code
 *
 * @param {stream.Writeable} ostream - Decoded stream
 * @param {Number} size - Length of output stream (shortcut partial last stripe)
 * @param {[stream.Writable]} dataStreams - data streams to decode
 * @param {[stream.Writable]} parityStreams - parity streams to decode
 * @param {Number} stripeSize - Stripe size to use
 * @return {DencodeContext} decoding context
 *
 * Code parameters (k, m) are inferred from respectively
 * dataStreams and parityStreams length.
 */
function decode(ostream, size, dataStreams, parityStreams, stripeSize) {
    const k = dataStreams.length;
    const m = parityStreams.length;
    const istreams = [...dataStreams, ...parityStreams];
    const { sources, targets, available } =
              getPartRoles(dataStreams, parityStreams);
    const decodeContext = new DencodeContext(
        k, m, istreams, [ostream], size, sources, targets, stripeSize);

    if (available < k) {
        const error = new Error(
            `Not enough parts for decoding: ${available} < ${k}`);
        decodeContext.error(error);
        return decodeContext;
    }

    istreams.forEach((s, i) => {
        // Don't filter before, we need the real, overall index here
        if ((sources & (1 << i)) === 0) {
            if (s) {
                s.resume(); // Force consumption of streams we are not using
            }
            return;
        }

        // Input streams MUST be paused, and never pipe'd nor resumed
        s.pause();
        // Forward errors to context
        s.once('error', err => decodeContext.error(err));
        // Read handler
        s.on('readable', () => decodeBufferStep(
            decodeContext, i, decodeStep));
    });

    return decodeContext;
}

module.exports = {
    decode,
    decodeBufferStep,
};
