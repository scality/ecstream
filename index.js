module.exports = {
    encode: require('./lib/encode').encode,
    decode: require('./lib/decode').decode,
    repair: require('./lib/repair').repair,
    safeStripeSize: require('./lib/dencode_context').safeStripeSize,
};
