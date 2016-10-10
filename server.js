#!/usr/bin/env node

const initify = require('.')


let target = process.argv[2] || '.'


initify(target)
.then(init => init.pipe(process.stdout))
