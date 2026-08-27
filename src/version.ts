import { readFileSync } from 'node:fs'

/**
 * The CLI's version, read from the package's own `package.json` at start-up.
 *
 * `index.ts` used to hardcode the string and drifted (`0.5.0` shipped on the
 * `0.6.0` package; found by the MCP-server red-team, 2026-08-27). The package
 * root is one directory above both `dist/` and `src/`, so the same relative URL
 * resolves from the built entrypoint and under vitest. No fallback on purpose:
 * a package without a readable `package.json` is a broken install, and a
 * placeholder version would hide that.
 */
export function getCliVersion(pkgUrl: URL = new URL('../package.json', import.meta.url)): string {
  const pkg = JSON.parse(readFileSync(pkgUrl, 'utf8')) as { version?: unknown }
  if (typeof pkg.version !== 'string' || pkg.version.length === 0) {
    throw new Error(`package.json at ${pkgUrl.pathname} has no version field`)
  }
  return pkg.version
}
