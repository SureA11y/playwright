'use strict';

const { EngineError, getScanGaps, getScanNotes, formatOccurrenceLocation, getGatingFailures, SEVERITIES } = require('@surea11y/binding-base');
const { A11yCoreBuilder } = require('./A11yCoreBuilder');
const { formatFailures } = require('./formatFailures');

module.exports = { A11yCoreBuilder, EngineError, formatFailures, formatOccurrenceLocation, getScanGaps, getScanNotes, getGatingFailures, SEVERITIES };
