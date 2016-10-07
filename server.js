#!/usr/bin/env node

const debug = require('debug')('nos-init')

const initify = require('.')


let target = process.argv[2] || './'

debug("Running nos-init")

initify(target)
.then(init => init.pipe(process.stdout))
.catch(e => debug('main', e))
