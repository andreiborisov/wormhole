#!/usr/bin/env node
/**
 * Deterministic VPN subnet and client-IP assignment.
 *
 *   node scripts/assign_vpn_addresses.mjs subnets < payload.json
 *   node scripts/assign_vpn_addresses.mjs client-ips < payload.json
 *   node scripts/assign_vpn_addresses.mjs --self-check
 *
 * Subnet seed: "{inventory}|{hostname}|{kind}"
 * Client IP seed: profile_name (occupancy resolved in sorted-name order per subnet)
 */
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'

export const DEFAULT_POOL = '10.0.0.0/8'
export const DEFAULT_PREFIX = 24
export const DEFAULT_KINDS = ['awg', 'wg']

/** Always skipped, even if the inventory reserved list is empty. */
export const INTERNAL_RESERVED = [
  '198.18.0.0/15', // sing-box FakeIP
  '100.64.0.0/10', // Tailscale / CGNAT
  '172.19.0.0/16', // sing-box TUN
]

/** Host IDs never assigned to a client (.0 network, .1 server, .53 DNS, last broadcast). */
const RESERVED_HOST_IDS = new Set([0, 1, 53])

export function parseIpv4(ip) {
  const parts = String(ip).split('.').map((p) => Number(p))
  if (
    parts.length !== 4 ||
    parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)
  ) {
    throw new Error(`invalid IPv4 address: ${ip}`)
  }
  return (
    ((parts[0] << 24) >>> 0) +
    ((parts[1] << 16) >>> 0) +
    ((parts[2] << 8) >>> 0) +
    (parts[3] >>> 0)
  )
}

export function formatIpv4(n) {
  const x = n >>> 0
  return `${(x >>> 24) & 255}.${(x >>> 16) & 255}.${(x >>> 8) & 255}.${x & 255}`
}

export function parseCidr(cidr) {
  const text = String(cidr).trim()
  const slash = text.lastIndexOf('/')
  if (slash < 0) throw new Error(`invalid CIDR: ${cidr}`)
  const prefix = Number(text.slice(slash + 1))
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
    throw new Error(`invalid CIDR prefix: ${cidr}`)
  }
  const addr = parseIpv4(text.slice(0, slash))
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0
  const network = (addr & mask) >>> 0
  return {
    cidr: `${formatIpv4(network)}/${prefix}`,
    prefix,
    mask,
    network,
    size: 2 ** (32 - prefix),
  }
}

export function cidrsOverlap(a, b) {
  const mask = a.prefix < b.prefix ? a.mask : b.mask
  return ((a.network & mask) >>> 0) === ((b.network & mask) >>> 0)
}

export function digest(seed) {
  return createHash('sha256').update(String(seed), 'utf8').digest().readBigUInt64BE(0)
}

function usableHostIds(numAddresses) {
  const ids = []
  for (let i = 0; i < numAddresses; i++) {
    if (i === numAddresses - 1 || RESERVED_HOST_IDS.has(i)) continue
    ids.push(i)
  }
  if (ids.length === 0) {
    throw new Error(`no usable host addresses in a ${numAddresses}-address subnet`)
  }
  return ids
}

export function pickSubnet(inventory, hostname, kind, pool, prefix, reservedNets) {
  const poolNet = typeof pool === 'string' ? parseCidr(pool) : pool
  if (poolNet.prefix > prefix) {
    throw new Error(
      `pool prefix ${poolNet.prefix} is longer than subnet prefix ${prefix}`,
    )
  }
  const count = 2 ** (prefix - poolNet.prefix)
  const step = 2 ** (32 - prefix)
  const seed = `${inventory}|${hostname}|${kind}`
  const start = Number(digest(seed) % BigInt(count))
  const subnetMask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0

  for (let i = 0; i < count; i++) {
    const idx = (start + i) % count
    const network = (poolNet.network + idx * step) >>> 0
    const candidate = {
      cidr: `${formatIpv4(network)}/${prefix}`,
      prefix,
      mask: subnetMask,
      network,
    }
    if (reservedNets.some((r) => cidrsOverlap(candidate, r))) continue
    return candidate.cidr
  }
  throw new Error(`no available /${prefix} in ${poolNet.cidr} for ${seed}`)
}

