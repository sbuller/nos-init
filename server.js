#!/usr/bin/env node

const initify = require('.')


let target = process.argv[2] || './'

debug("Running nos-init")

initify(target)
.then(init => init.pipe(process.stdout))
.catch(e => throw e)
