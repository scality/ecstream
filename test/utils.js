'use strict'; // eslint-disable-line strict
/* eslint-disable max-len */

const assert = require('assert');
const stream = require('stream');

/**
 * Create a readable stream from a buffer/string
 *
 * @param {String|Buffer} buffer to stream
 * @return {stream.Readable} readable stream
 */
function streamMe(buffer) {
    const streamed = new stream.Readable();
    streamed.push(buffer);
    streamed.push(null);
    return streamed;
}


/**
 * Verify output stream has expected content
 *
 * @param {stream.Readable} outstream - Output stream to watch
 * @param {Number} streamId - Stream index (to ease debuging)
 * @param {Buffer} expectedContent - Expected bytes to read
 * @param {Function} callback - Called when end or on error err => {...}
 * @return {undefined}
 */
function checkOutStream(outstream, streamId, expectedContent, callback) {
    let mismatchFound = false;
    let read = 0;
    outstream.on('data', chunk => {
        if (mismatchFound) {
            return;
        }

        assert.ok(read + chunk.length <= expectedContent.length);
        for (let p = 0; p < chunk.length; ++p) {
            if (chunk[p] !== expectedContent[read + p]) {
                const err = new Error(`[Stream ${streamId}] Content mismatch (offset ${read + p}): Expected: ${expectedContent[read + p]}, Found: ${chunk[p]}`);
                callback(err);
                mismatchFound = true;
                return;
            }
        }
        read += chunk.length;
    });

    outstream.once('error', err => {
        if (!mismatchFound) {
            mismatchFound = true;
            callback(err);
        }
    });

    outstream.once('end', () => {
        if (!mismatchFound) {
            assert.strictEqual(read, expectedContent.length);
            callback(null);
        }
    });

    outstream.resume();
}

module.exports = {
    checkOutStream,
    streamMe,
};
