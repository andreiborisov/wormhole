#!/usr/bin/env node
/**
 * Find an SSH path from the controller to each inventory host.
 *
 * Probes direct first, then BFS through key-authenticated hosts (max 2 hops).
 * Shortest path wins; inventory order breaks ties at the same depth.
 *
 *   node scripts/discover_ssh_paths.mjs < payload.json
 *   node scripts/discover_ssh_paths.mjs --self-check
 *
 * stdin: { identity_file, hosts: [{ name, ansible_host, ansible_user }] }
 */
import { execa } from 'execa'
import { pathToFileURL } from 'node:url'

export const MAX_HOPS = 2
export const SSH_CONNECT_TIMEOUT_SECONDS = 5

const AUTH_FAIL_RE =
  /permission denied|authentication failed|too many authentication failures/i

export function classifySshResult({ exitCode, stderr = '', stdout = '' }) {
  if (exitCode === 0) return 'key_ok'
  const text = `${stderr}\n${stdout}`
  if (AUTH_FAIL_RE.test(text)) return 'auth_fail'
  return 'unreachable'
}

export function sshOptionArgs(identityFile) {
  return [
    '-o',
    'BatchMode=yes',
    '-o',
    `ConnectTimeout=${SSH_CONNECT_TIMEOUT_SECONDS}`,
    '-o',
    'StrictHostKeyChecking=no',
    '-o',
    'IdentitiesOnly=yes',
    '-i',
    identityFile,
  ]
}

export function proxyJumpValue(hopHosts) {
  return hopHosts.map((h) => `${h.ansible_user}@${h.ansible_host}`).join(',')
}

export function jumpArgs(hopHosts) {
  if (hopHosts.length === 0) return ''
  return `-o ProxyJump=${proxyJumpValue(hopHosts)}`
}

