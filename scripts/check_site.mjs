#!/usr/bin/env node
/**
 * Client-vantage site checker. Drives tools/bin/miniooni (not ooniprobe),
 * never submits to the OONI collector, and prints a diagnosis ladder.
 *
 * Usage:
 *   node scripts/check_site.mjs https://brew.sh/
 *   node scripts/check_site.mjs --json https://brew.sh/
 *   node scripts/check_site.mjs --verbose --keep-report /tmp/brew.jsonl https://brew.sh/
 */
import { spawnSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BlockList, isIP } from 'node:net'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')
const miniooniBin = join(root, 'tools/bin/miniooni')
const rulesPath = join(root, 'rules/restricted.json')
const fakeIpCidr = '198.18.0.0/15'

const handshakeBlocked = new Set([
  'generic_timeout_error',
  'connection_reset',
  'eof_error',
  'connection_aborted',
  'connection_closed',
])

function usage(stream = process.stdout) {
  stream.write(`Usage: node scripts/check_site.mjs [options] <url>

  Probe a URL from this machine with miniooni (web_connectivity, then
  sni_blocking + urlgetter if TCP works and TLS fails). Client vantage
  only — not from wormhole nodes.

Options:
  --json                Print the diagnosis as JSON on stdout
  --verbose             Show miniooni logs on stderr
  --keep-report PATH    Copy the OONI JSONL report to PATH
  --control-ip ADDR     IP for the SNI-to-unrelated-host test (default: 1.1.1.1)
  --control-sni NAME    Benign SNI for site-IP tests (default: example.com)
  -h, --help            Show this help
`)
}

class Die extends Error {
  constructor(message, code = 1) {
    super(message)
    this.exitCode = code
  }
}

function die(message, code = 1) {
  throw new Die(message, code)
}

function info(message) {
  console.error(`==> ${message}`)
}

function parseArgs(argv) {
  const opts = {
    json: false,
    verbose: false,
    keepReport: null,
    controlIp: '1.1.1.1',
    controlSni: 'example.com',
    url: null,
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '-h' || arg === '--help') {
      usage()
      process.exit(0)
    }
    if (arg === '--json') {
      opts.json = true
      continue
    }
    if (arg === '--verbose') {
      opts.verbose = true
      continue
    }
    if (arg === '--keep-report' || arg.startsWith('--keep-report=')) {
      opts.keepReport = arg.includes('=')
        ? arg.slice('--keep-report='.length)
        : argv[++i]
      if (!opts.keepReport) die('--keep-report needs a path')
      continue
    }
    if (arg === '--control-ip' || arg.startsWith('--control-ip=')) {
      opts.controlIp = arg.includes('=')
        ? arg.slice('--control-ip='.length)
        : argv[++i]
      if (!opts.controlIp) die('--control-ip needs an address')
      continue
    }
    if (arg === '--control-sni' || arg.startsWith('--control-sni=')) {
      opts.controlSni = arg.includes('=')
        ? arg.slice('--control-sni='.length)
        : argv[++i]
      if (!opts.controlSni) die('--control-sni needs a name')
      continue
    }
    if (arg === '--') {
      opts.url = argv[i + 1]
      break
    }
    if (arg.startsWith('-')) die(`unknown argument: ${arg}`)
    if (opts.url) die('only one URL is supported')
    opts.url = arg
  }

  return opts
}

function normalizeUrl(raw) {
  const text = String(raw || '').trim()
  if (!text) die('missing URL')
  let parsed
  try {
    parsed = new URL(
      /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(text) ? text : `https://${text}`,
    )
  } catch {
    die(`invalid URL: ${raw}`)
  }
  if (!parsed.hostname) die(`URL has no hostname: ${raw}`)
  return parsed
}

function miniooniVersion() {
  const result = spawnSync(miniooniBin, ['--version'], {
    encoding: 'utf8',
    timeout: 10_000,
  })
  if (result.status !== 0) return null
  return (result.stdout || result.stderr || '').trim() || null
}

