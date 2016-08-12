#!/bin/env node

const cpio = require('cpio-stream')
const zlib = require('zlib')
const fs = require('mz/fs')
const exec = require('child_process').exec
const walk = require('walk')
const path = require('path')
const pump = require('pump')

function initify(target) {
	return (fs.stat(target)
		.then(stat=>stat.isFile()?
			initFromFile(target, stat):
			initFromModule(target))
		.then(init=>init.pipe(zlib.createGzip()))
		.catch(console.error))
}

function initFromFile(location, stat) {
	let pack = cpio.pack({format:'newc'})
	stat.name = path.basename(location)
	stat.uid = 0
	stat.gid = 0
	pack.directory({name:'sbin', mode:0o555})
	pack.file({name:'sbin/init', mode:0o555}, `#!/bin/node\n\nrequire('/${stat.name}')\n`)
	pump(fs.createReadStream(location), pack.entry(stat), err=>err||pack.finalize())
	return Promise.resolve(pack)
}

function initFromModule(path) {
	let mod = new Module(path)
	let pack = cpio.pack({format:'newc'})
	let entry = mod.entry()
	let setup = mod.install().then(()=>mod.build())
	let header = Promise.all([entry, setup])
		.then(([entry])=>{
			pack.directory({name:'sbin', mode:0o555})
			pack.file({name:'sbin/init', mode:0o555}, `#!/bin/node\n\nrequire('${entry}')\n`)})
	return (header
		.then(()=>mod.walk(
			(stat, stream)=>stat?
				new Promise((res, rej)=>{
					stat.uid = 0
					stat.gid = 0
					let entry = pack.entry(stat, res)
					pump(stream, entry)
				}).catch(err=>console.error("error",err)):
				pack.finalize()
		))
		.then(()=>pack))
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
	}

	walk(cb) {
		const walker = walk.walk(this.path)
		walker.on('file', (root, stats, next)=>{
			stats.name = this.path + path.relative(this.path, path.resolve(root, stats.name))
			cb(stats, fs.createReadStream(stats.name))
			.then(next)
		})
		walker.on('end', cb)
		return Promise.resolve()
	}
}

if (require.main === module) {
	let target = process.argv[2]
	target = target || './'
	initify(target).then(init=>init.pipe(process.stdout))
} else {
	module.exports = initify
}
