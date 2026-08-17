#!/usr/bin/env node
/**
 * Fetch upstream CIDR lists, merge overlapping ranges, and write sing-box
 * source JSON under rules/cidr/. Then refresh profile .txt files.
 *
 *   node scripts/update_cidr_rules.mjs
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { isIP } from 'node:net'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { defaultRulesDir } from './compose_rules.mjs'
import { profileTxt } from './extract_rules_to_txt.mjs'

const userAgent = 'wormhole-cidr-update'
const sourcesPath = join(defaultRulesDir, 'cidr', 'sources.json')

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function asArray(value) {
  if (value == null) return []
  return Array.isArray(value) ? value : [value]
}

function getPath(obj, path) {
  return path.split('.').reduce((cur, key) => cur?.[key], obj)
}

function arinValue(node) {
  if (node == null) return null
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (typeof node === 'object' && '$' in node) return String(node.$)
  return null
}

export function parseCidr(text) {
  const raw = String(text || '').trim()
  if (!raw || raw.startsWith('#') || raw.startsWith(';')) return null
  const slash = raw.lastIndexOf('/')
  const address = slash === -1 ? raw : raw.slice(0, slash)
  const version = isIP(address)
  if (!version) return null
  const bits = version === 6 ? 128 : 32
  const prefix = slash === -1 ? bits : Number.parseInt(raw.slice(slash + 1), 10)
  if (Number.isNaN(prefix) || prefix < 0 || prefix > bits) return null
  return { address, prefix, version, bits }
}

function ipv4ToBigInt(address) {
  const parts = address.split('.').map((part) => Number(part))
  if (
    parts.length !== 4 ||
    parts.some((part) => Number.isNaN(part) || part < 0 || part > 255)
  ) {
    throw new Error(`invalid ipv4: ${address}`)
  }
  return (
    (BigInt(parts[0]) << 24n) |
    (BigInt(parts[1]) << 16n) |
    (BigInt(parts[2]) << 8n) |
    BigInt(parts[3])
  )
}

function expandIpv6Groups(address) {
  let head = address
  let tail = ''
  if (address.includes('.')) {
    const lastColon = address.lastIndexOf(':')
    const v4 = address.slice(lastColon + 1)
    const v4int = ipv4ToBigInt(v4)
    const hi = Number((v4int >> 16n) & 0xffffn).toString(16)
    const lo = Number(v4int & 0xffffn).toString(16)
    head = `${address.slice(0, lastColon)}:${hi}:${lo}`
  }
  if (head.includes('::')) {
    const parts = head.split('::')
    if (parts.length !== 2) throw new Error(`invalid ipv6: ${address}`)
    ;[head, tail] = parts
  }
  const headGroups = head ? head.split(':') : []
  const tailGroups = tail ? tail.split(':') : []
  const missing = 8 - headGroups.length - tailGroups.length
  if (missing < 0) throw new Error(`invalid ipv6: ${address}`)
  return [...headGroups, ...Array(missing).fill('0'), ...tailGroups].map(
    (group) => {
      const value = Number.parseInt(group || '0', 16)
      if (Number.isNaN(value) || value < 0 || value > 0xffff) {
        throw new Error(`invalid ipv6: ${address}`)
      }
      return value
    },
  )
}

function ipv6ToBigInt(address) {
  return expandIpv6Groups(address).reduce(
    (acc, group) => (acc << 16n) | BigInt(group),
    0n,
  )
}

function ipToBigInt(address, version) {
  return version === 6 ? ipv6ToBigInt(address) : ipv4ToBigInt(address)
}

function bigIntToIpv4(value) {
  return [
    Number((value >> 24n) & 255n),
    Number((value >> 16n) & 255n),
    Number((value >> 8n) & 255n),
    Number(value & 255n),
  ].join('.')
}

function bigIntToIpv6(value) {
  const groups = []
  let rest = value
  for (let i = 0; i < 8; i++) {
    groups.unshift(Number(rest & 0xffffn).toString(16))
    rest >>= 16n
  }
  let bestStart = -1
  let bestLen = 0
  let i = 0
  while (i < 8) {
    if (groups[i] !== '0') {
      i++
      continue
    }
    let j = i
    while (j < 8 && groups[j] === '0') j++
    const len = j - i
    if (len > bestLen) {
      bestStart = i
      bestLen = len
    }
    i = j
  }
  if (bestLen < 2) return groups.join(':')
  const head = groups.slice(0, bestStart).join(':')
  const tail = groups.slice(bestStart + bestLen).join(':')
  return `${head}::${tail}`
}

function cidrToRange(cidr) {
  const parsed = typeof cidr === 'string' ? parseCidr(cidr) : cidr
  if (!parsed) return null
  const { address, prefix, version, bits } = parsed
  const ip = ipToBigInt(address, version)
  const hostBits = BigInt(bits - prefix)
  const size = 1n << hostBits
  const mask = size - 1n
  const start = ip & ~mask
  return { version, bits, start, end: start + size - 1n }
}

function rangeToCidrs(start, end, bits) {
  const cidrs = []
  let cursor = start
  while (cursor <= end) {
    let hostBits = 0
    while (hostBits < bits) {
      const size = 1n << BigInt(hostBits + 1)
      if ((cursor & (size - 1n)) !== 0n) break
      if (cursor + size - 1n > end) break
      hostBits++
    }
    const prefix = bits - hostBits
    const address = bits === 32 ? bigIntToIpv4(cursor) : bigIntToIpv6(cursor)
    cidrs.push(`${address}/${prefix}`)
    cursor += 1n << BigInt(hostBits)
  }
  return cidrs
}

export function mergeCidrs(values) {
  const groups = { 4: [], 6: [] }
  for (const value of values) {
    const range = cidrToRange(value)
    if (!range) continue
    groups[range.version].push(range)
  }

  const merged = []
  for (const version of [4, 6]) {
    const ranges = groups[version].sort((a, b) => {
      if (a.start === b.start) return a.end < b.end ? -1 : a.end > b.end ? 1 : 0
      return a.start < b.start ? -1 : 1
    })
    const collapsed = []
    for (const range of ranges) {
      const last = collapsed[collapsed.length - 1]
      if (last && range.start <= last.end + 1n) {
        if (range.end > last.end) last.end = range.end
        continue
      }
      collapsed.push({ ...range })
    }
    for (const range of collapsed) {
      merged.push(...rangeToCidrs(range.start, range.end, range.bits))
    }
  }
  return merged
}

function parseIpRange(text) {
  const raw = String(text || '').trim()
  const dash = raw.split(/\s*-\s*/)
  if (dash.length === 2 && isIP(dash[0]) && isIP(dash[1])) {
    const version = isIP(dash[0])
    if (version !== isIP(dash[1])) return []
    const bits = version === 6 ? 128 : 32
    const start = ipToBigInt(dash[0], version)
    const end = ipToBigInt(dash[1], version)
    if (end < start) return []
    return rangeToCidrs(start, end, bits)
  }
  const parsed = parseCidr(raw)
  return parsed ? [`${parsed.address}/${parsed.prefix}`] : []
}