function runMiniooni({
  home,
  report,
  experiment,
  input,
  options = [],
  verbose,
}) {
  const args = ['-n', '-y', '--home', home, '-o', report]
  if (verbose) args.push('-v')
  args.push(experiment, '-i', input)
  for (const option of options) {
    args.push('-O', option)
  }

  info(`${experiment} ${input}${options.length ? ` ${options.join(' ')}` : ''}`)

  const result = spawnSync(miniooniBin, args, {
    encoding: 'utf8',
    timeout: 180_000,
    stdio: verbose
      ? ['ignore', 'inherit', 'inherit']
      : ['ignore', 'pipe', 'pipe'],
  })

  if (result.status !== 0 && !verbose) {
    const err = (
      result.stderr ||
      result.stdout ||
      result.error?.message ||
      ''
    ).trim()
    if (err) console.error(err)
  }

  if (result.status !== 0 && !existsSync(report)) {
    die(`miniooni ${experiment} failed (exit ${result.status ?? 'spawn'})`)
  }
}

function readJsonl(path) {
  if (!existsSync(path)) return []
  const measurements = []
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      measurements.push(JSON.parse(trimmed))
    } catch {
      // skip a truncated last line
    }
  }
  return measurements
}

function loadRestricted(path) {
  const cidrs = []
  const suffixes = []
  const domains = []
  if (!existsSync(path)) {
    return { cidrs, suffixes, domains }
  }

  const payload = JSON.parse(readFileSync(path, 'utf8'))
  const rules = Array.isArray(payload?.rules) ? payload.rules : []
  for (const rule of rules) {
    if (!rule || typeof rule !== 'object') continue
    for (const cidr of rule.ip_cidr || []) {
      if (typeof cidr === 'string') cidrs.push(cidr)
    }
    for (const suffix of rule.domain_suffix || []) {
      if (typeof suffix === 'string') suffixes.push(suffix)
    }
    for (const domain of rule.domain || []) {
      if (typeof domain === 'string') domains.push(domain)
    }
  }
  return { cidrs, suffixes, domains }
}

function parseCidr(cidr) {
  const slash = cidr.lastIndexOf('/')
  if (slash <= 0) return null
  const address = cidr.slice(0, slash)
  const prefix = Number.parseInt(cidr.slice(slash + 1), 10)
  const version = isIP(address)
  if (!version || Number.isNaN(prefix)) return null
  const max = version === 6 ? 128 : 32
  if (prefix < 0 || prefix > max) return null
  return {
    cidr,
    address,
    prefix,
    type: version === 6 ? 'ipv6' : 'ipv4',
  }
}

function matchingCidr(ip, parsedCidrs) {
  const version = isIP(ip)
  if (!version) return null
  const type = version === 6 ? 'ipv6' : 'ipv4'
  for (const entry of parsedCidrs) {
    if (entry.type !== type) continue
    const list = new BlockList()
    try {
      list.addSubnet(entry.address, entry.prefix, type)
    } catch {
      continue
    }
    if (list.check(ip, type)) return entry.cidr
  }
  return null
}

function hostListed(host, { suffixes, domains }) {
  const name = host.toLowerCase().replace(/\.$/, '')
  for (const domain of domains) {
    if (name === domain.toLowerCase()) return domain
  }
  for (const suffix of suffixes) {
    const d = suffix.toLowerCase().replace(/^\./, '')
    if (name === d || name.endsWith(`.${d}`)) return suffix
  }
  return null
}

function splitHostPort(address) {
  if (typeof address !== 'string' || !address) return { ip: null, port: null }
  if (address.startsWith('[')) {
    const end = address.indexOf(']')
    if (end < 0) return { ip: null, port: null }
    const ip = address.slice(1, end)
    const rest = address.slice(end + 1)
    const port = rest.startsWith(':')
      ? Number.parseInt(rest.slice(1), 10)
      : null
    return { ip, port }
  }
  const colon = address.lastIndexOf(':')
  if (colon < 0) return { ip: address, port: null }
  return {
    ip: address.slice(0, colon),
    port: Number.parseInt(address.slice(colon + 1), 10),
  }
}

