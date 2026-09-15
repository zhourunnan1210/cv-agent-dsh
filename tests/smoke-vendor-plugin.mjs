/**
 * Smoke test: load the vendored dsh-ai4scholar build and drive `apply` against a
 * minimal fake Cordis context, then report exactly which tools it registers.
 *
 * This is a real load test of the built artifact: it resolves the package's
 * declared entry point, applies the shipped config schema (so defaults match a
 * real deployment), and records every ctx.tools.defineTool registration.
 *
 * It does NOT test network reachability or ai4scholar.net credentials.
 */
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

// The vendored package is deliberately NOT hoisted into the workspace root
// node_modules: it is a standalone installable plugin, verified through its own
// manifest so the test always exercises its real declared entry point.
const require = createRequire(
  fileURLToPath(new URL('../packages/vendor/dsh-ai4scholar/package.json', import.meta.url)),
)
const entry = require.resolve('dsh-ai4scholar')
// require.resolve yields a native absolute path, which the ESM loader only
// accepts as a file:// URL on Windows.
const plugin = await import(pathToFileURL(entry).href)

const schema = plugin.Config
const config = typeof schema === 'function' ? schema({}) : {}

const registered = []
const sections = []
const commands = []

const fakeCtx = {
  tools: {
    // Real contract (dsh-tools ToolRuntime): `register(definition) => disposer`,
    // where `definition` is what `defineTool` compiles.
    register(definition) {
      registered.push(definition)
      return () => {}
    },
  },
  systemPrompt: {
    section(entry) {
      sections.push(entry)
      return () => {}
    },
  },
  commands: {
    register(definition) {
      commands.push(definition)
      return () => {}
    },
  },
  credentials: {
    resolve() {
      return undefined
    },
  },
  inject(_names, callback) {
    // Optional service (`settings`) is absent in this fake deployment.
    void callback
  },
  effect(callback) {
    const disposer = callback()
    return typeof disposer === 'function' ? disposer : () => {}
  },
  get() {
    return undefined
  },
}

plugin.apply(fakeCtx, config)

const names = registered.map((tool) => tool.name).sort()
const withParams = registered.filter((tool) => tool.parameters !== undefined).length
const withRender = registered.filter((tool) => tool.output?.render !== undefined).length

const report = {
  resolvedEntry: entry,
  pluginName: plugin.name,
  declaredInject: plugin.inject,
  toolCount: registered.length,
  toolsWithParameterSchema: withParams,
  toolsWithRenderer: withRender,
  promptSections: sections.length,
  commandsRegistered: commands.length,
  toolNames: names,
}

console.log(JSON.stringify(report, null, 2))

if (registered.length === 0) {
  console.error('SMOKE FAIL: apply() registered no tools')
  process.exit(1)
}
if (withParams !== registered.length) {
  console.error('SMOKE FAIL: some tools have no parameter schema')
  process.exit(1)
}
console.log('SMOKE OK')
