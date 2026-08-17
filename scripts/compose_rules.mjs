#!/usr/bin/env node
/**
 * Compose named rule sets for a profile.
 *
 * Set names are paths under rules/domain/ and rules/cidr/ without .json.
 * A selector matches that path and everything nested under it, on both trees.
 *
 *   node scripts/compose_rules.mjs --profile ru
 *   node scripts/compose_rules.mjs --profile ru --include ru --exclude international/social
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
export const defaultRulesDir = join(__dirname, '..', 'rules')

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function unique(values) {
  return [...new Set(values)]
}

function matchesSelector(key, selector) {
  return key === selector || key.startsWith(`${selector}/`)
}

function walkKind(absDir, kind) {
  const map = {}
  if (!existsSync(absDir)) return map

  function walk(dir, relKey) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue
      const childRel = relKey ? `${relKey}/${entry.name}` : entry.name
      const childAbs = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(childAbs, childRel)
        continue
      }
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue
      const key = childRel.slice(0, -'.json'.length)
      if (map[key]) {
        throw new Error(`duplicate ${kind} set: ${key}`)
      }
      map[key] = `${kind}/${childRel}`
    }
  }

  walk(absDir, '')
  return map
}

export function loadCatalog(rulesDir = defaultRulesDir) {
  const domainFiles = walkKind(join(rulesDir, 'domain'), 'domain')
  const cidrFiles = walkKind(join(rulesDir, 'cidr'), 'cidr')
  const catalog = {}
  for (const key of unique([
    ...Object.keys(domainFiles),
    ...Object.keys(cidrFiles),
  ]).sort()) {
    catalog[key] = {
      domain: domainFiles[key] || null,
      cidr: cidrFiles[key] || null,
    }
  }
  return catalog
}

export function loadProfile(name, rulesDir = defaultRulesDir) {
  const path = join(rulesDir, 'profiles', `${name}.json`)
  try {
    return readJson(path)
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      throw new Error(`unknown profile: ${name}`)
    }
    throw err
  }
}

export function collectFromSetFile(path) {
  const payload = readJson(path)
  const suffixes = []
  const cidrs = []
  for (const rule of payload.rules || []) {
    if (!rule || typeof rule !== 'object') continue
    for (const item of rule.domain_suffix || []) {
      if (typeof item === 'string') suffixes.push(item)
    }
    for (const item of rule.domain || []) {
      if (typeof item === 'string') suffixes.push(item)
    }
    for (const item of rule.ip_cidr || []) {
      if (typeof item === 'string') cidrs.push(item)
    }
  }
  return { suffixes, cidrs }
}

export function expandSelectors(selectors, catalog) {
  const catalogKeys = Object.keys(catalog)
  const keys = []
  for (const selector of selectors) {
    if (!selector) continue
    const matched = catalogKeys.filter((key) => matchesSelector(key, selector))
    if (matched.length === 0) {
      throw new Error(`unknown rule set: ${selector}`)
    }
    keys.push(...matched)
  }
  return unique(keys).sort()
}

export function composeRules({
  rulesDir = defaultRulesDir,
  profile: profileName,
  include = [],
  exclude = [],
} = {}) {
  if (!profileName) {
    throw new Error('profile is required')
  }

  const catalog = loadCatalog(rulesDir)
  const profile = loadProfile(profileName, rulesDir)
  const included = expandSelectors(
    unique([...(profile.include || []), ...include]),
    catalog,
  )
  const excludeSelectors = unique([...(profile.exclude || []), ...exclude])
  const dropped = new Set(
    excludeSelectors.length ? expandSelectors(excludeSelectors, catalog) : [],
  )
  const names = included.filter((name) => !dropped.has(name))

  const domain_sets = []
  const advertise_cidrs = []
  const domain_suffixes = []

  for (const name of names) {
    const entry = catalog[name]
    if (entry.domain) {
      const path = join(rulesDir, entry.domain)
      const collected = collectFromSetFile(path)
      domain_sets.push({
        name,
        path: entry.domain,
        url_suffix: entry.domain,
      })
      domain_suffixes.push(...collected.suffixes)
    }
    if (entry.cidr) {
      const path = join(rulesDir, entry.cidr)
      advertise_cidrs.push(...collectFromSetFile(path).cidrs)
    }
  }

  return {
    profile: profileName,
    names,
    domain_sets,
    advertise_cidrs: unique(advertise_cidrs),
    domain_suffixes: unique(domain_suffixes),
  }
}

function parseArgs(argv) {
  const opts = { profile: null, include: [], exclude: [] }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--profile' || arg.startsWith('--profile=')) {
      opts.profile = arg.includes('=')
        ? arg.slice('--profile='.length)
        : argv[++i]
      continue
    }
    if (arg === '--include' || arg.startsWith('--include=')) {
      const value = arg.includes('=')
        ? arg.slice('--include='.length)
        : argv[++i]
      if (value) opts.include.push(value)
      continue
    }
    if (arg === '--exclude' || arg.startsWith('--exclude=')) {
      const value = arg.includes('=')
        ? arg.slice('--exclude='.length)
        : argv[++i]
      if (value) opts.exclude.push(value)
      continue
    }
    if (arg === '-h' || arg === '--help') {
      opts.help = true
      continue
    }
    throw new Error(`unknown argument: ${arg}`)
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
    if (opts.help || !opts.profile) {
      process.stdout.write(
        'Usage: node scripts/compose_rules.mjs --profile <ru|non-ru> [--include path] [--exclude path]\n',
      )
      process.exit(opts.help ? 0 : 1)
    }
    const composed = composeRules({
      profile: opts.profile,
      include: opts.include,
      exclude: opts.exclude,
    })
    process.stdout.write(`${JSON.stringify(composed)}\n`)
  } catch (err) {
    console.error(`error: ${err.message}`)
    process.exit(1)
  }
}