function collectCidrStrings(value, out = []) {
  if (value == null) return out
  if (typeof value === 'string' || typeof value === 'number') {
    out.push(...parseIpRange(String(value)))
    return out
  }
  if (Array.isArray(value)) {
    for (const item of value) collectCidrStrings(item, out)
    return out
  }
  if (typeof value === 'object') {
    for (const item of Object.values(value)) collectCidrStrings(item, out)
  }
  return out
}

export function extractJsonPaths(payload, paths) {
  const cidrs = []
  for (const path of paths || []) {
    collectCidrStrings(getPath(payload, path), cidrs)
  }
  return cidrs
}

export function extractAwsIpRanges(payload, service) {
  const cidrs = []
  for (const row of payload.prefixes || []) {
    if (row.service === service && row.ip_prefix) cidrs.push(row.ip_prefix)
  }
  for (const row of payload.ipv6_prefixes || []) {
    if (row.service === service && row.ipv6_prefix) cidrs.push(row.ipv6_prefix)
  }
  return cidrs
}

export function extractCidrText(text) {
  const cidrs = []
  for (const line of String(text).split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(';')) continue
    const first = trimmed.split(/[,\s]/)[0]
    cidrs.push(...parseIpRange(first))
  }
  return cidrs
}

function extractArinNet(node, cidrs) {
  const cidrLength =
    arinValue(node?.cidrLength) ||
    arinValue(node?.netBlocks?.netBlock?.cidrLength)
  const start =
    arinValue(node?.startAddress) ||
    arinValue(node?.['@startAddress']) ||
    arinValue(node?.netBlocks?.netBlock?.startAddress)
  const end = arinValue(node?.endAddress) || arinValue(node?.['@endAddress'])
  if (start && cidrLength) {
    cidrs.push(...parseIpRange(`${start}/${cidrLength}`))
    return
  }
  if (start && end) {
    cidrs.push(...parseIpRange(`${start} - ${end}`))
    return
  }
  for (const block of asArray(node?.netBlocks?.netBlock)) {
    extractArinNet(block, cidrs)
  }
}

