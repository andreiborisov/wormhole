#!/usr/bin/env node
/**
 * Flatten composed profiles to text for GL.iNet-style consumers.
 *
 *   node scripts/extract_rules_to_txt.mjs
 *
 * Writes rules/profiles/ru.txt and rules/profiles/non-ru.txt
 * (domain suffixes, then CIDRs). Peer dns.local_domains stay in Ansible.
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { composeRules, defaultRulesDir } from './compose_rules.mjs'

const profiles = ['ru', 'non-ru']

export function profileTxt(profile, rulesDir = defaultRulesDir) {
  const composed = composeRules({ profile, rulesDir })
  const lines = [...composed.domain_suffixes, ...composed.advertise_cidrs]
  return {
    path: join(rulesDir, 'profiles', `${profile}.txt`),
    count: lines.length,
    text: lines.length ? `${lines.join('\n')}\n` : '',
  }
}

function isCli() {
  const entry = process.argv[1]
  if (!entry) return false
  return import.meta.url === pathToFileURL(entry).href
}

if (isCli()) {
  try {
    for (const profile of profiles) {
      const { path, count, text } = profileTxt(profile)
      writeFileSync(path, text)
      process.stdout.write(
        `Wrote ${count} entries to profiles/${profile}.txt\n`,
      )
    }
  } catch (err) {
    console.error(`error: ${err.message}`)
    process.exit(1)
  }
}
