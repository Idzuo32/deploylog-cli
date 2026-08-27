import { describe, it, expect } from 'vitest'
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { getCliVersion } from './version.js'

describe('getCliVersion', () => {
  it('reads the version the package declares (never a hardcoded string)', () => {
    const declared = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
    expect(getCliVersion()).toBe(declared)
    expect(getCliVersion()).toMatch(/^\d+\.\d+\.\d+/)
  })

  it('reads whatever package.json it is pointed at', () => {
    const dir = mkdtempSync(join(tmpdir(), 'deploylog-version-'))
    const file = join(dir, 'package.json')
    writeFileSync(file, JSON.stringify({ name: 'x', version: '9.9.9' }))
    expect(getCliVersion(pathToFileURL(file))).toBe('9.9.9')
  })

  it('refuses a package.json without a version instead of inventing one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'deploylog-version-'))
    const file = join(dir, 'package.json')
    writeFileSync(file, JSON.stringify({ name: 'x' }))
    expect(() => getCliVersion(pathToFileURL(file))).toThrow(/no version field/)
  })
})
