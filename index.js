#!/bin/env node

const cpio = require('cpio-stream')
const zlib = require('zlib')
const fs = require('mz/fs')
const exec = require('child_process').exec
const walk = require('findit')
const path = require('path')
const pump = require('pump')
const Queue = require('push-queue')
const debug = require('debug')('nos-init')

debug("Running nos-init")

function initify(target) {
	return (fs.stat(target)
		.then(stat=>stat.isFile()?
			initFromFile(target, stat):
			initFromModule(target))
		.then(init=>init.pipe(zlib.createGzip()))
		.catch(e=>debug('initify', e)))
}

function initFromFile(location, stat) {
	let pack = cpio.pack({format:'newc'})
	stat.name = path.basename(location)
	stat.uid = 0
	stat.gid = 0
	pack.directory({name:'sbin', mode:0o555})
	pack.file({name:'sbin/init', mode:0o555}, `#!/bin/node\n\ntry{require('/${stat.name}')}catch(e){console.log(e);require('repl').start()}\n`)
	pump(fs.createReadStream(location), pack.entry(stat), err=>err||pack.finalize())
	return pack
}

function initFromModule(location) {
	let mod = new Module(location)
	let pack = cpio.pack({format:'newc'})
	let entrypoint = mod.entry()
	let setup = mod.install().then(()=>mod.build())
	let header = Promise.all([entrypoint, setup])
		.then(([entrypoint])=>{
			pack.directory({name:'sbin', mode:0o555})
			pack.file({name:'sbin/init', mode:0o555}, `#!/bin/node\n\ntry{require('${entrypoint}')}catch(e){console.log(e);require('repl').start()}\n`)})

	header.then(()=>{
		mod.walk( (data, next)=>{
			if (!data)
				return pack.finalize()

			let [stat, streamcb] = data
			let nextcb = err=>{
				if (!err) return next()
				debug('next', err)
			}

			stat.uid = 0
			stat.gid = 0
			let relativePath = path.relative(location, stat.name)
			let newPath = mod.name + path.resolve('/', relativePath)

			// newPath ends up with a trailing '/' when relativePath is empty
			if (relativePath === '')
				stat.name = mod.name
			else
				stat.name = newPath
			let entry = pack.entry(stat, nextcb)

			if (streamcb) {
				let stream = streamcb()
				stream.on('error', e=>debug('error in stream', e))
				pump(stream, entry)
			}
		})
	}).catch(e=>debug('walk', e))

	return pack
}

function run(cmd, dir) {
	let cwd = process.cwd()
	dir = path.resolve(cwd, dir)
	return new Promise((res, rej)=>{
		let child = exec(`cd ${dir}; ${cmd}`)
		child.on('error', rej)
		child.on('exit', code=>code===0?res():rej(code))
	}).then(()=>dir?process.chdir(cwd):undefined)
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
			.then(location=>path.resolve('/', this.name, path.relative(this.path, location)))
	}

	walk(cb) {
		let push = Queue(cb)
		const walker = walk(this.path)
		walker.on('directory', (dir, stat)=>{
			stat.name = dir
			push([stat, null])
		})
		walker.on('file', (file, stat)=>{
			debug('file', file)
			stat.name = file
			push([stat, ()=>fs.createReadStream(file)])
		})
		walker.on('end', ()=>push(null, null))
		walker.on('error', e=>debug('walker', e))
	}
}

if (require.main === module) {
	let target = process.argv[2]
	target = target || './'
	initify(target).then(init=>init.pipe(process.stdout)).catch(e=>debug('main', e))
} else {
	module.exports = initify
}
