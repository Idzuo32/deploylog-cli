import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readProjectConfig, ProjectConfigError } from './project-config.js'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dpl-cfg-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function write(dir: string, contents: string): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, '.deploylog.yml'), contents, 'utf-8')
}

describe('readProjectConfig()', () => {
  it('reads a config in the start directory', () => {
    write(root, 'project: my-app\ndefault_type: fix\n')
    expect(readProjectConfig(root)).toEqual({ project: 'my-app', default_type: 'fix' })
  })

  it('walks up and finds a config in a parent directory', () => {
    write(root, 'project: parent-app\n')
    const child = join(root, 'packages', 'web')
    mkdirSync(child, { recursive: true })
    expect(readProjectConfig(child)).toEqual({ project: 'parent-app' })
  })

  it('returns null when no config exists anywhere up the tree', () => {
    const child = join(root, 'a', 'b')
    mkdirSync(child, { recursive: true })
    expect(readProjectConfig(child)).toBeNull()
  })

  it('throws on malformed YAML and does NOT adopt a parent directory config', () => {
    write(root, 'project: parent-app\n')
    const child = join(root, 'child')
    write(child, 'project: [unterminated\n') // invalid flow sequence → parse throws

    expect(() => readProjectConfig(child)).toThrow(ProjectConfigError)
    // Ground truth: the parent's valid config must never be reached past a
    // broken file — assert it is NOT what comes back.
    try {
      readProjectConfig(child)
      throw new Error('expected a throw')
    } catch (err) {
      expect(err).toBeInstanceOf(ProjectConfigError)
      expect((err as Error).message).not.toContain('parent-app')
    }
  })

  it('rejects a non-object (bare string) YAML with a typed error', () => {
    write(root, 'just-a-bare-string\n')
    expect(() => readProjectConfig(root)).toThrow(ProjectConfigError)
  })

  it('rejects a top-level array YAML with a typed error', () => {
    write(root, '- one\n- two\n')
    expect(() => readProjectConfig(root)).toThrow(ProjectConfigError)
  })

  it('treats an empty file as a present-but-empty config (stops the walk)', () => {
    write(root, 'project: parent-app\n')
    const child = join(root, 'child')
    write(child, '')
    // Empty file is valid YAML (null document) → {} , and the walk stops here
    // rather than inheriting the parent's project.
    expect(readProjectConfig(child)).toEqual({})
  })
})
