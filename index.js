/**
 * Host half of @local/dsh-uvroot-env.
 *
 * Owns the uvroot container registry and wires it into DSH's existing seams —
 * no DSH package import, only the services the composition already provides:
 *
 *   ctx.shellEnv    contributes the per-session container selection to every
 *                   model bash call as DSH_UVROOT_* variables;
 *   connection/request
 *                   serves the authenticated /api/uvroot/* JSON API the Web
 *                   client half drives (it runs after connection admission);
 *   ctx.tools       guards against running a workspace marked "virtual" on the
 *                   host when no container (or no confined mode) is selected.
 *
 * The command itself is wrapped by `lib/runner.sh`, which the bundle patch
 * installs as the sandbox provider's `runnerCommand`.
 *
 * @module @local/dsh-uvroot-env
 */

import { join } from 'node:path'
import { homedir } from 'node:os'
import { createApiHandler } from './lib/api.js'
import { UvrootStore, canonical } from './lib/store.js'

export const name = 'uvroot-env'
export const inject = ['shellEnv']

/**
 * Workspace-title marker for a virtual environment: a folder held between a
 * pair of angle brackets. DSH has no per-workspace-row slot, so the official
 * rename API is the one supported way to mark the row itself.
 */
const TITLE_MARK = '⟨📁⟩ '

/** PTC's in-process code tool (runs on the HOST, so it bypasses the container). */
const RUN_CODE_TOOL = 'run_code'

/** Tools that address a host path directly and therefore need containment. */
const FS_TOOLS = new Set(['read', 'write', 'edit', 'glob', 'grep', 'read_image'])

/** Resolve `<dsh home>/uvroot` the same way the Loader's `dshHomePath()` does. */
function dataRoot(ctx) {
  try {
    const helper = ctx.get('dshHomePath')
    if (typeof helper === 'function') return helper('uvroot')
  } catch { /* fall through to the environment */ }
  const home = process.env.DSH_HOME && process.env.DSH_HOME.length > 0
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh')
  return join(home, 'uvroot')
}

/**
 * Mount the plugin.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 */
export function apply(ctx) {
  const root = dataRoot(ctx)
  const store = new UvrootStore({
    root,
    warn: (message, error) => { ctx.logger?.warn?.(message, error) },
  })
  ctx.logger?.info?.(`uvroot-env: registry at ${root} (${store.settings.uvrootBin})`)

  // ── per-session container selection reaches every bash call ─────────────
  ctx.shellEnv.register({
    name: 'uvroot-env',
    variables: {
      DSH_UVROOT_SPEC: { description: 'Generated uvroot argv for the session container (empty when the session runs on the host).' },
      DSH_UVROOT_CONTAINER: { description: 'Id of the uvroot container the session runs in.' },
      DSH_UVROOT_WORKSPACE: { description: 'Canonical workspace path the container selects by.' },
    },
    resolve(execution) {
      const session = execution.agent?.session
      const cwd = session?.header?.cwd ?? process.cwd()
      const container = store.resolveContainerFor(cwd, session?.header?.id)
      if (container === undefined) return {}
      return {
        DSH_UVROOT_SPEC: store.specPath(container.id),
        DSH_UVROOT_CONTAINER: container.id,
        DSH_UVROOT_WORKSPACE: canonical(cwd),
      }
    },
  })

  // ── authenticated JSON API for the Web client ──────────────────────────
  const api = createApiHandler({ store })
  ctx.on('connection/request', (req, res, next) => api(req, res, next))

  // ── the workspace row carries the virtual-environment mark ─────────────
  // DSH exposes no per-workspace-row slot, so the marker rides the workspace
  // TITLE through the official rename API: `⟨📁⟩ <name>` while virtual, and
  // the plain name otherwise. Reconciliation is idempotent and runs on every
  // registry read, so it also covers workspaces created after the mode write.
  let titleSync = Promise.resolve()
  const syncWorkspaceTitles = () => {
    titleSync = titleSync.then(async () => {
      const registry = ctx.get('workspaceRegistry')
      if (registry === undefined) return
      for (const workspace of registry.list()) {
        const virtual = store.peek(workspace.path)?.mode === 'virtual'
        const marked = workspace.title.startsWith(TITLE_MARK)
        try {
          if (virtual && !marked) await workspace.setTitle(`${TITLE_MARK}${workspace.title}`)
          else if (!virtual && marked) await workspace.setTitle(workspace.title.slice(TITLE_MARK.length))
        } catch (error) {
          ctx.logger?.warn?.('uvroot-env: could not update a workspace title', error)
        }
      }
    }).catch(() => {})
    return titleSync
  }

  const snapshot = store.snapshot.bind(store)
  store.snapshot = () => { void syncWorkspaceTitles(); return snapshot() }
  const setWorkspaceMode = store.setWorkspaceMode.bind(store)
  store.setWorkspaceMode = (path, mode) => {
    const result = setWorkspaceMode(path, mode)
    void syncWorkspaceTitles()
    return result
  }

  // ── container isolation guards ─────────────────────────────────────────
  ctx.inject(['tools', 'sandboxPolicy'], (scope) => {
    scope.tools.guard((exec) => {
      const session = exec.agent?.session
      if (session === undefined) return undefined
      const cwd = session.header.cwd
      if (cwd === undefined) return undefined
      const found = store.findWorkspace(cwd)
      if (found === undefined || found.entry.mode !== 'virtual') return undefined

      if (exec.name === 'bash' || exec.name === 'bash_persistent') {
        const container = store.resolveContainerFor(cwd, session.header.id)
        if (container === undefined) {
          return '该工作目录已开启虚拟环境模式，但当前会话尚未选择容器。请在输入框左侧的容器选择器中选择或新建一个容器。'
        }
        let mode
        try {
          mode = scope.sandboxPolicy.resolve({ session }).mode
        } catch {
          return undefined
        }
        if (mode === 'danger-full-access') {
          return '虚拟环境容器需要受限的文件策略才能在容器内执行命令。请把权限切换为「工作区只读」或「工作区可写」。'
        }
        return undefined
      }

      // Everything below exists so NO other tool can reach the host around the
      // container. `strictIsolation: false` relaxes it for debugging.
      if (store.settings.strictIsolation === false) return undefined
      const hint = '可在「设置 → 虚拟环境 → 严格隔离」中关闭。'
      if (exec.name === RUN_CODE_TOOL) {
        return `虚拟环境已开启严格隔离：run_code 在宿主进程里执行代码，会绕过容器。${hint}`
      }
      if (exec.name.startsWith('mcp__')) {
        return `虚拟环境已开启严格隔离：MCP 工具作为宿主进程运行，会绕过容器。${hint}`
      }
      if (!FS_TOOLS.has(exec.name)) return undefined
      const requested = exec.arguments?.file_path ?? exec.arguments?.path
      if (typeof requested !== 'string' || requested.length === 0) return undefined
      const root = canonical(cwd)
      const target = canonical(requested.startsWith('/') ? requested : join(root, requested))
      if (target === root || target.startsWith(`${root}/`)) return undefined
      return `虚拟环境已开启严格隔离：${exec.name} 只能访问工作目录内的路径（${root}），` +
        `请求的是 ${target}。容器内的命令请用 bash 在容器里访问。${hint}`
    })
  })
}
