'use strict'; // eslint-disable-line strict

/**
 * Encode a stream of data with a Reed-Solomon (k, m) systematic code
 *
 * Overall operation is done in 3 steps:
 * 1/ Striping and buffering the stream
 * 2/ Actual encoding
 * 3/ Redispatch onto output streams
 *
 * Example: k = 3, m = 2
 * dddddddddddddddddddddddddddd.......
 * |     chunk  1          | chunk 2 <- each chunk of size k * S
 * | data1 | data2 | data3 | <- each sub-part of size S  (step 1)
 * | data1 | data2 | data3 | par2 | par3    (step 2)
 *     |       |      |        |      |     (step 3)
 *     v       v      v        v      v
 *           output streams
 *
 * Step 1 - stripes
 * Actual implementation uses a vector code like layout.
 * Input stream is first chopped into parcels of size k*S (stripe size).
 * This parcel is considered as k distinct data parts of size S,
 * and are then encoded to give m parity parts of size S.
 * Then we encode the second stripe, and so forth.
 *
 * Step 2 - Actual encoding, offloading to underlying library
 * Dispatching to task pool.
 *
 * Step 3 - Redispatch to output streams
 * The encoded buffers are finally chopped again and pushed onto
 * the output streams.
 * Data stream i will receive [i * S, (i+1) * S[ part of the data buffer,
 * parity stream j will receive [j * S, (j+1) * S[ part of the parity buffer.
 *
 * ---Final stripe ---
 * The last stripe is most likely not full, and is filled with 0s. The final
 * stripe DOES NOT use a custom size to minimize 0 padding. Such optimization
 * can only be done globally by selecting the stripe size depending on the size
 * of whole input stream.
 */

const { DencodeContext } = require('./dencode_context');

/**
 * Dispatch encoded stripe into output streams - Step 3
 *
 * @param {DencodeContext} encodeContext - Context of the stream encoding
 * @param {null|Error} error - Encoding error
 * @return {undefined}
 */
function encodeDispatchStep(encodeContext, error) {
    if (error) {
        encodeContext.error(error);
        encodeContext.unref();
        return;
    }

    // Forward everything to output streams
    let nPending = encodeContext.ostreams.length;
    const stripeSize = encodeContext.stripeSize;
    encodeContext.ostreams.forEach((s, i) => {
        const buffer = i < encodeContext.k ?
                  encodeContext.getDataBuffer() :
                  encodeContext.getParityBuffer();
        const stripeId = i < encodeContext.k ? i : i - encodeContext.k;
        const start = stripeId * stripeSize;
        const end = (stripeId + 1) * stripeSize;

        /* Bumped here to handle write callback
         * and potentially waiting for 'drain' event
         */
        nPending++;
        const writeOk = s.write(
            buffer.slice(start, end),
            null, /* binary encoding */
            () => {
                nPending--;
                if (nPending === 0) {
                    encodeContext.unref();
                }
            });
        if (!writeOk) {
            s.once('drain', () => {
                nPending--;
                if (nPending === 0) {
                    encodeContext.unref();
                }
            });
        } else {
            nPending--;
        }
    });
}


/**
 * Bufferize stream stripes - Step 1
 *
 * @param {DencodeContext} encodeContext - Context of the stream encoding
 * @param {Number} istreamId - StreamId to read from
 * @return {undefined}
 */
function encodeBufferStep(encodeContext, istreamId) {
    // Backpressure - avoids memory blow-up
    if (encodeContext.wait()) {
        return;
    }

    const lastStripe =
              encodeContext.processedStripe + 1 === encodeContext.nStripe;
    const toRead = lastStripe ?
              (encodeContext.size -
               encodeContext.processedStripe * encodeContext.data.size) :
              encodeContext.data.size;
    const dataBytes = encodeContext.istreams[istreamId].read(toRead);
    // Not enough data to fill data buffer (except for end - see below)
    if (dataBytes === null) {
        return;
    }

    /* Handle end of stream
     * Read returns less data than asked iff 'end' event
     * was received. In this case, needs to create an
     * enlarged buffer. */
    if (dataBytes.length < encodeContext.data.size) {
        dataBytes.copy(encodeContext.getDataBuffer());
        encodeContext.getDataBuffer().fill(0, dataBytes.length);
    } else {
        encodeContext._stripe.dataBuffer = dataBytes; // steal
    }

    encodeContext.addedToStripe(encodeContext.sources);
    encodeContext.ref();
    encodeContext.encode(encodeDispatchStep);
}


/**
 * Encode a stream using Reed-Solomon (k, m), systematic code
 *
 * @param {stream.Readable} instream - Stream to encode
 * @param {Number} size - Length of instream
 * @param {[stream.Writable]} dataOutStreams - Encoded data streams
 * @param {[stream.Writable]} parityOutStreams - Encoded parity streams
 * @param {Number} stripeSize - Stripe size to use
* @return {DencodeContext} encoding context
 *
 * Code parameters (k, m) are inferred from respectively
 * dataOutStreams and parityOutStreams length.
 */
function encode(instream, size, dataOutStreams, parityOutStreams, stripeSize) {
    const k = dataOutStreams.length;
    const m = parityOutStreams.length;
    // Bitfields specifying encode all 'coding' from all 'data' sources
    const sources = (1 << k) - 1;
    const targets = ((1 << m) - 1) << k;
    const ostreams = [...dataOutStreams, ...parityOutStreams];
    const encodeContext = new DencodeContext(
        k, m, [instream], ostreams, size, sources, targets, stripeSize);

    // Input stream MUST be paused, and never pipe'd nor resumed
    instream.pause();

    // Read handler
    instream.on('readable', () => encodeBufferStep(encodeContext, 0));
    instream.on('end', () => encodeBufferStep(encodeContext, 0));

    // Forward errors to context
    instream.once('error', err => encodeContext.error(err));

    return encodeContext;
}


module.exports = {
    encode,
};
