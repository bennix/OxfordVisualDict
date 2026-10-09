const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const IDENTITY = 'Developer ID Application: ZHIPING XU (5N66S29EK2)'
const MACH_O = new Set(['cffaedfe', 'cefaedfe', 'feedfacf', 'feedface'])

function isMachO(file) {
  let fd
  try {
    fd = fs.openSync(file, 'r')
    const buf = Buffer.alloc(12)
    const n = fs.readSync(fd, buf, 0, 12, 0)
    if (n < 4) return false
    if (MACH_O.has(buf.toString('hex', 0, 4))) return true
    if (n < 8) return false
    const magic = buf.readUInt32BE(0)
    const nfat = magic === 0xcafebabe ? buf.readUInt32BE(4) : magic === 0xbebafeca ? buf.readUInt32LE(4) : 0
    return nfat >= 1 && nfat <= 8
  } catch {
    return false
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
}

function isBundleExecutable(file) {
  const parent = path.basename(path.dirname(file))
  if (parent === 'MacOS') return true
  const versionDir = path.dirname(file)
  return path.basename(versionDir) === 'A' && path.basename(path.dirname(versionDir)) === 'Versions'
}

function walk(dir, macho, bundles) {
  let names
  try {
    names = fs.readdirSync(dir)
  } catch {
    return
  }
  for (const name of names) {
    const file = path.join(dir, name)
    let stat
    try {
      stat = fs.lstatSync(file)
    } catch {
      continue
    }
    if (stat.isSymbolicLink()) continue
    if (stat.isDirectory()) {
      if (name.endsWith('.app') || name.endsWith('.framework')) bundles.push(file)
      walk(file, macho, bundles)
      continue
    }
    if (stat.isFile() && isMachO(file) && !isBundleExecutable(file)) macho.push(file)
  }
}

function codesign(file, entitlements) {
  const args = ['--sign', IDENTITY, '--force', '--timestamp', '--options', 'runtime']
  if (entitlements && (file.endsWith('.app') || file.endsWith('.framework'))) {
    args.push('--entitlements', entitlements)
  }
  args.push(file)
  let last
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      execFileSync('codesign', args, { stdio: ['ignore', 'ignore', 'pipe'] })
      return
    } catch (error) {
      last = error
      const stderr = error.stderr ? error.stderr.toString() : ''
      if (!stderr.toLowerCase().includes('timestamp')) throw error
      execFileSync('sleep', [String(attempt + 1)])
    }
  }
  throw last
}

function entitlementsFor(configuration, file) {
  if (typeof configuration.optionsForFile === 'function') {
    const options = configuration.optionsForFile(file)
    if (options && options.entitlements) return options.entitlements
  }
  return file === configuration.app ? configuration.entitlements : configuration.entitlementsInherit
}

module.exports = async function signMac(configuration) {
  const macho = []
  const bundles = []
  walk(configuration.app, macho, bundles)
  bundles.sort((a, b) => b.split(path.sep).length - a.split(path.sep).length)
  process.stdout.write(`signing ${macho.length} binaries and ${bundles.length} bundles\n`)
  for (let index = 0; index < macho.length; index++) {
    codesign(macho[index], null)
    if ((index + 1) % 25 === 0) execFileSync('sleep', ['1'])
    if ((index + 1) % 50 === 0) process.stdout.write(`signed binaries ${index + 1}/${macho.length}\n`)
  }
  for (const bundle of bundles) codesign(bundle, entitlementsFor(configuration, bundle))
  codesign(configuration.app, entitlementsFor(configuration, configuration.app))
}
