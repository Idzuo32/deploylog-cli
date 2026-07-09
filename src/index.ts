#!/usr/bin/env node

import { Command } from 'commander'
import chalk from 'chalk'
import { setApiKey, setApiUrl, getConfigPath, clearConfig } from './config.js'
import { listProjects, listEntries, ApiError } from './api.js'
import { readProjectConfig } from './project-config.js'
import { runPush, type PushOptions } from './push.js'
import { runSetPublished } from './entry-commands.js'

const program = new Command()

program
  .name('deploylog')
  .description('Push changelog entries from the terminal')
  .version('0.3.0')

// ─── login ──────────────────────────────────────────────────────────────────

program
  .command('login')
  .description('Authenticate with an API key')
  .option('--key <key>', 'API key (starts with dk_)')
  .option('--api-url <url>', 'API base URL (default: https://deploylog.dev)')
  .action(async (opts: { key?: string; apiUrl?: string }) => {
    if (opts.apiUrl) {
      let parsed: URL
      try {
        parsed = new URL(opts.apiUrl.trim())
      } catch {
        console.error(chalk.red('Invalid API URL. Provide a valid absolute URL.'))
        process.exit(1)
      }
      // Require http(s) and a real host — a scheme-only value like "https://"
      // parses but would break request URL construction.
      if (!/^https?:$/.test(parsed.protocol) || !parsed.hostname) {
        console.error(chalk.red('Invalid API URL. Must use http(s) and include a host.'))
        process.exit(1)
      }
      setApiUrl(opts.apiUrl)
    }

    if (opts.key) {
      if (!opts.key.startsWith('dk_')) {
        console.error(chalk.red('Invalid API key. Keys start with dk_'))
        process.exit(1)
      }
      setApiKey(opts.key)
      console.log(chalk.green('Authenticated successfully.'))
      console.log(chalk.dim(`Config saved to ${getConfigPath()}`))
      return
    }

    // Interactive: prompt for key
    const { createInterface } = await import('node:readline')
    const rl = createInterface({ input: process.stdin, output: process.stdout })

    const key = await new Promise<string>((resolve) => {
      rl.question('Enter your API key (from Dashboard → API Keys): ', resolve)
    })
    rl.close()

    const trimmed = key.trim()
    if (!trimmed.startsWith('dk_')) {
      console.error(chalk.red('Invalid API key. Keys start with dk_'))
      process.exit(1)
    }

    setApiKey(trimmed)
    console.log(chalk.green('Authenticated successfully.'))
    console.log(chalk.dim(`Config saved to ${getConfigPath()}`))
  })

// ─── logout ─────────────────────────────────────────────────────────────────

program
  .command('logout')
  .description('Remove stored credentials')
  .action(() => {
    clearConfig()
    console.log(chalk.green('Logged out. Credentials removed.'))
  })

// ─── projects ───────────────────────────────────────────────────────────────

program
  .command('projects')
  .description('List projects in your organization')
  .action(async () => {
    try {
      const projects = await listProjects()

      if (projects.length === 0) {
        console.log(chalk.dim('No projects found.'))
        return
      }

      console.log(chalk.bold('Projects:\n'))
      for (const p of projects) {
        console.log(`  ${chalk.cyan(p.name)}  ${chalk.dim(p.slug)}`)
      }
    } catch (err) {
      handleError(err)
    }
  })

// ─── list ───────────────────────────────────────────────────────────────────

program
  .command('list')
  .description('List recent entries for a project')
  .option('-p, --project <slug>', 'Project slug (or set in .deploylog.yml)')
  .action(async (opts: { project?: string }) => {
    try {
      const slug = resolveProject(opts.project)
      const entries = await listEntries(slug)

      if (entries.length === 0) {
        console.log(chalk.dim('No entries found.'))
        return
      }

      console.log(chalk.bold(`Entries for ${slug}:\n`))
      for (const e of entries) {
        const status = e.published
          ? chalk.green('published')
          : chalk.yellow('draft')
        const type = e.entry_type ? chalk.dim(`[${e.entry_type}]`) : ''
        const version = e.version ? chalk.dim(`v${e.version}`) : ''
        const date = new Date(e.created_at).toLocaleDateString('en-US', {
          month: 'short',
          day: 'numeric',
        })

        console.log(`  ${status}  ${e.title}  ${type}  ${version}  ${chalk.dim(date)}`)
      }
    } catch (err) {
      handleError(err)
    }
  })

// ─── push ───────────────────────────────────────────────────────────────────