function handshakeUrl(ip) {
  return isIP(ip) === 6
    ? `tlshandshake://[${ip}]:443`
    : `tlshandshake://${ip}:443`
}

function shortFailure(failure) {
  if (!failure) return 'ok'
  if (failure.includes('timeout')) return 'timeout'
  if (failure.includes('reset')) return 'reset'
  if (failure.includes('refused')) return 'refused'
  if (failure.includes('unreachable')) return 'unreachable'
  if (failure.includes('eof')) return 'eof'
  return failure
}

function tlsKind(failure) {
  if (!failure) return 'ok'
  if (handshakeBlocked.has(failure) || failure.includes('timeout')) {
    return 'blocked'
  }
  if (
    failure.includes('ssl_invalid_hostname') ||
    failure.includes('remote error: tls') ||
    failure.includes('handshake failure')
  ) {
    // Peer sent a TLS alert — the ClientHello was not dropped.
    return 'ok'
  }
  if (
    failure.startsWith('ssl_') ||
    failure.includes('x509') ||
    failure.includes('certificate')
  ) {
    return 'cert'
  }
  return 'other'
}

function collectDns(queries) {
  const addrs = []
  const seen = new Set()
  let anyOk = false
  let lastFailure = null
  for (const query of queries || []) {
    if (!query || typeof query !== 'object') continue
    if (query.failure) lastFailure = query.failure
    else anyOk = true
    for (const answer of query.answers || []) {
      const ip = answer?.ipv4 || answer?.ipv6 || answer?.ip
      if (!ip || seen.has(ip)) continue
      seen.add(ip)
      addrs.push(ip)
    }
  }
  return {
    ok: anyOk || addrs.length > 0,
    addrs,
    failure: anyOk ? null : lastFailure,
  }
}

function recordByIp(map, ip, entry) {
  if (!ip) return
  const prev = map[ip]
  if (!prev) {
    map[ip] = entry
    return
  }
  if (!prev.ok && entry.ok) map[ip] = entry
}

function parseWebConnectivity(measurement) {
  const keys =
    measurement?.test_keys && typeof measurement.test_keys === 'object'
      ? measurement.test_keys
      : {}

  const dns = collectDns(keys.queries)
  const tcp = { by_ip: {} }
  for (const row of keys.tcp_connect || []) {
    const ip = row?.ip
    const status = row?.status || {}
    const ok = Boolean(status.success) && !status.failure
    recordByIp(tcp.by_ip, ip, { ok, failure: status.failure || null })
  }

  const tls = { by_ip: {} }
  for (const row of keys.tls_handshakes || []) {
    const { ip } = splitHostPort(row?.address)
    const failure = row?.failure || null
    recordByIp(tls.by_ip, ip, {
      ok: tlsKind(failure) === 'ok',
      failure,
      kind: tlsKind(failure),
      server_name: row?.server_name || null,
    })
  }

  let http = { ok: false, status: null, via: null, failure: null }
  for (const row of keys.requests || []) {
    const code = row?.response?.code
    const failure = row?.failure || null
    if (code) {
      http = {
        ok: code >= 200 && code < 400,
        status: code,
        via: null,
        failure,
      }
      if (http.ok) break
    } else if (!http.status) {
      http.failure = failure
    }
  }
  const via = Object.entries(tls.by_ip).find(([, v]) => v.ok)?.[0]
  if (via) http.via = via

  for (const ip of dns.addrs) {
    if (!tcp.by_ip[ip]) tcp.by_ip[ip] = { ok: false, failure: 'not_attempted' }
  }

  return {
    dns,
    tcp,
    tls,
    http,
    blocking: keys.blocking ?? null,
    accessible: keys.accessible ?? null,
    control_failure: keys.control_failure ?? null,
    parsed: Boolean(
      (keys.queries && keys.queries.length) ||
      (keys.tcp_connect && keys.tcp_connect.length) ||
      (keys.tls_handshakes && keys.tls_handshakes.length),
    ),
  }
}

