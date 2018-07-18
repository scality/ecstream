'use strict'; // eslint-disable-line strict
/* eslint-disable max-len */
/* eslint-disable prefer-arrow-callback */ // Mocha recommends not using => func
/* eslint-disable func-names */

const mocha = require('mocha');
const ecstream = require('../index');

mocha.describe('Erasure coding test suite', function () {
    mocha.it.skip('Encode', function (done) {
        ecstream.encode();
        done();
    });

    mocha.it.skip('Decode', function (done) {
        ecstream.decode();
        done();
    });
});
