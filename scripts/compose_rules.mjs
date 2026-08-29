#!/usr/bin/env node
/**
 * Compose named rule sets for a profile.
 *
 * Set names are paths under rules/domain/ and rules/cidr/ without .json.
 * A selector matches that path and everything nested under it, on both trees.
 *
 *   node scripts/compose_rules.mjs --profile ru
 *   node scripts/compose_rules.mjs --profile ru --include ru --exclude international/social
 *   node scripts/compose_rules.mjs --profile ru --write-ruleset /tmp/profile.json
 *   node scripts/compose_rules.mjs --profile ru --write-include-ruleset /tmp/include.json --write-direct-ruleset /tmp/direct.json
 *   node scripts/compose_rules.mjs --self-check
 */
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
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
      if (entry.name === 'sources.json') continue
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

function collectNamedSets(names, catalog, rulesDir) {
  const domain_sets = []
  const advertise_cidrs = []
  const domain_suffixes = []

  for (const name of names) {
    const entry = catalog[name]
    if (!entry) continue
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
    names,
    domain_sets,
    advertise_cidrs: unique(advertise_cidrs),
    domain_suffixes: unique(domain_suffixes),
  }
}

export function composeRules({
  rulesDir = defaultRulesDir,
  profile: profileName,
  include = [],
  exclude = [],
  direct = [],
  always_direct = [],
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
  const nameSet = new Set(names)

  const directSelectors = unique([...(profile.direct || []), ...direct])
  const direct_names = directSelectors.length
    ? expandSelectors(directSelectors, catalog).filter(
        (name) => !dropped.has(name),
      )
    : []
  for (const name of direct_names) {
    if (!nameSet.has(name)) {
      throw new Error(`direct set not in include: ${name}`)
    }
  }

  const alwaysSelectors = unique([
    ...(profile.always_direct || []),
    ...always_direct,
  ])
  const always_direct_names = alwaysSelectors.length
    ? expandSelectors(alwaysSelectors, catalog)
    : []
  for (const name of always_direct_names) {
    if (nameSet.has(name)) {
      throw new Error(`always_direct overlaps include: ${name}`)
    }
  }

  const hop_names = names.filter((name) => !direct_names.includes(name))

  const includedSets = collectNamedSets(names, catalog, rulesDir)
  const directSets = collectNamedSets(direct_names, catalog, rulesDir)
  const hopSets = collectNamedSets(hop_names, catalog, rulesDir)
  const alwaysSets = collectNamedSets(always_direct_names, catalog, rulesDir)

  return {
    profile: profileName,
    names,
    direct_names,
    hop_names,
    always_direct_names,
    domain_sets: includedSets.domain_sets,
    advertise_cidrs: includedSets.advertise_cidrs,
    domain_suffixes: includedSets.domain_suffixes,
    direct_domain_suffixes: directSets.domain_suffixes,
    direct_cidrs: directSets.advertise_cidrs,
    hop_domain_suffixes: hopSets.domain_suffixes,
    hop_cidrs: hopSets.advertise_cidrs,
    always_direct_domain_suffixes: alwaysSets.domain_suffixes,
    always_direct_cidrs: alwaysSets.advertise_cidrs,
  }
}

export function profileRuleSet(composed) {
  const suffixes = composed.domain_suffixes || []
  return {
    version: 4,
    rules: suffixes.length ? [{ domain_suffix: suffixes }] : [],
  }
}

export function destRuleSet(suffixes = [], cidrs = []) {
  const rules = []
  if (suffixes.length) rules.push({ domain_suffix: suffixes })
  if (cidrs.length) rules.push({ ip_cidr: cidrs })
  return {
    version: 4,
    rules,
  }
}

export function includeRuleSet(composed) {
  return destRuleSet(
    composed.domain_suffixes || [],
    composed.advertise_cidrs || [],
  )
}

export function directRuleSet(composed) {
  return destRuleSet(
    composed.direct_domain_suffixes || [],
    composed.direct_cidrs || [],
  )
}

export function hopRuleSet(composed) {
  return destRuleSet(
    composed.hop_domain_suffixes || [],
    composed.hop_cidrs || [],
  )
}

export function alwaysDirectRuleSet(composed) {
  return destRuleSet(
    composed.always_direct_domain_suffixes || [],
    composed.always_direct_cidrs || [],
  )
}

function assert(condition, message) {
  if (!condition) throw new Error(`self-check failed: ${message}`)
}

export function selfCheck(rulesDir = defaultRulesDir) {
  const ru = composeRules({ profile: 'ru', rulesDir })
  const includeSet = new Set(ru.names)
  for (const name of ru.direct_names) {
    assert(includeSet.has(name), `ru direct not in include: ${name}`)
  }
  for (const name of ru.always_direct_names) {
    assert(!includeSet.has(name), `ru always_direct in include: ${name}`)
  }
  assert(
    JSON.stringify(ru.hop_names) ===
      JSON.stringify(
        ru.names.filter((name) => !ru.direct_names.includes(name)),
      ),
    'ru hop is include minus direct',
  )
  assert(ru.always_direct_names.length > 0, 'ru profile has always_direct sets')
  assert(ru.direct_names.length > 0, 'ru profile has direct sets')
  assert(ru.hop_names.length > 0, 'ru profile has hop sets')

  const nonRu = composeRules({ profile: 'non-ru', rulesDir })
  assert(nonRu.direct_names.length === 0, 'non-ru direct is empty')
  assert(
    nonRu.always_direct_names.length === 0,
    'non-ru always_direct is empty',
  )
  assert(
    JSON.stringify(nonRu.hop_names) === JSON.stringify(nonRu.names),
    'non-ru hop equals include when direct is empty',
  )

  let overlapFailed = false
  try {
    composeRules({
      profile: 'ru',
      always_direct: ['international'],
      rulesDir,
    })
  } catch (err) {
    overlapFailed = /always_direct overlaps include/.test(err.message)
  }
  assert(overlapFailed, 'always_direct overlapping include must fail')

  let directOutsideFailed = false
  try {
    composeRules({
      profile: 'non-ru',
      direct: ['international'],
      rulesDir,
    })
  } catch (err) {
    directOutsideFailed = /direct set not in include/.test(err.message)
  }
  assert(directOutsideFailed, 'direct outside include must fail')

  const hopJson = hopRuleSet(ru)
  assert(hopJson.version === 4, 'hop ruleset version')
  assert(Array.isArray(hopJson.rules), 'hop ruleset has rules')
  const alwaysJson = alwaysDirectRuleSet(ru)
  assert(
    (alwaysJson.rules[0]?.domain_suffix || []).length > 0,
    'always_direct ruleset has domains',
  )

  const mixed = destRuleSet(['example.com'], ['1.1.1.0/24'])
  assert(mixed.rules.length === 2, 'dest ruleset ORs domain and cidr')
  assert(
    mixed.rules[0].domain_suffix && !mixed.rules[0].ip_cidr,
    'first dest rule is domain-only',
  )
  assert(
    mixed.rules[1].ip_cidr && !mixed.rules[1].domain_suffix,
    'second dest rule is cidr-only',
  )
  const includeJson = includeRuleSet(ru)
  assert(
    includeJson.rules.length === 2,
    'ru include dest has domains and cidrs',
  )
  const directJson = directRuleSet(ru)
  assert(directJson.rules.length === 2, 'ru direct dest has domains and cidrs')
  assert(
    (directJson.rules.find((rule) => rule.ip_cidr) || {}).ip_cidr?.length > 0,
    'ru direct dest has CIDRs',
  )
  const nonRuInclude = includeRuleSet(nonRu)
  assert(
    (nonRuInclude.rules[0]?.domain_suffix || []).length > 0,
    'non-ru include dest has domains',
  )
  assert(directRuleSet(nonRu).rules.length === 0, 'non-ru direct dest is empty')

  const emptyHop = destRuleSet([], [])
  assert(emptyHop.rules.length === 0, 'empty dest ruleset has no rules')

  const tmp = mkdtempSync(join(tmpdir(), 'wormhole-compose-'))
  const catalogPath = join(tmp, 'profile.json')
  writeFileSync(catalogPath, `${JSON.stringify(profileRuleSet(ru), null, 2)}\n`)
  const roundTrip = readJson(catalogPath)
  assert(
    JSON.stringify(roundTrip) === JSON.stringify(profileRuleSet(ru)),
    'profile ruleset round-trip',
  )
}

function takeArg(arg, prefix, argv, i) {
  if (arg.includes('=')) return { value: arg.slice(`${prefix}=`.length), i }
  return { value: argv[i + 1], i: i + 1 }
}

function parseArgs(argv) {
  const opts = {
    profile: null,
    include: [],
    exclude: [],
    direct: [],
    always_direct: [],
    writeRuleset: null,
    writeIncludeRuleset: null,
    writeDirectRuleset: null,
    writeAlwaysDirectRuleset: null,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--profile' || arg.startsWith('--profile=')) {
      const taken = takeArg(arg, '--profile', argv, i)
      opts.profile = taken.value
      i = taken.i
      continue
    }
    if (arg === '--write-ruleset' || arg.startsWith('--write-ruleset=')) {
      const taken = takeArg(arg, '--write-ruleset', argv, i)
      opts.writeRuleset = taken.value
      i = taken.i
      continue
    }
    if (
      arg === '--write-include-ruleset' ||
      arg.startsWith('--write-include-ruleset=')
    ) {
      const taken = takeArg(arg, '--write-include-ruleset', argv, i)
      opts.writeIncludeRuleset = taken.value
      i = taken.i
      continue
    }
    if (
      arg === '--write-direct-ruleset' ||
      arg.startsWith('--write-direct-ruleset=')
    ) {
      const taken = takeArg(arg, '--write-direct-ruleset', argv, i)
      opts.writeDirectRuleset = taken.value
      i = taken.i
      continue
    }
    if (
      arg === '--write-always-direct-ruleset' ||
      arg.startsWith('--write-always-direct-ruleset=')
    ) {
      const taken = takeArg(arg, '--write-always-direct-ruleset', argv, i)
      opts.writeAlwaysDirectRuleset = taken.value
      i = taken.i
      continue
    }
    if (arg === '--include' || arg.startsWith('--include=')) {
      const taken = takeArg(arg, '--include', argv, i)
      if (taken.value) opts.include.push(taken.value)
      i = taken.i
      continue
    }
    if (arg === '--exclude' || arg.startsWith('--exclude=')) {
      const taken = takeArg(arg, '--exclude', argv, i)
      if (taken.value) opts.exclude.push(taken.value)
      i = taken.i
      continue
    }
    if (arg === '--direct' || arg.startsWith('--direct=')) {
      const taken = takeArg(arg, '--direct', argv, i)
      if (taken.value) opts.direct.push(taken.value)
      i = taken.i
      continue
    }
    if (arg === '--always-direct' || arg.startsWith('--always-direct=')) {
      const taken = takeArg(arg, '--always-direct', argv, i)
      if (taken.value) opts.always_direct.push(taken.value)
      i = taken.i
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
  return opts
}

function isCli() {
  const entry = process.argv[1]
  if (!entry) return false
  return import.meta.url === pathToFileURL(entry).href
}

const USAGE =
  'Usage: node scripts/compose_rules.mjs --profile <ru|non-ru> [--include path] [--exclude path] [--direct path] [--always-direct path] [--write-ruleset path] [--write-include-ruleset path] [--write-direct-ruleset path] [--write-always-direct-ruleset path]\n' +
  '       node scripts/compose_rules.mjs --self-check\n'

if (isCli()) {
  try {
    const opts = parseArgs(process.argv.slice(2))
    if (opts.selfCheck) {
      selfCheck()
      process.stdout.write('ok\n')
      process.exit(0)
    }
    if (opts.help || !opts.profile) {
      process.stdout.write(USAGE)
      process.exit(opts.help ? 0 : 1)
    }
    const composed = composeRules({
      profile: opts.profile,
      include: opts.include,
      exclude: opts.exclude,
      direct: opts.direct,
      always_direct: opts.always_direct,
    })
    if (opts.writeRuleset) {
      writeFileSync(
        opts.writeRuleset,
        `${JSON.stringify(profileRuleSet(composed), null, 2)}\n`,
      )
    }
    if (opts.writeIncludeRuleset) {
      writeFileSync(
        opts.writeIncludeRuleset,
        `${JSON.stringify(includeRuleSet(composed), null, 2)}\n`,
      )
    }
    if (opts.writeDirectRuleset) {
      writeFileSync(
        opts.writeDirectRuleset,
        `${JSON.stringify(directRuleSet(composed), null, 2)}\n`,
      )
    }
    if (opts.writeAlwaysDirectRuleset) {
      writeFileSync(
        opts.writeAlwaysDirectRuleset,
        `${JSON.stringify(alwaysDirectRuleSet(composed), null, 2)}\n`,
      )
    }
    process.stdout.write(`${JSON.stringify(composed)}\n`)
  } catch (err) {
    console.error(`error: ${err.message}`)
    process.exit(1)
  }
}
