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

describe('readProjectConfig() — unrecognized settings (issue 08)', () => {
  /** Collects the warning lines so a test can assert on them (or on silence). */
  function spy(): { warn: (m: string) => void; lines: string[] } {
    const lines: string[] = []
    return { warn: (m) => lines.push(m), lines }
  }

  it('stays SILENT when every key is recognized', () => {
    // The calibration arm: a warning that fires on a correct config is noise,
    // and a check that always fires is no better than one that never can.
    write(root, 'project: my-app\ndefault_type: fix\n')
    const { warn, lines } = spy()
    expect(readProjectConfig(root, warn)).toEqual({ project: 'my-app', default_type: 'fix' })
    expect(lines).toEqual([])
  })

  it('stays SILENT on an empty config and on no config at all', () => {
    const { warn, lines } = spy()
    write(root, '')
    expect(readProjectConfig(root, warn)).toEqual({})
    const bare = join(root, 'nowhere', 'deeper')
    mkdirSync(bare, { recursive: true })
    rmSync(join(root, '.deploylog.yml'))
    expect(readProjectConfig(bare, warn)).toBeNull()
    expect(lines).toEqual([])
  })

  it('reports an unrecognized key instead of dropping it silently', () => {
    write(root, 'project: my-app\nnot_a_setting: 1\n')
    const { warn, lines } = spy()
    readProjectConfig(root, warn)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('not_a_setting')
    expect(lines[0]).toContain('.deploylog.yml')
    expect(lines[0]).toContain('Recognized: project, default_type')
  })

  it('WARNS rather than failing — the recognized keys still come back', () => {
    write(root, 'project: my-app\ndefault_type: fix\nfuture_setting: yes\n')
    const { warn, lines } = spy()
    expect(readProjectConfig(root, warn)).toEqual({ project: 'my-app', default_type: 'fix' })
    expect(lines).toHaveLength(1)
  })

  it('suggests the closest real key for a hyphen typo', () => {
    write(root, 'project: my-app\ndefault-type: fix\n')
    const { warn, lines } = spy()
    // The concrete papercut: the hyphen form parses, means nothing, and the
    // user gets the wrong default type with nothing pointing at the cause.
    expect(readProjectConfig(root, warn)).toEqual({ project: 'my-app' })
    expect(lines[0]).toContain('did you mean default_type?')
  })

  it('suggests the closest real key for a plural / camelCase typo', () => {
    write(root, 'projects: my-app\n')
    const { warn, lines } = spy()
    expect(readProjectConfig(root, warn)).toEqual({})
    expect(lines[0]).toContain('did you mean project?')

    write(root, 'defaultType: fix\n')
    const second = spy()
    readProjectConfig(root, second.warn)
    expect(second.lines[0]).toContain('did you mean default_type?')
  })

  it('offers NO suggestion for a key that resembles nothing', () => {
    // A wrong guess is worse than no guess.
    write(root, 'banana: split\n')
    const { warn, lines } = spy()
    readProjectConfig(root, warn)
    expect(lines[0]).toContain('banana')
    expect(lines[0]).not.toContain('did you mean')
  })

  it('lists every unrecognized key in one report', () => {
    write(root, 'project: my-app\nfoo: 1\nbar: 2\n')
    const { warn, lines } = spy()
    readProjectConfig(root, warn)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('foo')
    expect(lines[0]).toContain('bar')
    expect(lines[0]).toContain('settings')
  })

  it('throws when a RECOGNIZED key holds the wrong type', () => {
    // Unknown key → warn (it may belong to a newer CLI). Known key, wrong type
    // → error: it was meant for us, so letting YAML's coercion decide would
    // push to a project literally named "123".
    write(root, 'project: 123\n')
    expect(() => readProjectConfig(root, () => {})).toThrow(ProjectConfigError)
    expect(() => readProjectConfig(root, () => {})).toThrow(/must be a string, got number/)

    write(root, 'project:\n  - a\n  - b\n')
    expect(() => readProjectConfig(root, () => {})).toThrow(/must be a string, got a list/)
  })

  it('defaults to a real sink when no warn is injected', () => {
    // Guard against the default parameter being the thing that is broken: the
    // injected-spy tests would all pass over a default that throws.
    write(root, 'project: my-app\nnope: 1\n')
    const original = console.error
    const seen: unknown[] = []
    console.error = (...args: unknown[]) => void seen.push(args)
    try {
      expect(readProjectConfig(root)).toEqual({ project: 'my-app' })
    } finally {
      console.error = original
    }
    expect(seen).toHaveLength(1)
    expect(String(seen[0])).toContain('nope')
  })
})
