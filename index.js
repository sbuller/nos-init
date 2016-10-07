#!/bin/env node

const createGzip = require('zlib').createGzip
const exec = require('child_process').exec
const path = require('path')

const cpio = require('cpio-stream').pack
const debug = require('debug')('nos-init')
const fs = require('mz/fs')
const pump = require('pump')
const Queue = require('push-queue')
const walk = require('findit')


function initify(target) {
	return (fs.stat(target)
		.then(stat=>stat.isFile()?
			initFromFile(target, stat):
			initFromModule(target))
		.then(init=>init.pipe(createGzip()))
		.catch(e=>debug('initify', e)))
}

function initFromFile(location, stat) {
	let pack = cpio({format:'newc'})

	stat.name = path.basename(location)
	stat.uid = 0
	stat.gid = 0

	pack.directory({name:'sbin', mode:0o555})
	pack.file({name:'sbin/init', mode:0o555},
`#!/usr/bin/env node

try
{
	require('/${stat.name}')
}
catch(e)
{
	console.log(e)
	require('repl').start()
}`)

	pump(fs.createReadStream(location), pack.entry(stat), err=>err||pack.finalize())

	return pack
}

function initFromModule(location) {
	let mod = new Module(location)
	let pack = cpio({format:'newc'})
	let entrypoint = mod.entry()
	let setup = mod.install().then(()=>mod.build())

	let header = Promise.all([entrypoint, setup])
		.then(([entrypoint])=>{
			pack.directory({name:'sbin', mode:0o555})
			pack.file({name:'sbin/init', mode:0o555},
`#!/usr/bin/env node

try
{
	require('${entrypoint}')
}
catch(e)
{
	console.log(e)
	require('repl').start()
}`)})

	header.then(()=>{
		mod.walk( (stat, next)=>{
			if (!stat) return pack.finalize()

			debug('dequeued %s', stat.name)

			let nextcb = err=>{
				if (!err) return next()

				debug('next', err)
			}

			stat.uid = 0
			stat.gid = 0

			let relativePath = path.relative(location, stat.name)
			let newPath = mod.name + path.resolve('/', relativePath)

			// newPath ends up with a trailing '/' when relativePath is empty
			stat.name = relativePath === '' ? mod.name : newPath

			let entry = pack.entry(stat, stat.linkDest, nextcb)

			if (stat.streamCB) {
				let stream = stat.streamCB().on('error', e=>debug('error in stream', e))

				pump(stream, entry)
			}
		})
	})
	.catch(e=>debug('walk', e))

	return pack
}

function run(cmd, dir) {
	let cwd = process.cwd()
	dir = path.resolve(cwd, dir)

	return new Promise((res, rej)=>{
		let child = exec(`cd ${dir}; ${cmd}`)
		child.on('error', rej)
		child.on('exit', code=>code===0?res():rej(code))
	})
	.then(()=>dir?process.chdir(cwd):undefined)
}

function cleanupCounter(fn) {
	let counter = 1

	return {
		wait: function() {
			counter++
		},
		resume: function() {
			if (--counter === 0) {
				fn()
			}
		}
	}
}

class Module {
	constructor(path) {
		this.path = path

		if (!this.path.endsWith('/')) this.path = this.path + '/'

		this.config = fs.readFile(`${this.path}package.json`, 'utf8')
			.then(d=>JSON.parse(d))
			.then(config=>{
				this.name = config.name

				return config
			})
	}

	install() {
		return run("npm install", this.path)
	}

	build() {
		return this.config.then(c=>{
			const b = c.scripts && c.scripts.build

			return b?run("npm run build", this.path):Promise.resolve()
		})
	}

	entry() {
		return (this.config
			.then(c=>this.path + c.main, ()=>'')
			.then(path=>fs.exists(path)
				.then(exists=>exists?path:this.path + 'server.js'))
			.then(path=>fs.exists(path)
				.then(exists=>exists?path:this.path + 'index.js')))
			.then(location=>path.resolve('/', this.name, path.relative(this.path,
				                                                         location)))
	}

	walk(cb) {
		let push = Queue(cb)
		let cleanup = cleanupCounter(()=>push(null))

		walk(this.path)
		.on('directory', (dir, stat)=>{
			debug('directory', dir)
			stat.name = dir
			stat.size = 0
			push(stat)
		})
		.on('file', (file, stat)=>{
			debug('file', file)
			stat.name = file
			stat.streamCB = ()=>fs.createReadStream(file)
			push(stat)
		})
		.on('link', (file, stat)=>{
			debug('symlink', file)
			stat.name = file
			cleanup.wait()
			fs.readlink(file, (err, dest)=>{
				debug('sym %s, err: %s', stat && stat.name, err)
				stat.linkDest = dest
				push(stat)
				cleanup.resume()
			})
		})
		.on('end', ()=>{
			debug('all files read')
			cleanup.resume()
		})
		.on('error', e=>debug('walker', e))
	}
}


module.exports = initify