export function extractArinOrg(payload) {
  const cidrs = []
  const nets = payload?.nets || payload
  for (const net of asArray(nets?.net)) extractArinNet(net, cidrs)
  for (const net of asArray(nets?.netRef)) extractArinNet(net, cidrs)
  if (!cidrs.length) collectCidrStrings(payload, cidrs)
  return cidrs
}

function ripeAttr(object, name) {
  const attrs = object?.attributes?.attribute || object?.attribute || []
  for (const attr of asArray(attrs)) {
    if (attr.name === name || attr['@name'] === name) {
      return attr.value || attr['@value'] || arinValue(attr)
    }
  }
  return null
}

export function extractRipeOrg(payload) {
  const cidrs = []
  const objects = payload?.objects?.object || payload?.object || []
  for (const object of asArray(objects)) {
    const type = object.type || object['@type']
    if (type === 'inetnum') {
      cidrs.push(...parseIpRange(ripeAttr(object, 'inetnum')))
    } else if (type === 'inet6num') {
      cidrs.push(...parseIpRange(ripeAttr(object, 'inet6num')))
    }
  }
  if (!cidrs.length) collectCidrStrings(payload, cidrs)
  return cidrs
}

const documentationCidrs = [
  '192.0.2.0/24',
  '198.51.100.0/24',
  '203.0.113.0/24',
  '2001:2::/48',
  '2001:10::/28',
  '2001:db8::/32',
  '2002::/16',
]

function isDocumentationCidr(cidr) {
  const range = cidrToRange(cidr)
  if (!range) return true
  return documentationCidrs.some((doc) => {
    const docRange = cidrToRange(doc)
    return (
      docRange &&
      range.version === docRange.version &&
      range.start >= docRange.start &&
      range.end <= docRange.end
    )
  })
}

export function extractVultrGeofeed(payload) {
  const cidrs = []
  const rows = Array.isArray(payload)
    ? payload
    : payload?.prefixes || payload?.subnets || payload?.data || []
  for (const row of asArray(rows)) {
    if (typeof row === 'string') {
      cidrs.push(...parseIpRange(row.split(/[,\s]/)[0]))
      continue
    }
    const subnet =
      row?.subnet || row?.ip_prefix || row?.prefix || row?.cidr || row?.ip
    if (subnet) cidrs.push(...parseIpRange(String(subnet)))
  }
  const extracted =
    !cidrs.length && typeof payload === 'string'
      ? extractCidrText(payload)
      : cidrs
  return extracted.filter((cidr) => !isDocumentationCidr(cidr))
}

const fetchCache = new Map()