function parseUrlgetterTls(measurement) {
  const keys = measurement?.test_keys || {}
  const tlsRows = keys.tls_handshakes || []
  const tcpRows = keys.tcp_connect || []
  const tlsFailure = tlsRows[0]?.failure ?? keys.failure ?? null
  const tcpFailure = tcpRows[0]?.status?.failure ?? null
  const tcpOk = tcpRows.length
    ? tcpRows.some((row) => row?.status?.success && !row?.status?.failure)
    : !tcpFailure
  const kind = tlsKind(tlsFailure)
  return {
    tls_ok: kind === 'ok',
    kind,
    failure: tlsFailure,
    tcp_ok: tcpOk,
    tcp_failure: tcpFailure,
  }
}

function parseSniBlocking(measurement) {
  const keys = measurement?.test_keys || {}
  const controlFailure = keys.control?.failure ?? null
  const targetFailure = keys.target?.failure ?? null
  return {
    result: keys.result || null,
    control_ok: keys.control ? tlsKind(controlFailure) === 'ok' : null,
    target_ok: keys.target ? tlsKind(targetFailure) === 'ok' : null,
    th_address: keys.target?.th_address || keys.control?.th_address || null,
    control_failure: controlFailure,
    target_failure: targetFailure,
  }
}

function ipsNeedingSniFollowup(wc) {
  const ips = []
  for (const [ip, tcp] of Object.entries(wc.tcp.by_ip)) {
    if (!tcp.ok) continue
    const tls = wc.tls.by_ip[ip]
    if (!tls || tls.kind === 'blocked' || tls.kind === 'other') ips.push(ip)
  }
  return ips
}

function summarizeGroup(byIp) {
  const groups = new Map()
  for (const [ip, row] of Object.entries(byIp)) {
    const label = row.ok ? 'ok' : shortFailure(row.failure)
    if (!groups.has(label)) groups.set(label, [])
    groups.get(label).push(ip)
  }
  const parts = []
  for (const [label, ips] of groups) {
    parts.push(`${label} ${ips.join(', ')}`)
  }
  return parts.join('; ') || 'none'
}

function mixedStatus(byIp) {
  const rows = Object.values(byIp)
  if (!rows.length) return 'none'
  const oks = rows.filter((row) => row.ok).length
  if (oks === rows.length) return 'ok'
  if (oks === 0) return 'fail'
  return 'mixed'
}