export function assignSubnets(input) {
  const inventory = input?.inventory
  if (!inventory) throw new Error('inventory is required')
  const pool = input.pool || DEFAULT_POOL
  const prefix = Number(input.prefix ?? DEFAULT_PREFIX)
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
    throw new Error(`invalid prefix: ${input.prefix}`)
  }
  const reservedNets = [
    ...INTERNAL_RESERVED,
    ...(input.reserved || []),
  ].map(parseCidr)
  const hosts = input.hosts
  if (!Array.isArray(hosts) || hosts.length === 0) {
    throw new Error('hosts is required')
  }
  const kinds = input.kinds?.length ? input.kinds : DEFAULT_KINDS
  const overrides = input.overrides || {}

  const result = {}
  const used = []

  function claim(cidr, label) {
    const net = parseCidr(cidr)
    for (const r of reservedNets) {
      if (cidrsOverlap(net, r)) {
        throw new Error(`${label} ${net.cidr} overlaps reserved ${r.cidr}`)
      }
    }
    for (const other of used) {
      if (cidrsOverlap(net, other.net)) {
        throw new Error(
          `${label} ${net.cidr} overlaps ${other.label} ${other.net.cidr}`,
        )
      }
    }
    used.push({ net, label })
    return net.cidr
  }

  for (const hostname of hosts) {
    if (!hostname) throw new Error('host name must be non-empty')
    result[hostname] = {}
    for (const kind of kinds) {
      const label = `${hostname}/${kind}`
      const override = overrides[hostname]?.[kind]
      if (override) {
        result[hostname][kind] = claim(override, label)
        continue
      }
      result[hostname][kind] = claim(
        pickSubnet(inventory, hostname, kind, pool, prefix, reservedNets),
        label,
      )
    }
  }
  return result
}

