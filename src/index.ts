#!/usr/bin/env node

import { Command } from 'commander'
import chalk from 'chalk'
import { setApiKey, setApiUrl, getApiUrl, getConfigPath, clearConfig } from './config.js'
import {
  listProjects,
  listEntries,
  createProject,
  importGithub,
  whoami,
  ApiError,
  type ListEntriesFilters,
} from './api.js'
import { readProjectConfig } from './project-config.js'
import { runPush, defaultPushDeps, type PushOptions } from './push.js'
import {
  runSetPublished,
  runView,
  runEdit,
  runDelete,
  defaultEntryCommandDeps,
} from './entry-commands.js'
import { runInit, defaultInitDeps } from './init.js'
import { runOpen } from './open.js'
import { runManualExport } from './manual.js'
import { runManualVerify, isFailOn, FAIL_ON_VALUES, DEFAULT_FAIL_ON } from './manual-verify.js'

const program = new Command()

program
  .name('deploylog')
  .description('Push changelog entries from the terminal')
  // Without positional options, the global -V/--version greedily matches
  // `push --version 1.4.0` and prints the CLI version instead of setting the
  // entry's semver. Program options now must precede the subcommand.
  .enablePositionalOptions()
  .version('0.5.0')

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

const projectsCmd = program
  .command('projects')
  .alias('proj')
  .description('List projects in your organization')
  .option('--json', 'Output JSON (machine-readable, never prompts)')
  .action(async (opts: { json?: boolean }) => {
    try {
      const projects = await listProjects()

      if (opts.json) {
        printJson(projects)
        return
      }

      if (projects.length === 0) {
        console.log(chalk.dim('No projects found.'))
        return
      }

      console.log(chalk.bold('Projects:\n'))
      for (const p of projects) {
        console.log(`  ${chalk.cyan(p.name)}  ${chalk.dim(p.slug)}`)
      }
    } catch (err) {
      handleError(err, opts.json)
    }
  })

projectsCmd
  .command('create <name>')
  .description('Create a new project (slug is generated from the name)')
  .option('--url <url>', 'Project website URL')
  .option('--json', 'Output JSON (machine-readable, never prompts)')
  .action(async (name: string, opts: { url?: string; json?: boolean }, command: Command) => {
    // The parent `projects` command also defines --json and commander hands
    // the flag to whichever parsed it — honor both.
    const json = Boolean(opts.json || command.optsWithGlobals().json)
    try {
      const project = await createProject(name, opts.url)

      if (json) {
        printJson(project)
        return
      }

      console.log(`${chalk.green('✓')} Project created: ${chalk.bold(project.name)}`)
      console.log(`  Slug: ${chalk.cyan(project.slug)}`)
      console.log(chalk.dim(`  Public changelog: ${getApiUrl()}/p/${project.slug}/changelog`))
      console.log(chalk.dim('  Run `deploylog init` in the repo to wire pushes to it.'))
    } catch (err) {
      handleError(err, json)
    }
  })

// ─── whoami ─────────────────────────────────────────────────────────────────

program
  .command('whoami')
  .description('Show the authenticated org, plan, API key, and AI usage')
  .option('--json', 'Output JSON (machine-readable, never prompts)')
  .action(async (opts: { json?: boolean }) => {
    try {
      const me = await whoami()

      if (opts.json) {
        printJson({ ...me, api_url: getApiUrl(), config_path: getConfigPath() })
        return
      }

      const limitLabel = me.ai_usage.limit === null ? '∞' : String(me.ai_usage.limit)
      console.log(`${chalk.bold(me.organization.name)}  ${chalk.dim(me.organization.slug)}`)
      console.log(`  Plan:     ${chalk.cyan(me.organization.plan ?? 'free')}`)
      console.log(
        `  API key:  ${me.api_key.name}  ${chalk.dim(`${me.api_key.prefix}…  [${me.api_key.permissions.join(', ')}]`)}`,
      )
      if (me.api_key.last_used_at) {
        console.log(chalk.dim(`  Last used: ${me.api_key.last_used_at}`))
      }
      console.log(
        `  AI usage: ${me.ai_usage.used}/${limitLabel} this month ${chalk.dim(`(${me.ai_usage.month_key})`)}`,
      )
      console.log(chalk.dim(`  API URL:  ${getApiUrl()}`))
      console.log(chalk.dim(`  Config:   ${getConfigPath()}`))
    } catch (err) {
      handleError(err, opts.json)
    }
  })

// ─── manual ─────────────────────────────────────────────────────────────────

const manual = program.command('manual').description('Work with a project\'s manual')

