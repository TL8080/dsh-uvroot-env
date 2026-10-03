/**
 * Durable uvroot container registry for @local/dsh-uvroot-env.
 *
 * Layout under `<dsh home>/uvroot/`:
 *   state.json        the whole registry (settings, library, workspaces)
 *   bin/runner.sh     the shim the sandbox provider spawns per command
 *   specs/<id>.sh     one generated uvroot argv per container
 *   rootfs/<name>/    rootfs trees imported from a tar archive
 *   images/           imported disk images
 *   exports/          rootfs archives produced by an export
 *
 * Containers belong to a WORKSPACE (keyed by the canonical workspace path) so
 * every session in that directory shares them. A session selects one of its
 * workspace's containers; the selection is remembered per session id.
 *
 * @module @local/dsh-uvroot-env/store
 */

import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync,
  rmSync, statSync, writeFileSync,
} from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const STATE_VERSION = 1

/** Mount flavours: one host bind plus the three uvroot network families. */
const MOUNT_KINDS = ['bind', 'image', 'networkFile', 'networkDisk']

/** Single-quote one string for POSIX shell. */
function shq(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`
}

/** Canonicalize a path, tolerating one that does not exist yet. */
export function canonical(path) {
  const absolute = resolve(String(path ?? ''))
  try {
    return realpathSync(absolute)
  } catch {
    return absolute
  }
}

/** Strip a trailing slash (but keep the root). */
function trimSlash(path) {
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path
}

/** The `lib/` directory of this package. */
const PACKAGE_LIB = dirname(fileURLToPath(import.meta.url))

export class UvrootStore {
  /**
   * @param {object} options - construction options.
   * @param {string} options.root - the `<dsh home>/uvroot` data root.
   * @param {(message: string, error?: unknown) => void} [options.warn] - diagnostic sink.
   */
  constructor({ root, warn }) {
    this.root = root
    this.warn = warn ?? (() => {})
    this.statePath = join(root, 'state.json')
    this.binDir = join(root, 'bin')
    this.specsDir = join(root, 'specs')
    this.rootfsDir = join(root, 'rootfs')
    this.imagesDir = join(root, 'images')
    this.exportsDir = join(root, 'exports')
    this.envDir = join(root, 'env')
    // One working copy per container. Library entries are SEEDS and are never
    // written to: every container gets its own copy under this directory.
    this.instancesDir = join(root, 'instances')
    for (const dir of [this.root, this.binDir, this.specsDir, this.rootfsDir, this.imagesDir, this.exportsDir, this.envDir, this.instancesDir]) {
      mkdirSync(dir, { recursive: true })
    }
    this.state = this.#load()
    this.installRunner()
    this.rewriteAllSpecs()
  }

  // ── persistence ─────────────────────────────────────────────────────────

  #defaultState() {
    return {
      version: STATE_VERSION,
      settings: {
        uvrootBin: this.#discoverUvroot(),
        libDir: '',
        // Block every tool that would reach the host outside the container
        // (PTC run_code, MCP servers, fs tools outside the workspace).
        strictIsolation: true,
      },
      library: { rootfs: [], images: [] },
      workspaces: {},
    }
  }

  #load() {
    if (!existsSync(this.statePath)) return this.#defaultState()
    try {
      const parsed = JSON.parse(readFileSync(this.statePath, 'utf8'))
      if (parsed === null || typeof parsed !== 'object') return this.#defaultState()
      const base = this.#defaultState()
      const state = {
        version: STATE_VERSION,
        settings: { ...base.settings, ...(parsed.settings ?? {}) },
        library: {
          rootfs: Array.isArray(parsed.library?.rootfs) ? parsed.library.rootfs : [],
          images: Array.isArray(parsed.library?.images) ? parsed.library.images : [],
        },
        workspaces: parsed.workspaces !== null && typeof parsed.workspaces === 'object' ? parsed.workspaces : {},
      }
      if (!state.settings.uvrootBin) state.settings.uvrootBin = base.settings.uvrootBin
      return state
    } catch (error) {
      this.warn('uvroot-env: state.json is unreadable; starting from an empty registry', error)
      return this.#defaultState()
    }
  }

  save() {
    const tmp = `${this.statePath}.${process.pid}.tmp`
    writeFileSync(tmp, `${JSON.stringify(this.state, null, 2)}\n`, 'utf8')
    renameSync(tmp, this.statePath)
  }

  #discoverUvroot() {
    const candidates = [
      process.env.DSH_UVROOT_BIN,
      join(process.env.HOME ?? '', 'uvroot/src/uvroot'),
      join(process.env.HOME ?? '', '.local/bin/uvroot'),
      '/usr/local/bin/uvroot',
      '/usr/bin/uvroot',
    ].filter((value) => typeof value === 'string' && value.length > 0)
    for (const candidate of candidates) {
      try {
        if (statSync(candidate).isFile()) return candidate
      } catch { /* keep looking */ }
    }
    return candidates[0] ?? 'uvroot'
  }

  // ── workspace registry ──────────────────────────────────────────────────

  get settings() {
    return this.state.settings
  }

  updateSettings(patch) {
    this.state.settings = { ...this.state.settings, ...(patch ?? {}) }
    this.save()
    return this.state.settings
  }

  /** The registry entry for one workspace path, creating it on demand. */
  workspace(path) {
    const key = trimSlash(canonical(path))
    let entry = this.state.workspaces[key]
    if (entry === undefined) {
      entry = { mode: 'normal', containers: [], defaultContainerId: null, sessions: {} }
      this.state.workspaces[key] = entry
    }
    if (entry.mode !== 'virtual') entry.mode = entry.mode === 'virtual' ? 'virtual' : 'normal'
    entry.containers ??= []
    entry.sessions ??= {}
    return entry
  }

  /** The workspace entry whose path is the longest prefix of `cwd`. */
  findWorkspace(cwd) {
    const target = trimSlash(canonical(cwd))
    let bestKey
    let bestEntry
    for (const [key, entry] of Object.entries(this.state.workspaces)) {
      if (target === key || target.startsWith(`${key}/`)) {
        if (bestKey === undefined || key.length > bestKey.length) {
          bestKey = key
          bestEntry = entry
        }
      }
    }
    return bestEntry === undefined ? undefined : { path: bestKey, entry: bestEntry }
  }

  /**
   * The EXACT registered entry for one path, without creating one. Unlike
   * {@link findWorkspace} this never walks parent prefixes, so a child
   * workspace does not inherit a parent's virtual marker.
   */
  peek(path) {
    return this.state.workspaces[trimSlash(canonical(path))]
  }

  setWorkspaceMode(path, mode) {
    const entry = this.workspace(path)
    entry.mode = mode === 'virtual' ? 'virtual' : 'normal'
    this.save()
    return this.workspaceSnapshot(path)
  }

  // ── containers ──────────────────────────────────────────────────────────

  #normalizeContainer(input, previous) {
    const now = new Date().toISOString()
    const type = ['directory', 'image', 'network'].includes(input.type) ? input.type : 'directory'
    return {
      id: previous?.id ?? `uvc-${randomUUID().slice(0, 8)}`,
      name: String(input.name ?? previous?.name ?? 'container').trim() || 'container',
      type,
      // `source` is the SEED the user picked (library entry or a path); the
      // resolved `rootfs` / `image` below point at this container's private
      // copy, so a container never writes into the seed.
      source: String(
        input.source ?? input.rootfs ?? input.image ?? input.networkUri
        ?? previous?.source ?? previous?.rootfs ?? previous?.image ?? previous?.networkUri ?? '',
      ),
      linked: Boolean(input.linked ?? previous?.linked ?? false),
      rootfs: String(input.rootfs ?? previous?.rootfs ?? ''),
      image: String(input.image ?? previous?.image ?? ''),
      imageFormat: input.imageFormat === 'qcow2' || previous?.imageFormat === 'qcow2' ? 'qcow2' : 'img',
      networkUri: String(input.networkUri ?? previous?.networkUri ?? ''),
      // A mount is either a host bind (`kind: 'bind'`) or a uvroot network
      // mount (`image` / `networkFile` / `networkDisk`, whose backend the URI
      // scheme selects). Incomplete rows are dropped on save.
      mounts: Array.isArray(input.mounts)
        ? input.mounts
          .filter((m) => m !== null && typeof m === 'object')
          .map((m) => ({
            kind: MOUNT_KINDS.includes(m.kind) ? m.kind : 'bind',
            host: String(m.host ?? ''),
            guest: String(m.guest ?? ''),
            uri: String(m.uri ?? ''),
            mode: m.mode === 'ro' ? 'ro' : 'rw',
          }))
          .filter((m) => (m.kind === 'bind' ? m.host.length > 0 : m.uri.length > 0 && m.guest.length > 0))
        : (previous?.mounts ?? []),
      net: {
        enabled: Boolean(input.net?.enabled ?? previous?.net?.enabled ?? false),
        bridge: String(input.net?.bridge ?? previous?.net?.bridge ?? ''),
        ifaces: Array.isArray(input.net?.ifaces) ? input.net.ifaces.map(String) : (previous?.net?.ifaces ?? []),
        routes: Array.isArray(input.net?.routes) ? input.net.routes.map(String) : (previous?.net?.routes ?? []),
        wg: String(input.net?.wg ?? previous?.net?.wg ?? ''),
      },
      options: {
        link2symlink: input.options?.link2symlink ?? previous?.options?.link2symlink ?? true,
        fakeRoot: input.options?.fakeRoot ?? previous?.options?.fakeRoot ?? true,
        vperm: input.options?.vperm ?? previous?.options?.vperm ?? false,
        vpermId: String(input.options?.vpermId ?? previous?.options?.vpermId ?? ''),
        vpid: input.options?.vpid ?? previous?.options?.vpid ?? '',
        shell: String(input.options?.shell ?? previous?.options?.shell ?? ''),
      },
      env: Array.isArray(input.env)
        ? input.env.map(String).filter((line) => line.trim() !== '')
        : (previous?.env ?? []),
      extraArgs: Array.isArray(input.extraArgs)
        ? input.extraArgs.map(String)
        : (previous?.extraArgs ?? []),
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
    }
  }

  /**
   * Copy one container's seed into its private instance directory and return
   * the runtime path. Directory seeds are copied verbatim (symlinks preserved);
   * image seeds are copied sparsely so a large virtual disk stays small.
   */
  #copyInstance(container) {
    const directory = join(this.instancesDir, container.id)
    rmSync(directory, { recursive: true, force: true })
    mkdirSync(directory, { recursive: true })
    const source = canonical(container.source)
    if (container.type === 'directory') {
      if (!existsSync(source) || !statSync(source).isDirectory()) throw new Error(`rootfs 目录不存在：${source}`)
      const target = join(directory, 'rootfs')
      cpSync(source, target, { recursive: true, force: true, verbatimSymlinks: true })
      return target
    }
    if (!existsSync(source) || !statSync(source).isFile()) throw new Error(`镜像文件不存在：${source}`)
    const target = join(directory, `disk.${container.imageFormat}`)
    const result = spawnSync('cp', ['--sparse=always', '--force', source, target], { encoding: 'utf8' })
    if (result.status !== 0) throw new Error(`复制镜像失败：${(result.stderr ?? '').trim() || `exit ${result.status}`}`)
    return target
  }

  /**
   * Resolve `source` into the runtime paths (`rootfs` / `image`). A brand new
   * container, or one whose seed or copy-mode changed, gets a fresh private
   * copy; an unchanged container keeps the copy it already owns.
   */
  #resolveSource(container, previous) {
    if (container.type === 'network') {
      if (!container.source) throw new Error('请填写网络磁盘 URI')
      container.networkUri = container.source
      container.rootfs = ''
      container.image = ''
      container.seed = { kind: 'network', path: container.source }
      return
    }
    if (!container.source) throw new Error(container.type === 'image' ? '请先选择镜像文件' : '请先选择 rootfs 目录')
    const unchanged = previous !== undefined
      && previous.source === container.source
      && previous.linked === container.linked
      && Boolean(previous.rootfs || previous.image)
    if (unchanged) {
      container.rootfs = previous.rootfs ?? ''
      container.image = previous.image ?? ''
      container.seed = previous.seed
      return
    }
    const seed = canonical(container.source)
    container.seed = { kind: container.type, path: seed, ...container.libraryId ? { libraryId: container.libraryId } : {} }
    if (container.linked) {
      if (container.type === 'directory') { container.rootfs = seed; container.image = '' }
      else { container.image = seed; container.rootfs = '' }
      return
    }
    const instance = this.#copyInstance({ ...container, source: seed })
    if (container.type === 'directory') { container.rootfs = instance; container.image = '' }
    else { container.image = instance; container.rootfs = '' }
  }

  createContainer(path, input) {
    const entry = this.workspace(path)
    const container = this.#normalizeContainer(input ?? {}, undefined)
    this.#resolveSource(container, undefined)
    entry.containers.push(container)
    entry.defaultContainerId ??= container.id
    this.save()
    this.writeSpec(container)
    return container
  }

  /**
   * The registry entry for one path that MUST already exist. Mutations never
   * create a workspace implicitly: an unknown path has to surface as an error
   * instead of silently writing to a fresh, empty entry.
   */
  #required(path) {
    const key = trimSlash(canonical(path))
    const entry = this.state.workspaces[key]
    if (entry === undefined) throw new Error(`工作目录尚未登记：${key}`)
    entry.containers ??= []
    entry.sessions ??= {}
    return entry
  }

  updateContainer(path, id, patch) {
    const entry = this.#required(path)
    const index = entry.containers.findIndex((candidate) => candidate.id === id)
    if (index < 0) throw new Error(`容器不存在：${id}`)
    const next = this.#normalizeContainer({ ...entry.containers[index], ...(patch ?? {}) }, entry.containers[index])
    this.#resolveSource(next, entry.containers[index])
    entry.containers[index] = next
    this.save()
    this.writeSpec(next)
    return next
  }

  deleteContainer(path, id) {
    const entry = this.#required(path)
    if (!entry.containers.some((candidate) => candidate.id === id)) throw new Error(`容器不存在：${id}`)
    entry.containers = entry.containers.filter((candidate) => candidate.id !== id)
    if (entry.defaultContainerId === id) entry.defaultContainerId = entry.containers[0]?.id ?? null
    for (const [sessionId, containerId] of Object.entries(entry.sessions)) {
      if (containerId === id) delete entry.sessions[sessionId]
    }
    this.save()
    try { rmSync(join(this.specsDir, `${id}.sh`), { force: true }) } catch { /* already gone */ }
    try { rmSync(join(this.envDir, `${id}.sh`), { force: true }) } catch { /* already gone */ }
    try { rmSync(join(this.instancesDir, id), { recursive: true, force: true }) } catch { /* already gone */ }
    return this.workspaceSnapshot(path)
  }

  setDefaultContainer(path, id) {
    const entry = this.#required(path)
    if (id !== null && !entry.containers.some((candidate) => candidate.id === id)) {
      throw new Error(`容器不存在：${id}`)
    }
    entry.defaultContainerId = id
    this.save()
    return this.workspaceSnapshot(path)
  }

  setSessionContainer(path, sessionId, containerId) {
    const entry = this.#required(path)
    if (containerId === null || containerId === '') delete entry.sessions[sessionId]
    else if (!entry.containers.some((candidate) => candidate.id === containerId)) throw new Error(`容器不存在：${containerId}`)
    else entry.sessions[sessionId] = containerId
    this.save()
    return this.workspaceSnapshot(path)
  }

  /**
   * The container one command from `cwd` must run inside, or undefined for a
   * normal (host-confined) execution.
   */
  resolveContainerFor(cwd, sessionId) {
    const found = this.findWorkspace(cwd)
    if (found === undefined) return undefined
    const { entry } = found
    if (entry.mode !== 'virtual') return undefined
    const selected = sessionId === undefined ? undefined : entry.sessions?.[sessionId]
    const id = selected ?? entry.defaultContainerId ?? undefined
    if (id === undefined || id === null) return undefined
    return entry.containers.find((candidate) => candidate.id === id)
  }

  // ── generated spec files and the runner shim ────────────────────────────

  /** Copy the packaged runner into the data root so the Loader config path is stable. */
  installRunner() {
    const source = join(PACKAGE_LIB, 'runner.sh')
    const target = join(this.binDir, 'runner.sh')
    try {
      cpSync(source, target)
      chmodSync(target, 0o755)
    } catch (error) {
      this.warn('uvroot-env: could not install the runner shim', error)
    }
    return target
  }

  /** Build the uvroot argv (before the command) for one container. */
  static containerArgs(container) {
    const args = []
    const type = container.type
    if (type === 'image') {
      const scheme = container.imageFormat === 'qcow2' ? 'qcow2' : 'img'
      args.push(`--netfs=/:${scheme}://${container.image}`)
      args.push('--vperm')
    } else if (type === 'network') {
      args.push(`--netfs=/:${container.networkUri}`)
      args.push('--vperm')
    } else {
      args.push('-r', container.rootfs)
    }
    const options = container.options ?? {}
    if (options.link2symlink) args.push('--link2symlink')
    if (options.fakeRoot) args.push('-i', '0:0')
    if (options.vperm) {
      args.push('--vperm')
      if (options.vpermId) args.push('--vperm-id', String(options.vpermId))
    }
    if (options.vpid !== '' && options.vpid !== undefined && options.vpid !== null) {
      args.push('--vpid', String(options.vpid))
    }
    let needsVperm = false
    for (const mount of container.mounts ?? []) {
      if ((mount.kind ?? 'bind') === 'bind') {
        if (!mount.host) continue
        const guest = mount.guest || mount.host
        args.push('-b', `${mount.host}:${guest}`)
        if (mount.mode === 'ro') args.push(`--ro=${guest}`)
        continue
      }
      if (!mount.uri || !mount.guest) continue
      // Network file / image / network disk: one --netfs per mount; the scheme
      // (ftp, sftp, smb, nfs, img, qcow2, nbd, iscsi) picks the backend.
      args.push(`--netfs=${mount.guest}:${mount.uri}`)
      if (mount.mode === 'ro') args.push(`--ro=${mount.guest}`)
      if (mount.kind === 'image' || mount.kind === 'networkDisk') needsVperm = true
    }
    // uvroot refuses a block-backed mount without the virtual permission layer.
    if (needsVperm && !args.includes('--vperm')) args.push('--vperm')
    const net = container.net ?? {}
    if (net.enabled) {
      args.push('--net')
      if (net.bridge) args.push(`--net-bridge=${net.bridge}`)
      for (const route of net.routes ?? []) args.push(`--net-route=${route}`)
      for (const iface of net.ifaces ?? []) args.push(`--net-if=${iface}`)
      if (net.wg) args.push(`--wg=${net.wg}`)
    }
    for (const extra of container.extraArgs ?? []) args.push(extra)
    return args
  }

  /** The shell DSH's `bash -c` calls should be rewritten to inside this container. */
  static guestShell(container) {
    const configured = container.options?.shell
    if (typeof configured === 'string' && configured.length > 0) return configured
    if (container.type === 'directory' && container.rootfs) {
      // `lstat` on purpose: a rootfs entry like `/bin/sh -> /bin/busybox` is an
      // absolute symlink that resolves against the HOST root, so `existsSync`
      // reports it missing even though the guest will find it.
      const present = (relative) => {
        try { lstatSync(join(container.rootfs, relative)); return true } catch { return false }
      }
      for (const candidate of ['bin/bash', 'usr/bin/bash']) if (present(candidate)) return 'bash'
      for (const candidate of ['bin/sh', 'usr/bin/sh']) if (present(candidate)) return 'sh'
    }
    return 'bash'
  }

  /** Write one container's per-container environment file (KEY=VALUE lines). */
  writeEnvFile(container) {
    const lines = Array.isArray(container.env) ? container.env.filter((line) => typeof line === 'string' && line.trim() !== '') : []
    const target = join(this.envDir, `${container.id}.sh`)
    if (lines.length === 0) {
      try { rmSync(target, { force: true }) } catch { /* already gone */ }
      return undefined
    }
    const body = [`# generated by @local/dsh-uvroot-env for container ${container.id} (${container.name})`, ...lines, ''].join('\n')
    const tmp = `${target}.${process.pid}.tmp`
    writeFileSync(tmp, body, 'utf8')
    renameSync(tmp, target)
    return target
  }

  writeSpec(container) {
    const args = UvrootStore.containerArgs(container)
    const envFile = this.writeEnvFile(container)
    const body = [
      `# generated by @local/dsh-uvroot-env for container ${container.id} (${container.name})`,
      `UVROOT_BIN=${shq(this.state.settings.uvrootBin)}`,
      `UVROOT_LIB_DIR=${shq(this.state.settings.libDir ?? '')}`,
      `UVROOT_SHELL=${shq(UvrootStore.guestShell(container))}`,
      `UVROOT_ENV_FILE=${shq(envFile ?? '')}`,
      `UVROOT_CONTAINER=${shq(container.id)}`,
      'UVROOT_ARGS=(',
      ...args.map((arg) => `  ${shq(arg)}`),
      ')',
      '',
    ].join('\n')
    const target = join(this.specsDir, `${container.id}.sh`)
    const tmp = `${target}.${process.pid}.tmp`
    writeFileSync(tmp, body, 'utf8')
    renameSync(tmp, target)
    return target
  }

  rewriteAllSpecs() {
    for (const entry of Object.values(this.state.workspaces)) {
      for (const container of entry.containers ?? []) this.writeSpec(container)
    }
  }

  specPath(containerId) {
    return join(this.specsDir, `${containerId}.sh`)
  }

  // ── rootfs / image library ──────────────────────────────────────────────

  library() {
    return this.state.library
  }

  removeLibraryEntry(kind, id) {
    const table = kind === 'images' ? this.state.library.images : this.state.library.rootfs
    const index = table.findIndex((entry) => entry.id === id)
    if (index < 0) throw new Error(`unknown library entry: ${id}`)
    table.splice(index, 1)
    this.save()
    return this.state.library
  }

  addRootfsDirectory(dirPath, name) {
    const source = canonical(dirPath)
    if (!existsSync(source) || !statSync(source).isDirectory()) {
      throw new Error(`not a directory: ${dirPath}`)
    }
    const entry = {
      id: `uvr-${randomUUID().slice(0, 8)}`,
      name: String(name ?? basename(source)) || 'rootfs',
      path: source,
      kind: 'directory',
      createdAt: new Date().toISOString(),
    }
    this.state.library.rootfs.push(entry)
    this.save()
    return entry
  }

  addImage(filePath, name) {
    const source = canonical(filePath)
    if (!existsSync(source) || !statSync(source).isFile()) throw new Error(`not a file: ${filePath}`)
    const lower = basename(source).toLowerCase()
    const entry = {
      id: `uvi-${randomUUID().slice(0, 8)}`,
      name: String(name ?? basename(source)) || 'image',
      path: source,
      kind: 'image',
      format: lower.endsWith('.qcow2') ? 'qcow2' : 'img',
      size: safeSize(source),
      createdAt: new Date().toISOString(),
    }
    this.state.library.images.push(entry)
    this.save()
    return entry
  }

  /** Extract a rootfs tar/tar.gz into the library and register the result. */
  importRootfsTar(tarPath, name) {
    const source = canonical(tarPath)
    if (!existsSync(source) || !statSync(source).isFile()) throw new Error(`not a file: ${tarPath}`)
    const label = String(name ?? basename(source).replace(/\.(tar\.gz|tgz|tar)$/i, '')) || 'rootfs'
    const destination = join(this.rootfsDir, `${label}-${randomUUID().slice(0, 6)}`)
    mkdirSync(destination, { recursive: true })
    const result = spawnSync('tar', ['-xf', source, '-C', destination], { encoding: 'utf8' })
    if (result.status !== 0) {
      rmSync(destination, { recursive: true, force: true })
      throw new Error(`tar failed (${result.status}): ${(result.stderr ?? '').trim() || 'unknown error'}`)
    }
    const nested = join(destination, 'rootfs')
    const resolved = existsSync(join(destination, 'bin')) || !existsSync(nested) ? destination : nested
    const entry = {
      id: `uvr-${randomUUID().slice(0, 8)}`,
      name: label,
      path: resolved,
      kind: 'directory',
      imported: true,
      source,
      size: directorySize(resolved),
      createdAt: new Date().toISOString(),
    }
    this.state.library.rootfs.push(entry)
    this.save()
    return entry
  }

  /**
   * Export one container's rootfs as a gzip tar under the exports directory.
   * Directory containers are archived; image containers are copied verbatim.
   */
  exportContainer(path, id) {
    const entry = this.workspace(path)
    const container = entry.containers.find((candidate) => candidate.id === id)
    if (container === undefined) throw new Error(`容器不存在：${id}`)
    const stamp = new Date().toISOString().replaceAll(/[:.]/g, '-')
    const safeName = container.name.replaceAll(/[^A-Za-z0-9._-]+/g, '_') || 'container'
    const download = (target) => `/api/uvroot/download?path=${encodeURIComponent(target)}`
    // Directory containers export a rootfs tar; image containers export the
    // image file itself (qcow2 stays qcow2, raw stays raw).
    if (container.type === 'directory') {
      if (!container.rootfs || !existsSync(container.rootfs)) throw new Error(`rootfs 不存在：${container.rootfs}`)
      const target = join(this.exportsDir, `${safeName}-${stamp}-rootfs.tar.gz`)
      const result = spawnSync('tar', ['-czf', target, '-C', container.rootfs, '.'], { encoding: 'utf8' })
      if (result.status !== 0) throw new Error(`打包失败（${result.status}）：${(result.stderr ?? '').trim()}`)
      return { kind: 'rootfs-tar', format: 'tar.gz', name: basename(target), path: target, size: safeSize(target), download: download(target), source: container.rootfs }
    }
    if (container.type === 'image') {
      if (!container.image || !existsSync(container.image)) throw new Error(`镜像不存在：${container.image}`)
      const target = join(this.exportsDir, `${safeName}-${stamp}.${container.imageFormat}`)
      const result = spawnSync('cp', ['--sparse=always', '--force', container.image, target], { encoding: 'utf8' })
      if (result.status !== 0) throw new Error(`导出镜像失败：${(result.stderr ?? '').trim() || `exit ${result.status}`}`)
      return { kind: 'image', format: container.imageFormat, name: basename(target), path: target, size: safeSize(target), download: download(target), source: container.image }
    }
    throw new Error('网络磁盘容器无法导出（数据在远端）')
  }

  // ── snapshots for the UI ────────────────────────────────────────────────

  workspaceSnapshot(path) {
    const key = trimSlash(canonical(path))
    const entry = this.workspace(key)
    return {
      path: key,
      mode: entry.mode,
      containers: entry.containers,
      defaultContainerId: entry.defaultContainerId,
      sessions: entry.sessions,
    }
  }

  snapshot() {
    return {
      settings: this.state.settings,
      library: this.state.library,
      workspaces: Object.fromEntries(
        Object.keys(this.state.workspaces).map((key) => [key, this.workspaceSnapshot(key)]),
      ),
      paths: {
        dataRoot: this.root,
        rootfsDir: this.rootfsDir,
        imagesDir: this.imagesDir,
        instancesDir: this.instancesDir,
        exportsDir: this.exportsDir,
      },
      uvroot: this.probeUvroot(),
    }
  }

  /** Whether the configured uvroot binary runs and which features it reports. */
  probeUvroot() {
    const bin = this.state.settings.uvrootBin
    if (!bin) return { available: false, bin, detail: 'no uvroot binary configured' }
    try {
      if (!statSync(bin).isFile()) return { available: false, bin, detail: 'not a file' }
    } catch {
      return { available: false, bin, detail: 'not found' }
    }
    const result = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 10_000 })
    if (result.error !== undefined && result.error !== null) {
      return { available: false, bin, detail: String(result.error.message ?? result.error) }
    }
    const lines = `${result.stdout ?? ''}${result.stderr ?? ''}`
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
    const version = lines.find((line) => /v\d+\.\d+/.test(line))
    const about = lines.find((line) => line.includes('user-mode virtual root'))
    return {
      available: result.status === 0,
      bin,
      detail: [version, about].filter(Boolean).join(' — ') || `exit ${result.status}`,
    }
  }
}

function safeSize(path) {
  try { return statSync(path).size } catch { return 0 }
}

function directorySize(path) {
  const result = spawnSync('du', ['-sb', path], { encoding: 'utf8' })
  if (result.status === 0) {
    const parsed = Number.parseInt((result.stdout ?? '').split(/\s+/)[0] ?? '', 10)
    if (Number.isFinite(parsed)) return parsed
  }
  return 0
}
