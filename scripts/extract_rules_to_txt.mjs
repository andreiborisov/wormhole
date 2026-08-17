#!/usr/bin/env node
/**
 * Flatten composed path rulesets to text for GL.iNet-style consumers.
 *
 * Paths match client configs: {entry}-{exit} from the inventory host/peer
 * matrix. Each file is the entry node's profile (plus host include/exclude)
 * with the exit node's dns.local_domains appended as domain suffixes.
 *
 *   node scripts/extract_rules_to_txt.mjs
 *   node scripts/extract_rules_to_txt.mjs --inventory development
 *
 * Writes rules/paths/<entry>-<exit>.txt (domain suffixes, then CIDRs).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parse as parseYaml } from 'yaml'
import { composeRules, defaultRulesDir } from './compose_rules.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')
export const defaultInventoryName = 'production'

function unique(values) {
  return [...new Set(values)]
}

function asStringList(value) {
  if (!Array.isArray(value)) return []
  return value.filter((item) => typeof item === 'string' && item)
}

export function resolveInventoryFile(inventory, cwd = process.cwd()) {
  if (!inventory) {
    throw new Error('inventory is required')
  }
  if (existsSync(inventory)) {
    return isAbsolute(inventory) ? inventory : join(cwd, inventory)
  }
  return join(root, 'ansible', 'inventories', inventory, 'hosts.local.yml')
}

export function loadInventoryHosts(inventoryFile) {
  if (!existsSync(inventoryFile)) {
    throw new Error(`inventory not found: ${inventoryFile}`)
  }
  const doc = parseYaml(readFileSync(inventoryFile, 'utf8'))
  const hosts = doc?.all?.hosts
  if (!hosts || typeof hosts !== 'object' || Array.isArray(hosts)) {
    throw new Error(`no hosts in ${inventoryFile}`)
  }
  return hosts
}

export function inventoryPaths(inventoryFile) {
  const hosts = loadInventoryHosts(inventoryFile)
  const paths = []
  for (const [entry, vars] of Object.entries(hosts)) {
    if (!vars || typeof vars !== 'object') continue
    const peers = asStringList(vars.peers)
    const profile = vars.rules?.profile
    for (const exit of peers) {
      const exitVars = hosts[exit]
      if (!exitVars || typeof exitVars !== 'object') {
        throw new Error(`path ${entry}-${exit}: unknown exit host ${exit}`)
      }
      if (!profile) {
        throw new Error(
          `path ${entry}-${exit}: ${entry} is missing rules.profile`,
        )
      }
      paths.push({
        name: `${entry}-${exit}`,
        entry,
        exit,
        profile,
        include: asStringList(vars.rules?.include),
        exclude: asStringList(vars.rules?.exclude),
        localDomains: asStringList(exitVars.dns?.local_domains),
      })
    }
  }
  return paths
}

export function pathTxt(pathInfo, rulesDir = defaultRulesDir) {
  const composed = composeRules({
    profile: pathInfo.profile,
    include: pathInfo.include,
    exclude: pathInfo.exclude,
    rulesDir,
  })
  const lines = unique([
    ...composed.domain_suffixes,
    ...pathInfo.localDomains,
    ...composed.advertise_cidrs,
  ])
  return {
    path: join(rulesDir, 'paths', `${pathInfo.name}.txt`),
    count: lines.length,
    text: lines.length ? `${lines.join('\n')}\n` : '',
  }
}

export function writePathTxts({
  inventory = defaultInventoryName,
  rulesDir = defaultRulesDir,
  cwd = process.cwd(),
} = {}) {
  const inventoryFile = resolveInventoryFile(inventory, cwd)
  const paths = inventoryPaths(inventoryFile)
  if (!paths.length) {
    throw new Error(`no entry-exit paths in ${inventoryFile}`)
  }

  const outDir = join(rulesDir, 'paths')
  mkdirSync(outDir, { recursive: true })

  const results = []
  for (const pathInfo of paths) {
    const result = pathTxt(pathInfo, rulesDir)
    writeFileSync(result.path, result.text)
    results.push(result)
  }

  return results
}

function parseArgs(argv) {
  const opts = { inventory: defaultInventoryName }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--inventory' || arg.startsWith('--inventory=')) {
      opts.inventory = arg.includes('=')
        ? arg.slice('--inventory='.length)
        : argv[++i]
      continue
    }
    if (arg === '-h' || arg === '--help') {
      opts.help = true
      continue
    }
    throw new Error(`unknown argument: ${arg}`)
  }
  if (!opts.inventory) {
    throw new Error('inventory is required')
  }
  return opts
}

function isCli() {
  const entry = process.argv[1]
  if (!entry) return false
  return import.meta.url === pathToFileURL(entry).href
}

if (isCli()) {
  try {
    const opts = parseArgs(process.argv.slice(2))
    if (opts.help) {
      process.stdout.write(
        'Usage: node scripts/extract_rules_to_txt.mjs [--inventory <name|path>]\n',
      )
      process.exit(0)
    }
    const results = writePathTxts({ inventory: opts.inventory })
    for (const { path, count } of results) {
      const rel = path.startsWith(defaultRulesDir)
        ? path.slice(defaultRulesDir.length + 1)
        : path
      process.stdout.write(`Wrote ${count} entries to ${rel}\n`)
    }
  } catch (err) {
    console.error(`error: ${err.message}`)
    process.exit(1)
  }
}
