#!/bin/env node

const createGzip = require('zlib').createGzip
const exec = require('child_process').exec
const resolve = require('path').resolve

const pack = require('cpio-fs').pack
const fs = require('fs-extra-async')
const withDir = require('tmp-promise').withDir


function mapHeader(header)
{
  if(header.name.split('/')[0] === 'tmp')
  {
    header.uid = 1
    header.gid = 1
  }
  else
  {
    header.uid = 0
    header.gid = 0
  }

  return header
}


function initify(target)
{
  return withDir(function(o)
  {
    let tmpPath = o.path

    return Promise.all(
    [
      jockerAsSbin(tmpPath),
      installModule(target, tmpPath)
    ])
    .then(function()
    {
      return pack(tmpPath, {format: 'newc', map: mapHeader}).pipe(createGzip())
    })
  })
}


function jockerAsSbin(tmpPath)
{
  return run(`npm_config_prefix='${tmpPath}' npm install -g jocker`)
  .then(function()
  {
    return fs.mkdirAsync(resolve(tmpPath, 'sbin'), 0o700)
  })
  .then(function()
  {
    return fs.symlinkAsync('../bin/jocker', resolve(tmpPath, 'sbin/init'))
  })
}

function installModule(target, tmpPath)
{
  let installPath = resolve(tmpPath, 'tmp')

  return fs.mkdirAsync(tmpPath, 0o500)
  .then(function()
  {
    return fs.statAsync(target)
  })
  .then(function(stat)
  {
    return stat.isFile() ? initFromFile : initFromModule
  },
  function(error)
  {
    return initFromNpm
  })
  .then(function(installer)
  {
    return installer(target, installPath)
  })
}


function initFromFile(target, installPath)
{
  let options = {preserveTimestamps: true}

  return fs.copyAsync(target, resolve(installPath, 'init'), options)
}

function initFromModule(target, installPath) {
  let config = require(resolve(target, 'package.json'))

  return run("npm install", target)
  .then(function()
  {
    if(config.scripts && config.scripts.build)
      return run("npm run build", target)
  })
  .then(function()
  {
    let options = {preserveTimestamps: true}

    return fs.copyAsync(target, installPath, options)
  })
  .then(entry(target, installPath, config))
}

function initFromNpm(target, installPath)
{
  let config = require(resolve(target, 'package.json'))

  return run(`npm_config_prefix='${installPath}' npm install -g ${target}`)
  .then(entry(target, installPath, config))
}


function entry(target, installPath, config)
{
  return function()
  {
    let initPath = resolve(installPath, 'init')
    let moduleName = config.name

    // Single binary
    if(config.bin)
    {
      if(typeof config.bin === 'string')
        return fs.symlinkAsync(`bin/${moduleName}`, initPath)

      let binKeys = Object.keys(config.bin)
      if(binKeys.length === 1)
        return fs.symlinkAsync(`bin/${binKeys[0]}`, initPath)
    }

		// It doesn't make too much sense to have defined a `npm start` entry and
		// not a binary besides being able to launch other ones defined on the npm
		// path, but who knows...

    // Explicit `npm start` command
    let scripts = config.scripts
    if(scripts && scripts.start) return npmStart(scripts.start, initPath)

    // Default `npm start` command (`server.js` file)
    let path = `lib/node_modules/${moduleName}/server.js`
    if(fs.accessSync(resolve(installPath, path), fs.constants.X_OK))
      return npmStart(path, initPath)

    // Next entries are malformed because the `main` field nor the `index.js`
    // file should be used as binaries and package maintainers should fix them
    // and use the standard `npm start` command or its default `server.js` file,
    // but we check them too to have a wider compatibility

    // Explicit `main` fields
    let main = config.main
    if(main)
    {
      path = `lib/node_modules/${moduleName}/${main}`
      if(fs.isDirectorySync(resolve(installPath, path)))
        return fs.symlinkAsync(path+`/index.js`, initPath)

      return fs.symlinkAsync(path, initPath)
    }

    // Default `main` fields (`index.js` file)
    path = `lib/node_modules/${moduleName}/index.js`
    if(fs.accessSync(resolve(installPath, path), fs.constants.X_OK))
      return fs.symlinkAsync(path, initPath)

    // Valid command not found on the package, we can't be able to create an
    // auto-bootable `initramfs` image, abort the build process
    throw ValueError('Valid command not found on the package')
  }
}

function npmStart(start, initPath)
{
  return fs.readFileAsync(`${__dirname}/resources/npmStart.js`, 'utf8')
  .then(function(data)
  {
    let npmStart_path =
    [
      `/lib/node_modules/${moduleName}/node_modules/.bin`,
      '/lib/node_modules/.bin'
    ].join(':')

    return fs.writeFileAsync(initPath, eval('`'+data+'`'))
  })
  .then(function()
  {
    return fs.chmodAsync(initPath, 0x500)
  })
}

function run(cmd, dir) {
  return new Promise((res, rej)=>{
    exec(`cd ${dir}; ${cmd}`)
    .on('error', rej)
    .on('exit', code=>code ? rej(code) : res())
  })
}


module.exports = initify