function decideVerdict({ wc, path, sni, followupIps }) {
  if (!wc.parsed) {
    return {
      verdict: 'inconclusive',
      summary:
        'web_connectivity produced no local DNS/TCP/TLS events (test helper may be unreachable)',
    }
  }

  if (!wc.dns.ok && wc.dns.addrs.length === 0) {
    return {
      verdict: 'dns',
      summary: `DNS failed${wc.dns.failure ? ` (${wc.dns.failure})` : ''}`,
    }
  }

  const tcpRows = Object.values(wc.tcp.by_ip)
  const tcpAny = tcpRows.some((row) => row.ok)
  if (tcpRows.length && !tcpAny) {
    return {
      verdict: 'tcp',
      summary: 'TCP connect failed on every resolved IP',
    }
  }

  const tlsBlocked = followupIps.length > 0
  const tlsAnyOk = Object.values(wc.tls.by_ip).some((row) => row.ok)

  if (tlsBlocked && sni) {
    const toControl = sni.to_control_ip
    const controlToSite = sni.control_sni_to_site_ips || []
    const controlSniOkOnFailing = controlToSite.filter((row) => row.tls_ok)

    if (
      toControl &&
      toControl.tls_ok === false &&
      toControl.kind === 'blocked'
    ) {
      return {
        verdict: 'sni_keyword',
        summary: `TLS fails for SNI ${toControl.sni} even to ${toControl.ip}`,
      }
    }
    if (toControl?.tls_ok && controlSniOkOnFailing.length > 0) {
      return {
        verdict: 'sni_ip',
        summary: `TLS interference is SNI + destination IP, not a global SNI keyword. Failed IPs: ${followupIps.join(', ')}`,
      }
    }
    if (
      toControl?.tls_ok &&
      controlToSite.length &&
      controlSniOkOnFailing.length === 0
    ) {
      return {
        verdict: 'tls',
        summary:
          'TLS fails on site IPs even with a benign SNI (destination-IP interference, not SNI-specific)',
      }
    }
    if (!tlsAnyOk) {
      return {
        verdict: 'tls',
        summary:
          'TCP succeeded but TLS failed; SNI follow-ups were inconclusive',
      }
    }
  }

  if (!tlsAnyOk && tcpAny) {
    return {
      verdict: 'tls',
      summary: 'TCP succeeded but TLS failed on every attempted IP',
    }
  }

  if (tlsAnyOk && wc.http.status && !wc.http.ok) {
    return {
      verdict: 'http',
      summary: `TLS ok but HTTP failed${wc.http.status ? ` (status ${wc.http.status})` : ''}`,
    }
  }

  if (tlsAnyOk && (wc.http.ok || wc.http.status === null)) {
    if (path.contaminated) {
      return {
        verdict: 'inconclusive',
        summary:
          'Network legs looked reachable, but resolved IPs are in restricted.json (Wormhole may steal this probe)',
      }
    }
    if (tlsBlocked) {
      return {
        verdict: 'sni_ip',
        summary: `Some IPs fail TLS for this SNI while others work. Failed IPs: ${followupIps.join(', ')}`,
      }
    }
    return {
      verdict: 'ok',
      summary: wc.http.status
        ? `Reachable (HTTP ${wc.http.status}${wc.http.via ? ` via ${wc.http.via}` : ''})`
        : 'TLS succeeded',
    }
  }

  return {
    verdict: 'inconclusive',
    summary: 'Not enough of the ladder completed to classify the failure',
  }
}

function pad(label, status, detail) {
  return `${label.padEnd(8)}${String(status).padEnd(14)}${detail}`
}

