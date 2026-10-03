/**
 * Authenticated HTTP surface for @local/dsh-uvroot-env.
 *
 * Registered as a `connection/request` waterfall listener, which runs AFTER
 * the browser connection's admission check, so every request here is already
 * authenticated and same-origin. Requests under `/api/uvroot/` are answered
 * here; everything else falls through to the normal RPC bridge.
 *
 * @module @local/dsh-uvroot-env/api
 */

import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

const PREFIX = '/api/uvroot'

/** Read and parse a JSON request body (bounded). */
async function readJson(req, limit = 2 * 1024 * 1024) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > limit) throw new Error('request body is too large')
    chunks.push(chunk)
  }
  if (total === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function sendJson(res, status, payload) {
  const body = Buffer.from(`${JSON.stringify(payload)}\n`, 'utf8')
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store',
  })
  res.end(body)
}

function ok(res, value) {
  sendJson(res, 200, { ok: true, value })
}

function fail(res, error, status = 400) {
  sendJson(res, status, { ok: false, error: String(error?.message ?? error) })
}

/** List the directory entries a container/library picker can descend into. */
function browseDirectory(path) {
  const target = resolve(String(path && path.length > 0 ? path : process.env.HOME ?? '/'))
  if (!existsSync(target) || !statSync(target).isDirectory()) throw new Error(`not a directory: ${target}`)
  const entries = readdirSync(target, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .map((entry) => ({ name: entry.name, path: join(target, entry.name) }))
    .sort((left, right) => left.name.localeCompare(right.name))
  return { path: target, parent: target === '/' ? null : resolve(target, '..'), entries }
}

/** List regular files with a matching extension inside one directory. */
function browseFiles(path, extensions) {
  const target = resolve(String(path && path.length > 0 ? path : process.env.HOME ?? '/'))
  if (!existsSync(target) || !statSync(target).isDirectory()) throw new Error(`not a directory: ${target}`)
  const wanted = extensions.map((value) => value.toLowerCase())
  const entries = readdirSync(target, { withFileTypes: true })
    .filter((entry) => entry.isFile() && wanted.some((ext) => entry.name.toLowerCase().endsWith(ext)))
    .map((entry) => ({ name: entry.name, path: join(target, entry.name), size: statSync(join(target, entry.name)).size }))
    .sort((left, right) => left.name.localeCompare(right.name))
  return { path: target, parent: target === '/' ? null : resolve(target, '..'), entries }
}

/**
 * Build the request handler.
 * @param {object} options - handler dependencies.
 * @param {import('./store.js').UvrootStore} options.store - the container registry.
 * @returns {(req: any, res: any, next: () => Promise<void>) => Promise<void>} waterfall listener.
 */
export function createApiHandler({ store }) {
  return async function uvrootApi(req, res, next) {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (!url.pathname.startsWith(PREFIX)) return next()

    const route = url.pathname.slice(PREFIX.length) || '/'
    const method = (req.method ?? 'GET').toUpperCase()

    try {
      if (method === 'GET' && route === '/state') {
        const workspacePath = url.searchParams.get('workspace')
        return ok(res, workspacePath === null ? store.snapshot() : store.workspaceSnapshot(workspacePath))
      }

      if (method === 'GET' && route === '/browse') {
        const extensions = url.searchParams.get('extensions')
        return ok(
          res,
          extensions === null
            ? browseDirectory(url.searchParams.get('path'))
            : browseFiles(url.searchParams.get('path'), extensions.split(',')),
        )
      }

      if (method === 'GET' && route === '/download') {
        const requested = url.searchParams.get('path') ?? ''
        const target = resolve(requested)
        const exportsRoot = resolve(store.exportsDir)
        if (target !== exportsRoot && !target.startsWith(`${exportsRoot}/`)) {
          return fail(res, new Error('only exported archives under the exports directory can be downloaded'), 403)
        }
        if (!existsSync(target) || !statSync(target).isFile()) return fail(res, new Error('file not found'), 404)
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-length': String(statSync(target).size),
          'content-disposition': `attachment; filename="${basename(target)}"`,
          'cache-control': 'no-store',
        })
        createReadStream(target).pipe(res)
        return undefined
      }

      const body = method === 'POST' ? await readJson(req) : {}

      if (method === 'POST' && route === '/settings') {
        return ok(res, store.updateSettings({
          ...(body.uvrootBin === undefined ? {} : { uvrootBin: String(body.uvrootBin) }),
          ...(body.libDir === undefined ? {} : { libDir: String(body.libDir) }),
          ...(body.strictIsolation === undefined ? {} : { strictIsolation: body.strictIsolation !== false }),
        }))
      }

      if (method === 'POST' && route === '/workspace') {
        return ok(res, store.setWorkspaceMode(String(body.path), body.mode))
      }

      if (method === 'POST' && route === '/session') {
        return ok(res, store.setSessionContainer(String(body.path), String(body.sessionId), body.containerId ?? null))
      }

      if (method === 'POST' && route === '/container/create') {
        const container = await store.createContainer(String(body.path), body.container ?? {})
        return ok(res, { container, workspace: store.workspaceSnapshot(String(body.path)) })
      }

      if (method === 'POST' && route === '/container/update') {
        const container = await store.updateContainer(String(body.path), String(body.id), body.patch ?? {})
        return ok(res, { container, workspace: store.workspaceSnapshot(String(body.path)) })
      }

      if (method === 'POST' && route === '/container/delete') {
        return ok(res, store.deleteContainer(String(body.path), String(body.id)))
      }

      if (method === 'POST' && route === '/container/default') {
        return ok(res, store.setDefaultContainer(String(body.path), body.id ?? null))
      }

      if (method === 'POST' && route === '/container/export') {
        return ok(res, await store.exportContainer(String(body.path), String(body.id)))
      }

      if (method === 'POST' && route === '/library/rootfs') {
        store.addRootfsDirectory(String(body.dirPath), body.name)
        return ok(res, store.library())
      }

      if (method === 'POST' && route === '/library/import') {
        await store.importRootfsTar(String(body.tarPath), body.name)
        return ok(res, store.library())
      }

      if (method === 'POST' && route === '/library/image') {
        store.addImage(String(body.filePath), body.name)
        return ok(res, store.library())
      }

      if (method === 'POST' && route === '/library/remove') {
        store.removeLibraryEntry(String(body.kind), String(body.id))
        return ok(res, store.library())
      }

      return fail(res, new Error(`unknown uvroot endpoint: ${method} ${route}`), 404)
    } catch (error) {
      return fail(res, error, 500)
    }
  }
}
