'use strict'; // eslint-disable-line strict

const assert = require('assert');
const { DencodeContext } = require('./dencode_context');
const { decodeBufferStep } = require('./decode');

/**
 * Dispatch repaired stripe part into output streams - Step 3
 *
 * @param {DencodeContext} repairContext - Context of the repair
 * @param {null|Error} error - Encoding error
 * @return {undefined}
 */
function repairDispatchStep(repairContext, error) {
    if (error) {
        repairContext.error(error);
        repairContext.unref();
        return;
    }

    // Forward everything to output streams
    let nPending = 1; // 1 is the main loop, wait for all to started
    const stripeSize = repairContext.stripeSize;
    const writeCallback = () => {
        nPending--;
        if (nPending === 0) {
            setImmediate(() => repairContext.unref());
        }
    };

    repairContext.ostreams.forEach((s, i) => {
        if ((repairContext.targets & (1 << i)) === 0) {
            return;
        }
        const buffer = i < repairContext.k ?
                  repairContext.getDataBuffer() :
                  repairContext.getParityBuffer();
        const stripeId = i < repairContext.k ? i : i - repairContext.k;
        const start = stripeId * stripeSize;
        const end = (stripeId + 1) * stripeSize;

        /* Bumped twice here to handle write callback
         * and potentially waiting for 'drain' event
         */
        nPending += 2;
        const writeOk = s.write(
            buffer.slice(start, end),
            null, /* binary encoding */
            writeCallback);
        if (!writeOk) {
            s.once('drain', writeCallback);
        } else {
            nPending--;
        }
    });

    nPending--; // Release
}


/**
 * Repair passed buffer - Step 2
 *
 * @param {DencodeContext} repairCtx - Context of the repair
 * @return {null|Object} anything returned by underlying EC lib
 */
function repairStep(repairCtx) {
    return repairCtx.encode(repairDispatchStep);
}


/**
 * Select which to reconstruct and what source to use
 *
 * @param {Number} k - Number of data parts
 * @param {Number} m - Number of parity parts
 * @param {[stream.Readable]} istreams - source streams
 * @param {[stream.Writable]} ostreams - repaired streams
 * @return {Object} selected roles
 * @return {Number} sources (bitfield) - what to use as input
 * @return {Number} targets (bitfield) - what to reconstruct
 *                                       (0 if all data available)
 * @return {Number} available - Number of valid input sources (must be === k)
 */
function getPartRoles(k, m, istreams, ostreams) {
    let sources = 0;
    let targets = 0;
    let available = 0;

    for (let i = 0; i < k + m; ++i) {
        if (istreams[i]) { // Available
            if (available === k) {
                break; // We have enough sources
            }
            sources |= (1 << i);
            ++available;
        }
    }

    for (let i = 0; i < k + m; ++i) {
        if (ostreams[i]) { // Reconstruct
            targets |= (1 << i);
        }
    }

    return { sources, targets, available };
}


/**
 * Repair Reed-Solomon (k, m) encoded object
 *
 * @param {Number} k - Number of data parts
 * @param {Number} m - Number of parity parts
 * @param {[stream.Readable]} istreams - source streams
 * @param {[stream.Writable]} ostreams - repaired streams
 * @param {Number} size - Length of output stream (shortcut partial last stripe)
 * @param {Number} stripeSize - Stripe size to use
 * @return {DecodeContext} repair context
 *
 * Code parameters (k, m) are inferred from respectively
 * dataStreams and parityStreams length.
 */
function repair(k, m, istreams, ostreams, size, stripeSize) {
    assert.strictEqual(k + m, istreams.length);
    assert.strictEqual(k + m, ostreams.length);

    const { sources, targets, available } =
              getPartRoles(k, m, istreams, ostreams);

    const repairContext = new DencodeContext(
        k, m, istreams, ostreams, size, sources, targets, stripeSize);

    if (available < k) {
        const error = new Error(
            `Not enough parts for decoding: ${available} < ${k}`);
        repairContext.error(error);
        return repairContext;
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
        s.once('error', err => setImmediate(() => repairContext.error(err)));
        // Read handler
        s.on('readable', () => decodeBufferStep(
            repairContext, i, repairStep));
    });

    return repairContext;
}


module.exports = {
    repair,
};