async function fetchBody(url, extraHeaders = {}) {
  if (fetchCache.has(url)) return fetchCache.get(url)
  const response = await fetch(url, {
    headers: {
      'User-Agent': userAgent,
      Accept: 'application/json, text/plain, */*',
      ...extraHeaders,
    },
  })
  if (!response.ok) {
    throw new Error(`${url}: HTTP ${response.status}`)
  }
  const body = await response.text()
  fetchCache.set(url, body)
  return body
}

function parseMaybeJson(text) {
  const trimmed = text.trim()
  if (!trimmed) return trimmed
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return JSON.parse(trimmed)
  }
  return trimmed
}

async function extractSet(entry) {
  const source = entry.source
  if (source === 'json-paths') {
    const payload = JSON.parse(await fetchBody(entry.url))
    return extractJsonPaths(payload, entry.paths)
  }
  if (source === 'aws-ip-ranges') {
    const payload = JSON.parse(await fetchBody(entry.url))
    return extractAwsIpRanges(payload, entry.service)
  }
  if (source === 'cidr-text') {
    return extractCidrText(await fetchBody(entry.url))
  }
  if (source === 'arin-org') {
    const body = await fetchBody(entry.url, { Accept: 'application/json' })
    let payload
    try {
      payload = JSON.parse(body)
    } catch {
      const jsonUrl = entry.url.endsWith('.json')
        ? entry.url
        : `${entry.url}.json`
      payload = JSON.parse(
        await fetchBody(jsonUrl, { Accept: 'application/json' }),
      )
    }
    return extractArinOrg(payload)
  }
  if (source === 'ripe-org') {
    const payload = JSON.parse(await fetchBody(entry.url))
    return extractRipeOrg(payload)
  }
  if (source === 'vultr-geofeed') {
    const body = parseMaybeJson(await fetchBody(entry.url))
    let cidrs =
      typeof body === 'string'
        ? extractCidrText(body)
        : extractVultrGeofeed(body)
    if (!cidrs.length && entry.url.includes('?json')) {
      const fallback = entry.url.replace(/\?json.*/, '?text')
      cidrs = extractCidrText(await fetchBody(fallback))
    }
    return cidrs
  }
  throw new Error(`unknown source type: ${source}`)
}

function existingCount(path) {
  if (!existsSync(path)) return 0
  try {
    const payload = readJson(path)
    return (payload.rules || []).reduce(
      (sum, rule) => sum + (rule.ip_cidr || []).length,
      0,
    )
  } catch {
    return 0
  }
}

export async function updateCidrRules({
  rulesDir = defaultRulesDir,
  sourcesFile = sourcesPath,
} = {}) {
  const config = readJson(sourcesFile)
  const sets = config.sets || []
  if (!sets.length) throw new Error('no sets in sources.json')

  const summaries = []
  for (const entry of sets) {
    if (!entry.path) throw new Error('set is missing path')
    const extracted = await extractSet(entry)
    const merged = mergeCidrs(extracted)
    if (!merged.length) {
      throw new Error(`${entry.path}: upstream returned 0 prefixes`)
    }
    const outPath = join(rulesDir, 'cidr', `${entry.path}.json`)
    const before = existingCount(outPath)
    mkdirSync(dirname(outPath), { recursive: true })
    writeFileSync(
      outPath,
      `${JSON.stringify({ version: 4, rules: [{ ip_cidr: merged }] }, null, 2)}\n`,
    )
    summaries.push({
      path: entry.path,
      before,
      after: merged.length,
    })
    process.stdout.write(
      `${entry.path}: ${before} → ${merged.length} prefixes\n`,
    )
  }

  for (const profile of ['ru', 'non-ru']) {
    const { path, count, text } = profileTxt(profile, rulesDir)
    writeFileSync(path, text)
    process.stdout.write(`Wrote ${count} entries to profiles/${profile}.txt\n`)
  }

  return summaries
}

function isCli() {
  const entry = process.argv[1]
  if (!entry) return false
  return import.meta.url === pathToFileURL(entry).href
}

if (isCli()) {
  try {
    await updateCidrRules()
  } catch (err) {
    console.error(`error: ${err.message}`)
    process.exit(1)
  }
}
