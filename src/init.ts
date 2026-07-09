import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { listProjects, type Project } from './api.js'

const ENTRY_TYPES = ['feature', 'fix', 'improvement', 'breaking', 'announcement']

export interface InitOptions {
  project?: string
  type?: string
  force?: boolean
}

export type InitResult =
  | { kind: 'written'; path: string; project: string; defaultType?: string }
  | { kind: 'exists'; message: string }
  | { kind: 'cancelled'; message: string }
  | { kind: 'missing-fields'; message: string }

export interface InitDeps {
  api: { listProjects(): Promise<Project[]> }
  exists(path: string): boolean
  write(path: string, content: string): void
  /** Numbered pick from a list; resolves null when the user bails. */
  select(question: string, choices: string[]): Promise<string | null>
  isTTY: boolean
  cwd(): string
}

/**
 * Scaffold .deploylog.yml in the current directory. Keys must match what
 * readProjectConfig() consumes: `project` and `default_type`.
 */
export async function runInit(
  opts: InitOptions,
  deps: InitDeps = defaultInitDeps,
): Promise<InitResult> {
  const path = join(deps.cwd(), '.deploylog.yml')

  if (deps.exists(path) && !opts.force) {
    return {
      kind: 'exists',
      message: `${path} already exists. Pass --force to overwrite it.`,
    }
  }

  if (opts.type !== undefined && !ENTRY_TYPES.includes(opts.type)) {
    return {
      kind: 'missing-fields',
      message: `Unknown default type '${opts.type}'. One of: ${ENTRY_TYPES.join(', ')}.`,
    }
  }

  const projects = await deps.api.listProjects()
  if (projects.length === 0) {
    return {
      kind: 'missing-fields',
      message: 'No projects in your organization yet. Create one first: deploylog projects create <name>',
    }
  }

  let projectSlug = opts.project
  if (projectSlug !== undefined) {
    if (!projects.some((p) => p.slug === projectSlug)) {
      return {
        kind: 'missing-fields',
        message:
          `Project '${projectSlug}' not found in your organization.\n` +
          `Available: ${projects.map((p) => p.slug).join(', ')}`,
      }
    }
  } else if (projects.length === 1) {
    projectSlug = projects[0]!.slug
  } else {
    if (!deps.isTTY) {
      return {
        kind: 'missing-fields',
        message: 'Multiple projects found. Pass --project <slug> in non-interactive mode.',
      }
    }
    const picked = await deps.select(
      'Which project should this directory push to?',
      projects.map((p) => `${p.slug}  (${p.name})`),
    )
    if (picked === null) {
      return { kind: 'cancelled', message: 'Cancelled. No config written.' }
    }
    projectSlug = picked.split('  ')[0]!
  }

  const lines = [`project: ${projectSlug}`]
  if (opts.type) lines.push(`default_type: ${opts.type}`)
  deps.write(path, lines.join('\n') + '\n')

  const result: InitResult = { kind: 'written', path, project: projectSlug }
  if (opts.type) return { ...result, defaultType: opts.type }
  return result
}

async function selectPrompt(question: string, choices: string[]): Promise<string | null> {
  const { createInterface } = await import('node:readline')
  const rl = createInterface({ input: process.stdin, output: process.stdout })

  console.log(question)
  choices.forEach((c, i) => console.log(`  ${i + 1}) ${c}`))

  const answer = await new Promise<string>((resolve) => {
    rl.question(`Choose [1-${choices.length}]: `, resolve)
  })
  rl.close()

  const idx = parseInt(answer.trim(), 10)
  if (!Number.isInteger(idx) || idx < 1 || idx > choices.length) return null
  return choices[idx - 1] ?? null
}

export const defaultInitDeps: InitDeps = {
  api: { listProjects },
  exists: existsSync,
  write: (path, content) => writeFileSync(path, content, 'utf8'),
  select: selectPrompt,
  isTTY: Boolean(process.stdin.isTTY),
  cwd: () => process.cwd(),
}