function printHuman(result) {
  const { url, host, dns, tcp, tls, http, path, sni, verdict, summary, wc } =
    result
  console.log(`==> ${url}`)
  console.log('')
  console.log(
    pad(
      'DNS',
      dns.ok ? 'ok' : 'fail',
      dns.addrs.length
        ? `${host} → ${dns.addrs.join(', ')}`
        : dns.failure || 'no answers',
    ),
  )

  if (path.domain_listed) {
    console.log(
      pad(
        'PATH',
        'listed',
        `${host} matches domain_suffix ${path.domain_listed} in rules/restricted.json`,
      ),
    )
  }
  if (path.matches.length) {
    const bits = path.matches.map((row) => `${row.ip} in ${row.cidr}`)
    console.log(
      pad(
        'PATH',
        'warn',
        `${bits.join('; ')} (if you're connected to Wormhole, this probe may not take the ISP path)`,
      ),
    )
  } else if (!path.domain_listed) {
    console.log(pad('PATH', 'ok', 'not in rules/restricted.json ip_cidr'))
  }

  const v4tcp = {}
  const v6tcp = {}
  for (const [ip, row] of Object.entries(tcp.by_ip)) {
    ;(isIP(ip) === 6 ? v6tcp : v4tcp)[ip] = row
  }
  if (Object.keys(v4tcp).length) {
    console.log(pad('TCP', mixedStatus(v4tcp), summarizeGroup(v4tcp)))
  }
  if (Object.keys(v6tcp).length) {
    console.log(pad('TCP6', mixedStatus(v6tcp), summarizeGroup(v6tcp)))
  }
  if (!Object.keys(tcp.by_ip).length) {
    console.log(pad('TCP', 'none', 'no connect attempts'))
  }

  const v4tls = {}
  const v6tls = {}
  for (const [ip, row] of Object.entries(tls.by_ip)) {
    ;(isIP(ip) === 6 ? v6tls : v4tls)[ip] = row
  }
  if (Object.keys(v4tls).length) {
    console.log(pad('TLS', mixedStatus(v4tls), summarizeGroup(v4tls)))
  }
  if (Object.keys(v6tls).length) {
    console.log(pad('TLS6', mixedStatus(v6tls), summarizeGroup(v6tls)))
  }
  if (!Object.keys(tls.by_ip).length) {
    console.log(pad('TLS', 'none', 'no handshakes'))
  }

  if (http.status) {
    console.log(
      pad(
        'HTTP',
        http.ok ? 'ok' : 'fail',
        `${http.status}${http.via ? ` via ${http.via}` : ''}`,
      ),
    )
  } else if (http.failure) {
    console.log(pad('HTTP', 'fail', http.failure))
  } else {
    console.log(pad('HTTP', 'none', 'no request'))
  }

  if (wc.control_failure) {
    console.log(pad('TH', 'warn', `OONI test helper: ${wc.control_failure}`))
  }

  if (sni) {
    if (sni.to_control_ip) {
      const row = sni.to_control_ip
      console.log(
        pad(
          'SNI',
          row.tls_ok ? 'not_global' : 'blocked',
          `urlgetter ${row.ip} SNI=${row.sni}: TLS ${row.tls_ok ? 'ok' : shortFailure(row.failure)}`,
        ),
      )
    }
    if (sni.control_sni_to_site_ips?.length) {
      const ok = sni.control_sni_to_site_ips.filter((row) => row.tls_ok)
      const bad = sni.control_sni_to_site_ips.filter((row) => !row.tls_ok)
      const parts = []
      if (ok.length) {
        parts.push(
          `benign SNI ${ok[0].sni} ok on ${ok.map((row) => row.ip).join(', ')}`,
        )
      }
      if (bad.length) {
        parts.push(
          `benign SNI fail on ${bad.map((row) => `${row.ip} (${shortFailure(row.failure)})`).join(', ')}`,
        )
      }
      console.log(
        pad(
          'SNI+IP',
          ok.length && !bad.length
            ? 'yes'
            : bad.length && !ok.length
              ? 'no'
              : 'mixed',
          parts.join('; '),
        ),
      )
    }
    if (sni.blocking?.result) {
      console.log(
        pad(
          'ts-024',
          sni.blocking.target_ok ? 'ok' : 'fail',
          `${sni.blocking.result}${sni.blocking.th_address ? ` via ${sni.blocking.th_address}` : ''}`,
        ),
      )
    }
  }

  console.log('')
  console.log(pad('verdict', verdict, summary))
}

function jsonOutput(result) {
  return {
    url: result.url,
    host: result.host,
    miniooni: result.miniooni,
    verdict: result.verdict,
    summary: result.summary,
    path: result.path,
    dns: result.dns,
    tcp: result.tcp,
    tls: result.tls,
    http: result.http,
    sni: result.sni,
    experiments: result.experiments,
    hints: {
      blocking: result.wc.blocking,
      accessible: result.wc.accessible,
      control_failure: result.wc.control_failure,
    },
  }
}

function exitCode(verdict) {
  if (verdict === 'ok') return 0
  if (verdict === 'inconclusive') return 3
  return 2
}

function isWebConnectivity(name) {
  return (
    name === 'web_connectivity' || String(name).startsWith('web_connectivity')
  )
}

