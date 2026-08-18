#!/usr/bin/env node
/**
 * Pack each user config directory into an AES-256 zip.
 *
 *   node scripts/pack_user_configs.mjs payload.json
 *   node scripts/pack_user_configs.mjs --self-check
 *
 * payload: { local_dir, users: ["andrei", "karina"], passwords: { andrei: "..." } }
 * local_dir is the configs/ tree (user folders live directly under it).
 * Users without a config directory are skipped and their leftover zip is removed.
 */
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const SEVEN_ZIP_NAMES = ['7zz', '7z']

export function findSevenZip() {
  for (const cmd of SEVEN_ZIP_NAMES) {
    const probe = spawnSync(cmd, ['i'], { encoding: 'utf8' })
    if (probe.error) continue
    if (probe.status === 0 || probe.status === 1) return cmd
  }
  throw new Error('7zz is required (brew install sevenzip)')
}

export function packUserConfigs({ localDir, users, passwords }) {
  if (!localDir) throw new Error('local_dir is required')
  if (!Array.isArray(users) || users.length === 0) {
    throw new Error('users is required')
  }
  if (!passwords || typeof passwords !== 'object' || Array.isArray(passwords)) {
    throw new Error('passwords is required')
  }

  const sevenZip = findSevenZip()
  const packed = []
  const skipped = []

  for (const user of users) {
    const userDir = join(localDir, user)
    const zipPath = join(localDir, `${user}.zip`)
    if (!existsSync(userDir)) {
      rmSync(zipPath, { force: true })
      skipped.push(user)
      continue
    }
    const password = passwords[user]
    if (typeof password !== 'string' || !password) {
      throw new Error(`missing zip password for user ${user}`)
    }
    rmSync(zipPath, { force: true })
    const result = spawnSync(
      sevenZip,
      ['a', '-tzip', '-mem=AES256', `-p${password}`, '-y', zipPath, '.'],
      { cwd: userDir, encoding: 'utf8' },
    )
    if (result.status !== 0) {
      throw new Error(
        `failed to pack ${user}: ${(result.stderr || result.stdout || '').trim()}`,
      )
    }
    chmodSync(zipPath, 0o600)
    packed.push(zipPath)
  }

  if (packed.length === 0) {
    throw new Error('no user config directories to pack')
  }

  return { packed, skipped }
}

function assert(condition, message) {
  if (!condition) throw new Error(`self-check failed: ${message}`)
}

export function selfCheck() {
  const sevenZip = findSevenZip()
  const root = mkdtempSync(join(tmpdir(), 'wormhole-pack-'))
  const localDir = join(root, 'local')
  const userDir = join(localDir, 'andrei', 'iphone', 'amneziawg')
  const extractDir = join(root, 'extract')
  const password = 'test-password'
  const sample = 'PrivateKey = example\n'

  try {
    mkdirSync(userDir, { recursive: true })
    writeFileSync(join(userDir, 'wormhole-ru-1-de-1-split.conf'), sample)

    writeFileSync(join(localDir, 'karina.zip'), 'stale')

    const packed = packUserConfigs({
      localDir,
      users: ['andrei', 'karina'],
      passwords: { andrei: password },
    })
    assert(packed.packed.length === 1, 'packed one zip')
    assert(packed.skipped.length === 1 && packed.skipped[0] === 'karina', 'skip missing user dir')
    const zipPath = packed.packed[0]
    assert(existsSync(zipPath), 'zip exists')
    assert(!existsSync(join(localDir, 'karina.zip')), 'stale zip for missing user is removed')

    const listing = spawnSync(sevenZip, ['l', '-slt', zipPath], {
      encoding: 'utf8',
    })
    assert(listing.status === 0, '7zz list succeeded')
    assert(/AES/i.test(listing.stdout), 'zip uses AES encryption')

    mkdirSync(extractDir, { recursive: true })
    const extract = spawnSync(
      sevenZip,
      ['x', `-p${password}`, '-y', `-o${extractDir}`, zipPath],
      { encoding: 'utf8' },
    )
    assert(extract.status === 0, 'extract with password succeeded')
    const extracted = readFileSync(
      join(extractDir, 'iphone', 'amneziawg', 'wormhole-ru-1-de-1-split.conf'),
      'utf8',
    )
    assert(extracted === sample, 'extracted contents match')

    const wrong = spawnSync(
      sevenZip,
      ['x', '-pwrong', '-y', `-o${join(root, 'wrong')}`, zipPath],
      { encoding: 'utf8' },
    )
    assert(wrong.status !== 0, 'extract with wrong password must fail')

    let emptyFailed = false
    try {
      packUserConfigs({
        localDir,
        users: ['karina'],
        passwords: { karina: password },
      })
    } catch (err) {
      emptyFailed = /no user config directories to pack/.test(err.message)
    }
    assert(emptyFailed, 'packing only missing users must fail')
  } finally {
    rmSync(root, { recursive: true, force: true })
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
  'Usage: node scripts/pack_user_configs.mjs [payload.json]\n' +
  '       node scripts/pack_user_configs.mjs --self-check\n'

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
    const raw = args[0]
      ? readFileSync(args[0], 'utf8')
      : (await readStdin()).trim()
    if (!raw) throw new Error('payload JSON is required (file argument or stdin)')
    const input = JSON.parse(raw)
    const packed = packUserConfigs({
      localDir: input.local_dir,
      users: input.users,
      passwords: input.passwords,
    })
    process.stdout.write(`${JSON.stringify(packed)}\n`)
  } catch (err) {
    console.error(`error: ${err.message}`)
    process.exit(1)
  }
}
