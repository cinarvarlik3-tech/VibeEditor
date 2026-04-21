/**
 * Stage 1 regression smoke: load server-side AI stack without starting HTTP.
 */
'use strict';

require('../src/claude/generate');
const metrics = require('../src/cache/metrics');
metrics.chatSiteStats('generate');
console.log('test-stage1: ok');