export function quoteSshArg(value) {
  const text = String(value)
  if (/^[A-Za-z0-9_./:@%+=-]+$/.test(text)) return text
  return `'${text.replace(/'/g, `'\\''`)}'`
}

export function proxyCommand(hopHosts, identityFile) {
  if (hopHosts.length === 0) return ''
  const last = hopHosts[hopHosts.length - 1]
  const rest = hopHosts.slice(0, -1)
  const args = ['ssh', '-W', '%h:%p', ...sshOptionArgs(identityFile)]
  if (rest.length > 0) {
    args.push('-o', `ProxyJump=${proxyJumpValue(rest)}`)
  }
  args.push(`${last.ansible_user}@${last.ansible_host}`)
  return args.map(quoteSshArg).join(' ')
}

function hopHostsFromNames(names, byName) {
  return names.map((name) => {
    const host = byName.get(name)
    if (!host) throw new Error(`unknown hop host: ${name}`)
    return host
  })
}

function validateHosts(hosts) {
  if (!Array.isArray(hosts) || hosts.length === 0) {
    throw new Error('hosts must be a non-empty array')
  }
  const seen = new Set()
  for (const host of hosts) {
    if (!host || typeof host !== 'object') {
      throw new Error('each host must be an object')
    }
    if (!host.name) throw new Error('each host needs a name')
    if (!host.ansible_host) {
      throw new Error(`host ${host.name} is missing ansible_host`)
    }
    if (!host.ansible_user) {
      throw new Error(`host ${host.name} is missing ansible_user`)
    }
    if (seen.has(host.name)) {
      throw new Error(`duplicate host name: ${host.name}`)
    }
    seen.add(host.name)
  }
}

export async function probeSsh(target, hopHosts, identityFile) {
  const args = [...sshOptionArgs(identityFile)]
  if (hopHosts.length > 0) {
    args.push('-o', `ProxyJump=${proxyJumpValue(hopHosts)}`)
  }
  args.push(`${target.ansible_user}@${target.ansible_host}`, 'true')
  const timeoutMs =
    (SSH_CONNECT_TIMEOUT_SECONDS * (hopHosts.length + 1) + 5) * 1000
  try {
    const result = await execa('ssh', args, {
      reject: false,
      timeout: timeoutMs,
    })
    if (result.timedOut) return 'unreachable'
    return classifySshResult({
      exitCode: result.exitCode,
      stderr: result.stderr,
      stdout: result.stdout,
    })
  } catch (err) {
    if (err.timedOut) return 'unreachable'
    if (err.code === 'ENOENT') {
      throw new Error('ssh is not installed or not on PATH')
    }
    throw err
  }
}

export async function discoverSshPaths({
  hosts,
  identityFile,
  probe = probeSsh,
}) {
  if (!identityFile) throw new Error('identity_file is required')
  validateHosts(hosts)

  const byName = new Map(hosts.map((host) => [host.name, host]))
  const paths = new Map()

  const classifyTarget = (target, hopNames) =>
    probe(target, hopHostsFromNames(hopNames, byName), identityFile)

  const direct = await Promise.all(
    hosts.map(async (host) => [host.name, await classifyTarget(host, [])]),
  )
  for (const [name, result] of direct) {
    if (result !== 'unreachable') {
      paths.set(name, { hops: [], key_ok: result === 'key_ok' })
    }
  }

  for (let hopCount = 1; hopCount <= MAX_HOPS; hopCount++) {
    const remaining = hosts.filter((host) => !paths.has(host.name))
    if (remaining.length === 0) break

    const jumps = hosts.filter((host) => {
      const path = paths.get(host.name)
      return path?.key_ok && path.hops.length === hopCount - 1
    })
    if (jumps.length === 0) continue

    const found = await Promise.all(
      remaining.map(async (target) => {
        const jumpResults = await Promise.all(
          jumps.map(async (jump) => {
            const hopNames = [...paths.get(jump.name).hops, jump.name]
            const result = await classifyTarget(target, hopNames)
            return { hopNames, result }
          }),
        )
        const win = jumpResults.find((row) => row.result !== 'unreachable')
        if (!win) return null
        return {
          name: target.name,
          hops: win.hopNames,
          key_ok: win.result === 'key_ok',
        }
      }),
    )

    for (const row of found) {
      if (row) paths.set(row.name, { hops: row.hops, key_ok: row.key_ok })
    }
  }

  const output = {}
  for (const host of hosts) {
    const path = paths.get(host.name)
    if (!path) {
      output[host.name] = {
        hops: [],
        key_ok: false,
        reachable: false,
        jump: '',
        proxy_command: '',
      }
      continue
    }
    const hopHosts = hopHostsFromNames(path.hops, byName)
    output[host.name] = {
      hops: path.hops,
      key_ok: path.key_ok,
      reachable: true,
      jump: jumpArgs(hopHosts),
      proxy_command: proxyCommand(hopHosts, identityFile),
    }
  }
  return output
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function host(name, ip = `203.0.113.${name}`) {
  return { name, ansible_host: ip, ansible_user: 'root' }
}

async function selfCheck() {
  assert(
    classifySshResult({ exitCode: 0, stderr: '' }) === 'key_ok',
    'exit 0 is key_ok',
  )
  assert(
    classifySshResult({
      exitCode: 255,
      stderr: 'Permission denied (publickey).',
    }) === 'auth_fail',
    'permission denied is auth_fail',
  )
  assert(
    classifySshResult({
      exitCode: 255,
      stderr: 'ssh: connect to host 1.2.3.4 port 22: Connection timed out',
    }) === 'unreachable',
    'timeout is unreachable',
  )

  const identity = '/tmp/wormhole-test.pub'
  const a = host('a', '203.0.113.10')
  const b = host('b', '203.0.113.20')
  const c = host('c', '203.0.113.30')
  const d = host('d', '203.0.113.40')

  const hopKey = (target, hops) =>
    `${hops.map((h) => h.name).join(',')}>${target.name}`

  const run = (hosts, table) =>
    discoverSshPaths({
      hosts,
      identityFile: identity,
      probe: async (target, hopHosts) => {
        const result = table[hopKey(target, hopHosts)]
        if (result === undefined) return 'unreachable'
        return result
      },
    })

  const allDirect = await run([a, b], {
    '>a': 'key_ok',
    '>b': 'key_ok',
  })
  assert(allDirect.a.reachable && allDirect.a.hops.length === 0, 'a is direct')
  assert(allDirect.b.reachable && allDirect.b.key_ok, 'b is direct key_ok')
  assert(allDirect.a.jump === '' && allDirect.a.proxy_command === '', 'direct has no jump')

  const viaA = await run([a, b], {
    '>a': 'key_ok',
    'a>b': 'auth_fail',
  })
  assert(viaA.b.reachable && !viaA.b.key_ok, 'b reachable via a without key')
  assert(viaA.b.hops.join(',') === 'a', 'b hops through a')
  assert(
    viaA.b.jump === '-o ProxyJump=root@203.0.113.10',
    `unexpected jump: ${viaA.b.jump}`,
  )
  assert(
    viaA.b.proxy_command.includes('-W %h:%p') &&
      viaA.b.proxy_command.includes('root@203.0.113.10'),
    'proxy_command targets the jump host',
  )
  assert(
    !viaA.b.proxy_command.includes('ProxyJump'),
    'single hop proxy_command must not nest ProxyJump',
  )

  const twoHops = await run([a, b, c], {
    '>a': 'key_ok',
    'a>b': 'key_ok',
    'a,b>c': 'key_ok',
  })
  assert(twoHops.c.hops.join(',') === 'a,b', 'c uses two hops')
  assert(
    twoHops.c.jump === '-o ProxyJump=root@203.0.113.10,root@203.0.113.20',
    `unexpected two-hop jump: ${twoHops.c.jump}`,
  )
  assert(
    twoHops.c.proxy_command.includes('ProxyJump=root@203.0.113.10') &&
      twoHops.c.proxy_command.endsWith('root@203.0.113.20'),
    'two-hop proxy_command jumps through a to b',
  )

  const tie = await run([a, b, c], {
    '>a': 'key_ok',
    '>b': 'key_ok',
    'a>c': 'key_ok',
    'b>c': 'key_ok',
  })
  assert(
    tie.c.hops.join(',') === 'a',
    'same-depth tie uses inventory order (a before b)',
  )

  const tooDeep = await run([a, b, c, d], {
    '>a': 'key_ok',
    'a>b': 'key_ok',
    'a,b>c': 'key_ok',
    'a,b,c>d': 'key_ok',
  })
  assert(tooDeep.d.reachable === false, '3 hops exceeds MAX_HOPS')
  assert(tooDeep.d.jump === '', 'unreachable host has empty jump')
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
  'Usage: node scripts/discover_ssh_paths.mjs < payload.json\n' +
  '       node scripts/discover_ssh_paths.mjs --self-check\n'

if (isCli()) {
  try {
    const args = process.argv.slice(2)
    if (args.includes('-h') || args.includes('--help')) {
      process.stdout.write(USAGE)
      process.exit(0)
    }
    if (args[0] === '--self-check') {
      await selfCheck()
      process.stdout.write('ok\n')
      process.exit(0)
    }
    if (args.length > 0) {
      process.stderr.write(USAGE)
      process.exit(1)
    }
    const raw = (await readStdin()).trim()
    if (!raw) throw new Error('stdin JSON payload is required')
    const input = JSON.parse(raw)
    const output = await discoverSshPaths({
      hosts: input.hosts,
      identityFile: input.identity_file,
    })
    process.stdout.write(`${JSON.stringify(output)}\n`)
  } catch (err) {
    console.error(`error: ${err.message}`)
    process.exit(1)
  }
}