manual
  .command('export')
  .description('Export the whole manual (every version, commit map, chapter and claim) as JSON')
  .option('-p, --project <slug>', 'Project slug (or set in .deploylog.yml)')
  .option('-o, --out <path>', 'Output file (default: ./<slug>-manual.json; - for stdout)')
  .option('--json', 'Output JSON (machine-readable, never prompts)')
  .action(async (opts: { project?: string; out?: string; json?: boolean }) => {
    try {
      const result = await runManualExport({ project: opts.project, out: opts.out })
      switch (result.kind) {
        case 'written':
          if (opts.json) printJson({ path: result.path, versions: result.versions })
          else
            console.log(
              `${chalk.green('✓')} Wrote ${chalk.bold(result.path)} ${chalk.dim(`(${result.versions} version${result.versions === 1 ? '' : 's'})`)}`,
            )
          break
        case 'streamed':
          // The payload is already on stdout and is the whole of stdout.
          break
        default:
          if (opts.json)
            printJsonError(result.kind.toUpperCase().replace(/-/g, '_'), result.message)
          else console.error(chalk.red(result.message))
          process.exit(1)
      }
    } catch (err) {
      handleError(err, opts.json)
    }
  })

manual
  .command('verify')
  .description('Check the manual against the code it cites at this commit; exit code follows --fail-on')
  .option('-p, --project <slug>', 'Project slug (or set in .deploylog.yml)')
  .option('--repository <owner/repo>', 'Repository to verify as (default: parsed from `git remote get-url origin`)')
  .option('--ref <sha>', 'Full commit sha to verify at (default: `git rev-parse HEAD`)')
  .option('--changed-from <base>', 'Only claims citing files changed since <base> (default: the whole manual)')
  .option(
    '--fail-on <mode>',
    `What fails the check: ${FAIL_ON_VALUES.join(' | ')} (default: ${DEFAULT_FAIL_ON})`,
  )
  .option('--json', 'Print the validated report as JSON on stdout, nothing else')
  .action(
    async (opts: {
      project?: string
      repository?: string
      ref?: string
      changedFrom?: string
      failOn?: string
      json?: boolean
    }) => {
      try {
        const failOn = opts.failOn?.trim().toLowerCase()
        if (failOn !== undefined && !isFailOn(failOn)) {
          const message = `Invalid value for --fail-on: "${opts.failOn}". Expected one of: ${FAIL_ON_VALUES.join(', ')}.`
          if (opts.json) printJsonError('INVALID_FAIL_ON', message)
          else console.error(chalk.red(message))
          process.exit(1)
        }
        const result = await runManualVerify({
          project: opts.project,
          repository: opts.repository,
          ref: opts.ref,
          changedFrom: opts.changedFrom,
          failOn: failOn,
          json: opts.json,
        })
        switch (result.kind) {
          case 'verified':
            // The report (or the JSON payload) is already on stdout; only the
            // exit code is left, and it is the whole point of the command.
            if (result.exitCode !== 0) process.exit(result.exitCode)
            break
          default:
            if (opts.json)
              printJsonError(result.kind.toUpperCase().replace(/-/g, '_'), result.message)
            else console.error(chalk.red(result.message))
            process.exit(1)
        }
      } catch (err) {
        handleError(err, opts.json)
      }
    },
  )

// ─── list ───────────────────────────────────────────────────────────────────

program
  .command('list')
  .alias('ls')
  .description('List recent entries for a project')
  .option('-p, --project <slug>', 'Project slug (or set in .deploylog.yml)')
  .option('--drafts', 'Only drafts')
  .option('--published', 'Only published entries')
  .option('-T, --type <type>', 'Filter by entry type')
  .option('-n, --limit <n>', 'Max entries to show (1-50)', (v) => parseInt(v, 10))
  .option('--json', 'Output JSON (machine-readable, never prompts)')
  .action(
    async (opts: {
      project?: string
      drafts?: boolean
      published?: boolean
      type?: string
      limit?: number
      json?: boolean
    }) => {
      try {
        if (opts.drafts && opts.published) {
          console.error(chalk.red('Use at most one of --drafts / --published.'))
          process.exit(1)
        }

        const slug = resolveProject(opts.project)
        const filters: ListEntriesFilters = {}
        if (opts.drafts) filters.status = 'draft'
        if (opts.published) filters.status = 'published'
        if (opts.type) filters.type = opts.type
        if (opts.limit !== undefined) filters.limit = opts.limit

        const entries = await listEntries(slug, filters)

        if (opts.json) {
          printJson(entries)
          return
        }

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
          console.log(`    ${chalk.dim(`${e.slug}  ${e.id}`)}`)
        }

        const effectiveLimit = filters.limit ?? 50
        if (entries.length >= effectiveLimit) {
          console.log(
            chalk.dim(
              `\nShowing the ${entries.length} most recent. Older entries: narrow with --drafts / --published / --type, or reference by id.`,
            ),
          )
        }
      } catch (err) {
        handleError(err, opts.json)
      }
    },
  )

