const path = require('path')
const Module = require('module')

const engineEntry = process.argv[2]
if (!engineEntry) {
  throw new Error('engine entry path is required')
}

const injectedNodeModules = path.join(__dirname, '..', 'node_modules')
process.env.NODE_PATH = [injectedNodeModules, process.env.NODE_PATH || '']
  .filter(Boolean)
  .join(path.delimiter)
Module._initPaths()

require(engineEntry)