let home
try {
  const opts = parseArgs(process.argv.slice(2))
  const target = normalizeUrl(opts.url)
  const host = target.hostname
  const url = target.href

  if (!existsSync(miniooniBin)) {
    die('tools/bin/miniooni not found; run: fish install-tools.fish')
  }

  const version = miniooniVersion()
  if (!version) die('tools/bin/miniooni did not run')

  const restricted = loadRestricted(rulesPath)
  const parsedCidrs = [...restricted.cidrs, fakeIpCidr]
    .map(parseCidr)
    .filter(Boolean)

  home = mkdtempSync(join(tmpdir(), 'wormhole-check-'))
  const report = join(home, 'report.jsonl')
  const experiments = []
  runMiniooni({
    home,
    report,
    experiment: 'web_connectivity',
    input: url,
    verbose: opts.verbose,
  })
  experiments.push('web_connectivity')

  let measurements = readJsonl(report)
  const wcMeas = [...measurements]
    .reverse()
    .find((row) => isWebConnectivity(row.test_name))
  if (!wcMeas) die('web_connectivity wrote no measurement')

  const wc = parseWebConnectivity(wcMeas)
  const followupIps = ipsNeedingSniFollowup(wc)

  const matches = []
  for (const ip of wc.dns.addrs) {
    const cidr = matchingCidr(ip, parsedCidrs)
    if (cidr) {
      matches.push({
        ip,
        cidr:
          cidr === fakeIpCidr ? `${fakeIpCidr} (sing-box FakeIP range)` : cidr,
      })
    }
  }
  const domainListed = hostListed(host, restricted)
  const path = {
    contaminated: matches.length > 0,
    matches,
    domain_listed: domainListed,
  }

  let sni = null
  if (followupIps.length) {
    sni = {
      to_control_ip: null,
      control_sni_to_site_ips: [],
      blocking: null,
    }

    runMiniooni({
      home,
      report,
      experiment: 'sni_blocking',
      input: host,
      verbose: opts.verbose,
    })
    experiments.push('sni_blocking')

    runMiniooni({
      home,
      report,
      experiment: 'urlgetter',
      input: handshakeUrl(opts.controlIp),
      options: [`TLSServerName=${host}`, 'NoTLSVerify=true'],
      verbose: opts.verbose,
    })
    experiments.push('urlgetter')

    for (const ip of followupIps) {
      runMiniooni({
        home,
        report,
        experiment: 'urlgetter',
        input: handshakeUrl(ip),
        options: [`TLSServerName=${opts.controlSni}`, 'NoTLSVerify=true'],
        verbose: opts.verbose,
      })
    }

    measurements = readJsonl(report)
    const sniMeas = [...measurements]
      .reverse()
      .find((row) => row.test_name === 'sni_blocking')
    if (sniMeas) sni.blocking = parseSniBlocking(sniMeas)

    const ug = measurements.filter((row) => row.test_name === 'urlgetter')
    const inputOf = (row) => String(row.input || '').replace(/\/$/, '')
    const controlMeas = ug.find(
      (row) => inputOf(row) === handshakeUrl(opts.controlIp),
    )
    if (controlMeas) {
      const parsed = parseUrlgetterTls(controlMeas)
      sni.to_control_ip = {
        ip: opts.controlIp,
        sni: host,
        tls_ok: parsed.tls_ok,
        kind: parsed.kind,
        failure: parsed.failure,
      }
    }

    for (const ip of followupIps) {
      const meas = ug.find((row) => inputOf(row) === handshakeUrl(ip))
      if (!meas) continue
      const parsed = parseUrlgetterTls(meas)
      sni.control_sni_to_site_ips.push({
        ip,
        sni: opts.controlSni,
        tls_ok: parsed.tls_ok,
        kind: parsed.kind,
        failure: parsed.failure,
      })
    }
  }

  const { verdict, summary } = decideVerdict({
    wc,
    path,
    sni,
    followupIps,
  })

  const result = {
    url,
    host,
    miniooni: version,
    verdict,
    summary,
    path,
    dns: wc.dns,
    tcp: wc.tcp,
    tls: wc.tls,
    http: wc.http,
    sni,
    experiments,
    wc,
  }

  if (opts.keepReport) {
    const dest = isAbsolute(opts.keepReport)
      ? opts.keepReport
      : join(process.cwd(), opts.keepReport)
    mkdirSync(dirname(dest), { recursive: true })
    copyFileSync(report, dest)
    info(`kept report ${dest}`)
  }

  if (opts.json) {
    console.log(JSON.stringify(jsonOutput(result), null, 2))
  } else {
    printHuman(result)
  }

  process.exitCode = exitCode(verdict)
} catch (err) {
  if (err instanceof Die) {
    console.error(`error: ${err.message}`)
    process.exitCode = err.exitCode
  } else {
    throw err
  }
} finally {
  if (home) rmSync(home, { recursive: true, force: true })
}