export function assignClientIps(input) {
  const profiles = input?.profiles
  if (!Array.isArray(profiles)) throw new Error('profiles is required')

  const groups = new Map()
  profiles.forEach((profile, index) => {
    if (!profile || typeof profile !== 'object') {
      throw new Error(`profile ${index} must be an object`)
    }
    if (!profile.profile_name) {
      throw new Error(`profile ${index} missing profile_name`)
    }
    const subnet = profile.subnet
    if (!subnet) {
      throw new Error(`profile ${profile.profile_name} missing subnet`)
    }
    if (!groups.has(subnet)) groups.set(subnet, [])
    groups.get(subnet).push({ index, profile })
  })

  const ips = new Array(profiles.length)

  for (const [subnet, items] of groups) {
    const net = parseCidr(subnet)
    const usable = usableHostIds(net.size)
    const taken = new Set()
    const sorted = [...items].sort((a, b) => {
      if (a.profile.profile_name < b.profile.profile_name) return -1
      if (a.profile.profile_name > b.profile.profile_name) return 1
      return 0
    })

    for (const { index, profile } of sorted) {
      const start = Number(digest(profile.profile_name) % BigInt(usable.length))
      let hostId = null
      for (let j = 0; j < usable.length; j++) {
        const candidate = usable[(start + j) % usable.length]
        if (!taken.has(candidate)) {
          taken.add(candidate)
          hostId = candidate
          break
        }
      }
      if (hostId === null) {
        throw new Error(
          `subnet ${net.cidr} exhausted while assigning ${profile.profile_name}`,
        )
      }
      ips[index] = formatIpv4(net.network + hostId)
    }
  }

  return {
    profiles: profiles.map((profile, index) => ({ ...profile, ip: ips[index] })),
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(`self-check failed: ${message}`)
}

export function selfCheck() {
  const reserved = ['10.0.0.0/16']
  const base = {
    pool: DEFAULT_POOL,
    prefix: DEFAULT_PREFIX,
    reserved,
    hosts: ['ru-1', 'sw-1'],
    kinds: DEFAULT_KINDS,
    overrides: {},
  }

  const first = assignSubnets({ ...base, inventory: 'development' })
  const second = assignSubnets({ ...base, inventory: 'development' })
  assert(JSON.stringify(first) === JSON.stringify(second), 'subnets are deterministic')

  for (const host of base.hosts) {
    for (const kind of DEFAULT_KINDS) {
      assert(
        !first[host][kind].startsWith('10.0.'),
        `${host}/${kind} landed in reserved 10.0.0.0/16`,
      )
    }
  }

  const production = assignSubnets({ ...base, inventory: 'production' })
  assert(
    first['ru-1'].awg !== production['ru-1'].awg,
    'inventory name must change the subnet',
  )
  assert(first['ru-1'].awg !== first['sw-1'].awg, 'hostname must change the subnet')
  assert(first['ru-1'].awg !== first['ru-1'].wg, 'kind must change the subnet')

  const overridden = assignSubnets({
    ...base,
    inventory: 'development',
    hosts: ['ru-1'],
    overrides: { 'ru-1': { awg: '10.47.25.0/24' } },
  })
  assert(overridden['ru-1'].awg === '10.47.25.0/24', 'inventory subnet override')

  let reservedOverrideFailed = false
  try {
    assignSubnets({
      ...base,
      inventory: 'development',
      hosts: ['ru-1'],
      kinds: ['awg'],
      overrides: { 'ru-1': { awg: '10.0.1.0/24' } },
    })
  } catch {
    reservedOverrideFailed = true
  }
  assert(reservedOverrideFailed, 'override inside reserved range must fail')

  const subnet = first['ru-1'].awg
  const profiles = [
    { profile_name: 'b-host-peer-split', subnet },
    { profile_name: 'a-host-peer-full', subnet },
    { profile_name: 'a-host-peer-split', subnet },
  ]
  const assigned = assignClientIps({ profiles })
  const reordered = assignClientIps({ profiles: [...profiles].reverse() })
  const byName = (rows) =>
    Object.fromEntries(
      [...rows.profiles]
        .sort((a, b) => a.profile_name.localeCompare(b.profile_name))
        .map((p) => [p.profile_name, p.ip]),
    )
  assert(
    JSON.stringify(byName(assigned)) === JSON.stringify(byName(reordered)),
    'client IPs must not depend on input order',
  )

  const ips = new Set()
  for (const profile of assigned.profiles) {
    const last = Number(profile.ip.split('.')[3])
    assert(
      last !== 0 && last !== 1 && last !== 53 && last !== 255,
      `reserved host id assigned to ${profile.profile_name}`,
    )
    assert(!ips.has(profile.ip), `duplicate client IP ${profile.ip}`)
    ips.add(profile.ip)
  }
}

async function readStdin() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

function isCli() {
  const entry = process.argv[1]
  if (!entry) return false
  return import.meta.url === pathToFileURL(entry).href
}

const USAGE =
  'Usage: node scripts/assign_vpn_addresses.mjs <subnets|client-ips> < payload.json\n' +
  '       node scripts/assign_vpn_addresses.mjs --self-check\n'

if (isCli()) {
  try {
    const args = process.argv.slice(2)
    if (args.includes('-h') || args.includes('--help')) {
      process.stdout.write(USAGE)
      process.exit(0)
    }
    if (args[0] === '--self-check') {
      selfCheck()
      process.stdout.write('ok\n')
      process.exit(0)
    }
    const op = args[0]
    if (op !== 'subnets' && op !== 'client-ips') {
      process.stderr.write(USAGE)
      process.exit(1)
    }
    const raw = (await readStdin()).trim()
    if (!raw) throw new Error('stdin JSON payload is required')
    const input = JSON.parse(raw)
    const output = op === 'subnets' ? assignSubnets(input) : assignClientIps(input)
    process.stdout.write(`${JSON.stringify(output)}\n`)
  } catch (err) {
    console.error(`error: ${err.message}`)
    process.exit(1)
  }
}
