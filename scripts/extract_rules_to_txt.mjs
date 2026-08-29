#!/usr/bin/env node
/**
 * Flatten composed path rulesets to text for GL.iNet-style consumers.
 *
 * Paths match client configs: {entry}-{exit} from the inventory host/peer
 * matrix. Each path writes two files from the entry node's profile (plus host
 * include/exclude/direct/always_direct):
 *
 *   {entry}-{exit}.txt                — include domains, exit dns.local_domains,
 *                                       then include CIDRs
 *   {entry}-{exit}-always-direct.txt  — always_direct domains, then CIDRs
 *
 * Hop vs local-exit is sing-box dest policy, not these files. always_direct
 * is ISP-only on the router and is not mixed into the include catch.
 *
 *   node scripts/extract_rules_to_txt.mjs
 *   node scripts/extract_rules_to_txt.mjs --inventory development
 *   node scripts/extract_rules_to_txt.mjs --self-check
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
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

function txtBody(lines) {
  const uniqueLines = unique(
    lines.filter((item) => typeof item === 'string' && item),
  )
  return uniqueLines.length ? `${uniqueLines.join('\n')}\n` : ''
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
        direct: asStringList(vars.rules?.direct),
        always_direct: asStringList(vars.rules?.always_direct),
        localDomains: asStringList(exitVars.dns?.local_domains),
      })
    }
  }
  return paths
}

export function stalePathTxts(pathInfo, outDir) {
  return [
    join(outDir, `${pathInfo.name}-direct.txt`),
    join(outDir, `${pathInfo.name}-full.txt`),
    join(outDir, `${pathInfo.name}-adguard.txt`),
    join(outDir, `${pathInfo.name}-always_direct.txt`),
  ]
}

export function pathTxts(pathInfo, rulesDir = defaultRulesDir) {
  const composed = composeRules({
    profile: pathInfo.profile,
    include: pathInfo.include,
    exclude: pathInfo.exclude,
    direct: pathInfo.direct,
    always_direct: pathInfo.always_direct,
    rulesDir,
  })
  const outDir = join(rulesDir, 'paths')
  const includeLines = [
    ...composed.domain_suffixes,
    ...pathInfo.localDomains,
    ...composed.advertise_cidrs,
  ]
  const alwaysDirectLines = [
    ...composed.always_direct_domain_suffixes,
    ...composed.always_direct_cidrs,
  ]
  return [
    {
      kind: 'include',
      path: join(outDir, `${pathInfo.name}.txt`),
      count: unique(includeLines.filter(Boolean)).length,
      text: txtBody(includeLines),
    },
    {
      kind: 'always_direct',
      path: join(outDir, `${pathInfo.name}-always-direct.txt`),
      count: unique(alwaysDirectLines.filter(Boolean)).length,
      text: txtBody(alwaysDirectLines),
    },
  ]
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
    for (const path of stalePathTxts(pathInfo, outDir)) {
      if (existsSync(path)) unlinkSync(path)
    }
    for (const result of pathTxts(pathInfo, rulesDir)) {
      writeFileSync(result.path, result.text)
      results.push(result)
    }
  }

  return results
}

function assert(condition, message) {
  if (!condition) throw new Error(`self-check failed: ${message}`)
}

export function selfCheck(rulesDir = defaultRulesDir) {
  const ruTxts = pathTxts(
    {
      name: 'ru-eu',
      profile: 'ru',
      include: [],
      exclude: [],
      direct: [],
      always_direct: [],
      localDomains: ['retn.net'],
    },
    rulesDir,
  )
  assert(ruTxts.length === 2, 'ru path writes two files')
  assert(ruTxts[0].kind === 'include', 'first file is include catch')
  assert(ruTxts[1].kind === 'always_direct', 'second file is always-direct')
  assert(
    ruTxts[0].path.endsWith('ru-eu.txt'),
    'include file has no mode suffix',
  )
  assert(
    ruTxts[1].path.endsWith('ru-eu-always-direct.txt'),
    'always-direct file name',
  )
  assert(ruTxts[0].count > 0, 'ru include catch is non-empty')
  assert(ruTxts[1].count > 0, 'ru always-direct is non-empty')
  assert(
    ruTxts[0].text.includes('retn.net\n'),
    'include catch has exit local_domains',
  )
  assert(
    ruTxts[0].text.includes('youtube.com\n') ||
      ruTxts[0].text.includes('github.com\n'),
    'ru include catch has include domains',
  )
  assert(
    ruTxts[1].text.includes('gosuslugi.ru\n'),
    'always-direct has ru services',
  )

  const nonRuTxts = pathTxts(
    {
      name: 'eu-ru',
      profile: 'non-ru',
      include: [],
      exclude: [],
      direct: [],
      always_direct: [],
      localDomains: [],
    },
    rulesDir,
  )
  assert(nonRuTxts[0].count > 0, 'non-ru include catch is ru domains')
  assert(nonRuTxts[1].count === 0, 'non-ru always-direct is empty')
  assert(nonRuTxts[1].text === '', 'empty always-direct file has no body')

  const outDir = join(rulesDir, 'paths')
  const stale = stalePathTxts({ name: 'ru-eu' }, outDir)
  assert(
    stale.some((path) => path.endsWith('ru-eu-direct.txt')),
    'stale list includes -direct',
  )
  assert(
    stale.some((path) => path.endsWith('ru-eu-full.txt')),
    'stale list includes -full',
  )
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
    if (arg === '--self-check') {
      opts.selfCheck = true
      continue
    }
    if (arg === '-h' || arg === '--help') {
      opts.help = true
      continue
    }
    throw new Error(`unknown argument: ${arg}`)
  }
  if (!opts.selfCheck && !opts.inventory) {
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
        'Usage: node scripts/extract_rules_to_txt.mjs [--inventory <name|path>]\n' +
          '       node scripts/extract_rules_to_txt.mjs --self-check\n',
      )
      process.exit(0)
    }
    if (opts.selfCheck) {
      selfCheck()
      process.stdout.write('ok\n')
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