// ─── view ───────────────────────────────────────────────────────────────────

program
  .command('view <entry>')
  .alias('show')
  .description('Show a full entry (slug or id), including its markdown body')
  .option('-p, --project <slug>', 'Project slug (or set in .deploylog.yml)')
  .option('--json', 'Output JSON (machine-readable, never prompts)')
  .action(async (ref: string, opts: { project?: string; json?: boolean }) => {
    try {
      const result = await runView({ ref, project: opts.project })
      if (result.kind !== 'found') {
        if (opts.json) {
          printJsonError('NOT_FOUND', result.message)
        } else {
          console.error(chalk.red(result.message))
        }
        process.exit(1)
      }

      const e = result.entry
      if (opts.json) {
        printJson(e)
        return
      }

      const status = e.published ? chalk.green('published') : chalk.yellow('draft')
      console.log(`${chalk.bold(e.title)}  ${status}`)
      console.log(chalk.dim(`  id:      ${e.id}`))
      console.log(chalk.dim(`  slug:    ${e.slug}`))
      if (e.entry_type) console.log(chalk.dim(`  type:    ${e.entry_type}`))
      if (e.version) console.log(chalk.dim(`  version: v${e.version}`))
      console.log(chalk.dim(`  created: ${e.created_at}`))
      if (e.published_at) console.log(chalk.dim(`  published: ${e.published_at}`))
      console.log()
      console.log(e.body_markdown)
    } catch (err) {
      handleError(err, opts.json)
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
  .option('--json', 'Output JSON (machine-readable, never prompts)')
  .action(async (opts: PushOptions & { json?: boolean }) => {
    try {
      // JSON mode is a machine contract: no prompts (non-TTY path), progress
      // and notices to stderr, stdout reserved for the data payload.
      const deps = opts.json
        ? {
            ...defaultPushDeps,
            isTTY: false,
            out: {
              progressStart: (msg: string) => process.stderr.write(`${msg} `),
              progressDone: (msg: string) => process.stderr.write(`${msg}\n`),
              notice: (msg: string) => console.error(msg),
              aiPreview: () => {},
            },
          }
        : defaultPushDeps
      const result = await runPush(opts, deps)
      switch (result.kind) {
        case 'created': {
          const entry = result.entry
          if (opts.json) {
            printJson(entry)
            break
          }
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
          if (opts.json) printJsonError('NO_COMMITS', result.message)
          else console.error(chalk.yellow(result.message))
          process.exit(1)
        default:
          // no-ai-source | missing-fields — a misuse refusal.
          if (opts.json) printJsonError(result.kind.toUpperCase().replace(/-/g, '_'), result.message)
          else console.error(chalk.red(result.message))
          process.exit(1)
      }
    } catch (err) {
      handleError(err, opts.json)
    }
  })

// ─── edit ───────────────────────────────────────────────────────────────────

program
  .command('edit <entry>')
  .description('Edit an entry (slug or id) via flags, --body-file, or $EDITOR')
  .option('-p, --project <slug>', 'Project slug (or set in .deploylog.yml)')
  .option('-t, --title <title>', "New title (may change a draft's slug)")
  .option('-T, --type <type>', 'Entry type: feature, fix, improvement, breaking, announcement')
  .option('--version <version>', 'Semver version (pass "" to clear)')
  .option('-b, --body <markdown>', 'New body (Markdown)')
  .option('--body-file <path>', 'Read the new body from a file (- for stdin)')
  .option('--json', 'Output JSON (machine-readable, never prompts)')
  .action(
    async (
      ref: string,
      opts: {
        project?: string
        title?: string
        type?: string
        version?: string
        body?: string
        bodyFile?: string
        json?: boolean
      },
    ) => {
      try {
        // JSON mode never opens $EDITOR — force the non-interactive path.
        const deps = opts.json ? { ...defaultEntryCommandDeps, isTTY: false } : undefined
        const result = await runEdit({ ref, ...opts }, deps)
        switch (result.kind) {
          case 'updated': {
            const e = result.entry
            if (opts.json) {
              printJson({ ...e, previous_slug: result.previousSlug })
              break
            }
            console.log(`${chalk.green('✓')} Updated: ${chalk.bold(e.title)}`)
            if (e.slug !== result.previousSlug) {
              console.log(
                chalk.yellow(`  Slug changed from '${result.previousSlug}' to '${e.slug}'.`),
              )
              console.log(chalk.dim('  Scripts referencing the old slug should switch to the id.'))
            } else {
              console.log(`  Slug: ${chalk.dim(e.slug)}`)
            }
            break
          }
          case 'unchanged':
          case 'cancelled':
            if (opts.json) printJsonError(result.kind.toUpperCase(), result.message)
            else console.log(chalk.yellow(result.message))
            break
          case 'body-rejected':
            if (opts.json) printJsonError('VALIDATION_ERROR', result.message)
            else console.error(chalk.red(result.message))
            process.exit(1)
          default:
            if (opts.json)
              printJsonError(result.kind.toUpperCase().replace(/-/g, '_'), result.message)
            else console.error(chalk.red(result.message))
            process.exit(1)
        }
      } catch (err) {
        handleError(err, opts.json)
      }
    },
  )

// ─── import ─────────────────────────────────────────────────────────────────

const importCmd = program
  .command('import')
  .description('Import entries from an external source')

importCmd
  .command('github <repo>')
  .description('Import GitHub releases as draft entries (owner/repo or a github.com URL)')
  .option('-p, --project <slug>', 'Project slug (or set in .deploylog.yml)')
  .option(
    '--token <token>',
    'GitHub personal access token for private repos / rate limits (or set DEPLOYLOG_GITHUB_TOKEN); never stored',
  )
  .option('--json', 'Output JSON (machine-readable, never prompts)')
  .action(async (repo: string, opts: { project?: string; token?: string; json?: boolean }) => {
    try {
      const slug = resolveProject(opts.project)
      const token = opts.token ?? process.env.DEPLOYLOG_GITHUB_TOKEN
      const result = await importGithub(slug, repo, token)

      if (opts.json) {
        printJson(result)
        return
      }

      if (result.imported === 0 && result.skipped === 0) {
        console.log(chalk.yellow('No releases found to import.'))
        return
      }
      console.log(
        `${chalk.green('✓')} Imported ${chalk.bold(String(result.imported))} release${result.imported === 1 ? '' : 's'} as drafts` +
          (result.skipped > 0 ? chalk.dim(` (${result.skipped} already imported, skipped)`) : ''),
      )
      if (result.imported > 0) {
        console.log(chalk.dim('  Review with `deploylog list --drafts`, then `deploylog publish <slug>`.'))
      }
    } catch (err) {
      handleError(err, opts.json)
    }
  })

// ─── init ───────────────────────────────────────────────────────────────────

program
  .command('init')
  .description('Scaffold a .deploylog.yml in this directory (project + optional default type)')
  .option('-p, --project <slug>', 'Project slug (interactive pick if omitted)')
  .option('-T, --type <type>', 'Default entry type for pushes from this repo')
  .option('--force', 'Overwrite an existing .deploylog.yml')
  .option('--json', 'Output JSON (machine-readable, never prompts)')
  .action(async (opts: { project?: string; type?: string; force?: boolean; json?: boolean }) => {
    try {
      const deps = opts.json ? { ...defaultInitDeps, isTTY: false } : undefined
      const result = await runInit(opts, deps)
      switch (result.kind) {
        case 'written':
          if (opts.json) {
            printJson({ path: result.path, project: result.project, default_type: result.defaultType ?? null })
            break
          }
          console.log(`${chalk.green('✓')} Wrote ${result.path}`)
          console.log(`  project: ${chalk.cyan(result.project)}`)
          if (result.defaultType) console.log(`  default_type: ${chalk.cyan(result.defaultType)}`)
          console.log(chalk.dim('  `deploylog push` in this directory now targets that project.'))
          break
        case 'cancelled':
          console.log(chalk.yellow(result.message))
          break
        default:
          if (opts.json)
            printJsonError(result.kind.toUpperCase().replace(/-/g, '_'), result.message)
          else console.error(chalk.red(result.message))
          process.exit(1)
      }
    } catch (err) {
      handleError(err, opts.json)
    }
  })

// ─── delete ─────────────────────────────────────────────────────────────────

program
  .command('delete <entry>')
  .alias('rm')
  .description('Delete an entry permanently (slug or id)')
  .option('-p, --project <slug>', 'Project slug (or set in .deploylog.yml)')
  .option('-y, --yes', 'Skip the confirmation prompt (required in non-interactive mode)')
  .option('--json', 'Output JSON (machine-readable, never prompts)')
  .action(async (ref: string, opts: { project?: string; yes?: boolean; json?: boolean }) => {
    try {
      // JSON mode never prompts — deletion then requires an explicit --yes.
      const deps = opts.json ? { ...defaultEntryCommandDeps, isTTY: false } : undefined
      const result = await runDelete({ ref, project: opts.project, yes: opts.yes }, deps)
      switch (result.kind) {
        case 'deleted':
          if (opts.json) {
            printJson({ id: result.id, title: result.title, deleted: true })
            break
          }
          console.log(`${chalk.green('✓')} Deleted: ${chalk.bold(result.title)}`)
          break
        case 'cancelled':
          console.log(chalk.yellow(result.message))
          break
        default:
          if (opts.json)
            printJsonError(result.kind.toUpperCase().replace(/-/g, '_'), result.message)
          else console.error(chalk.red(result.message))
          process.exit(1)
      }
    } catch (err) {
      handleError(err, opts.json)
    }
  })

// ─── publish / unpublish ────────────────────────────────────────────────────

program
  .command('publish <entry>')
  .alias('pub')
  .description('Publish a draft entry (slug or id); sends the email digest on Pro')
  .option('-p, --project <slug>', 'Project slug (or set in .deploylog.yml)')
  .option('--json', 'Output JSON (machine-readable, never prompts)')
  .action(async (ref: string, opts: { project?: string; json?: boolean }) => {
    try {
      const result = await runSetPublished({ ref, project: opts.project, publish: true })
      switch (result.kind) {
        case 'updated': {
          const e = result.entry
          if (opts.json) {
            printJson(e)
            break
          }
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
          if (opts.json) printJsonError(result.kind.toUpperCase().replace(/-/g, '_'), result.message)
          else console.error(chalk.red(result.message))
          process.exit(1)
      }
    } catch (err) {
      handleError(err, opts.json)
    }
  })

program
  .command('unpublish <entry>')
  .alias('unpub')
  .description('Revert a published entry to draft (its public URL and feeds drop it)')
  .option('-p, --project <slug>', 'Project slug (or set in .deploylog.yml)')
  .option('--json', 'Output JSON (machine-readable, never prompts)')
  .action(async (ref: string, opts: { project?: string; json?: boolean }) => {
    try {
      const result = await runSetPublished({ ref, project: opts.project, publish: false })
      switch (result.kind) {
        case 'updated': {
          const e = result.entry
          if (opts.json) {
            printJson(e)
            break
          }
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
          if (opts.json) printJsonError(result.kind.toUpperCase().replace(/-/g, '_'), result.message)
          else console.error(chalk.red(result.message))
          process.exit(1)
      }
    } catch (err) {
      handleError(err, opts.json)
    }
  })

// ─── open ───────────────────────────────────────────────────────────────────

program
  .command('open [entry]')
  .alias('o')
  .description("Open the project's public changelog (or one entry's page) in the browser")
  .option('-p, --project <slug>', 'Project slug (or set in .deploylog.yml)')
  .option('--json', 'Output JSON (machine-readable, never prompts)')
  .action(async (ref: string | undefined, opts: { project?: string; json?: boolean }) => {
    try {
      const result = await runOpen({ ref, project: opts.project })
      switch (result.kind) {
        case 'opened':
          if (opts.json) printJson({ url: result.url, opened: true })
          else console.log(chalk.dim(result.url))
          break
        case 'printed':
          if (opts.json) printJson({ url: result.url, opened: false })
          else console.log(result.url)
          break
        default:
          if (opts.json)
            printJsonError(result.kind.toUpperCase().replace(/-/g, '_'), result.message)
          else console.error(chalk.red(result.message))
          process.exit(1)
      }
    } catch (err) {
      handleError(err, opts.json)
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

/** JSON mode: raw data on stdout, so output pipes into jq/scripts cleanly. */
function printJson(data: unknown): void {
  console.log(JSON.stringify(data, null, 2))
}

/** JSON mode errors go to stderr in the API's own error envelope shape. */
function printJsonError(code: string, message: string): void {
  console.error(JSON.stringify({ error: { code, message } }))
}

function handleError(err: unknown, json?: boolean): void {
  if (json) {
    if (err instanceof ApiError) {
      printJsonError(err.code, err.message)
    } else {
      printJsonError('ERROR', err instanceof Error ? err.message : 'An unknown error occurred')
    }
    process.exit(1)
  }

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