program
  .command('push')
  .description('Create a new changelog entry')
  .option('-t, --title <title>', 'Entry title (required unless --from-git or --ai-summarize)')
  .option('-b, --body <markdown>', 'Entry body (Markdown)')
  .option('-p, --project <slug>', 'Project slug (or set in .deploylog.yml)')
  .option('-T, --type <type>', 'Entry type: feature, fix, improvement, breaking, announcement')
  .option('--version <version>', 'Semver version (e.g. 1.2.3)')
  .option('-P, --publish', 'Publish immediately (default: draft)')
  .option('-D, --draft', 'Save as draft (default)')
  .option('-g, --from-git', 'Derive title/body from commits since the last tag')
  .option('--git', 'Alias of --from-git')
  .option('-a, --ai-summarize', 'Rewrite the entry with Claude Haiku (user-friendly release notes)')
  .option('--ai', 'Alias of --ai-summarize')
  .option('-y, --yes', 'Skip interactive confirmation for AI-generated content')
  .action(async (opts: PushOptions) => {
    try {
      const result = await runPush(opts)
      switch (result.kind) {
        case 'created': {
          const entry = result.entry
          const status = entry.published ? chalk.green('Published') : chalk.yellow('Draft')
          console.log(`\n${chalk.green('✓')} Entry created: ${chalk.bold(entry.title)}`)
          console.log(`  Status: ${status}`)
          console.log(`  Slug:   ${chalk.dim(entry.slug)}`)
          if (entry.version) console.log(`  Version: ${chalk.dim(`v${entry.version}`)}`)
          break
        }
        case 'cancelled':
          // User declined at the confirm prompt — a clean, non-error stop.
          console.log(chalk.yellow(result.message))
          break
        case 'no-commits':
          // Valid command, nothing to do — warn (yellow) and exit non-zero.
          console.error(chalk.yellow(result.message))
          process.exit(1)
        default:
          // no-ai-source | missing-fields — a misuse refusal.
          console.error(chalk.red(result.message))
          process.exit(1)
      }
    } catch (err) {
      handleError(err)
    }
  })

// ─── publish / unpublish ────────────────────────────────────────────────────

program
  .command('publish <entry>')
  .alias('pub')
  .description('Publish a draft entry (slug or id); sends the email digest on Pro')
  .option('-p, --project <slug>', 'Project slug (or set in .deploylog.yml)')
  .action(async (ref: string, opts: { project?: string }) => {
    try {
      const result = await runSetPublished({ ref, project: opts.project, publish: true })
      switch (result.kind) {
        case 'updated': {
          const e = result.entry
          if (!e.changed) {
            console.log(chalk.yellow(`Entry is already published — nothing to do.`))
            console.log(`  ${chalk.dim('Slug:')} ${e.slug}`)
            break
          }
          console.log(`${chalk.green('✓')} Published: ${chalk.bold(e.title)}`)
          console.log(`  Slug: ${chalk.dim(e.slug)}`)
          console.log(chalk.dim('  Subscribers get the email digest (Pro plans, first publish only).'))
          break
        }
        default:
          console.error(chalk.red(result.message))
          process.exit(1)
      }
    } catch (err) {
      handleError(err)
    }
  })

program
  .command('unpublish <entry>')
  .alias('unpub')
  .description('Revert a published entry to draft (its public URL and feeds drop it)')
  .option('-p, --project <slug>', 'Project slug (or set in .deploylog.yml)')
  .action(async (ref: string, opts: { project?: string }) => {
    try {
      const result = await runSetPublished({ ref, project: opts.project, publish: false })
      switch (result.kind) {
        case 'updated': {
          const e = result.entry
          if (!e.changed) {
            console.log(chalk.yellow(`Entry is already a draft — nothing to do.`))
            break
          }
          console.log(`${chalk.green('✓')} Unpublished: ${chalk.bold(e.title)}`)
          console.log(
            chalk.dim(
              '  The public page and feeds drop it (cached copies may lag a few minutes).\n' +
                '  Republishing sets a new publish date.',
            ),
          )
          break
        }
        default:
          console.error(chalk.red(result.message))
          process.exit(1)
      }
    } catch (err) {
      handleError(err)
    }
  })

// ─── helpers ────────────────────────────────────────────────────────────────

function resolveProject(cliArg?: string): string {
  if (cliArg) return cliArg

  const config = readProjectConfig()
  if (config?.project) return config.project

  console.error(chalk.red('No project specified.'))
  console.error('Use --project <slug> or create a .deploylog.yml with:')
  console.error(chalk.dim('  project: my-app'))
  process.exit(1)
}

function handleError(err: unknown): void {
  if (err instanceof ApiError) {
    console.error(chalk.red(`Error: ${err.message}`))
    if (err.status === 401) {
      console.error(chalk.dim('Run `deploylog login` to authenticate.'))
    }
    process.exit(1)
  }

  if (err instanceof Error) {
    console.error(chalk.red(err.message))
    process.exit(1)
  }

  console.error(chalk.red('An unknown error occurred'))
  process.exit(1)
}

program.parse()
