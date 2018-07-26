# Streamed Reed-Solomon erasure coding

## Contributing

In order to contribute, please follow the
[Contributing Guidelines](
https://github.com/scality/Guidelines/blob/master/CONTRIBUTING.md).

## Overview

Library provides a streaming API over barebone [Ronomon/Reed-Solomon](https://github.com/ronomon/reed-solomon) erasure coding library. Manages striping, buffering and stream error forwarding in both encode and decode modes.

## Usage

### Installation

```shell
npm install --save scality/ecstream
```

### Running tests
To use the linter and run the tests:

```shell
# ESLint with Scality's custom rules
npm run lint

# All tests
npm test

# Code coverage
npm run coverage

# Other options and Mocha help
npm test -- -h

```

### Running benchmark
Output a CSV to compare between raw and streaming overlay of encoding.
```shell
NODE_ENV=production node benchmark.js
```