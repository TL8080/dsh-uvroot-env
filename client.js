/**
 * Client half of @local/dsh-uvroot-env.
 *
 * Surfaces, all through the shared slot registry:
 *   conversation.input.permission  two-option workspace read-only / writable
 *                                  control (shadows the shipped preset picker)
 *   conversation.input.left        per-session container switcher
 *   settings.section               uvroot + rootfs/image library settings
 *   *.directoryFlow                directory picker with an environment choice
 *                                  for the "add working directory" action
 *   shell.overlay                  the container manager dialog
 *
 * Host data arrives through the authenticated /api/uvroot/* JSON API the host
 * half serves from the connection/request waterfall.
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-uvroot-env',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    // ── host API ──────────────────────────────────────────────────────────

    // Routes that legitimately take a while (seed copies, archives, image
    // exports) get a longer budget; everything else fails fast so a stuck
    // request can never leave a dialog spinning forever.
    const SLOW_ROUTES = new Set(['/container/create', '/container/update', '/container/export', '/library/import'])

    async function api(method, route, body) {
      const timeoutMs = SLOW_ROUTES.has(route) ? 600_000 : 60_000
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      try {
        const response = await fetch(`/api/uvroot${route}`, {
          method,
          headers: body === undefined ? {} : { 'content-type': 'application/json' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: controller.signal,
        })
        const payload = await response.json().catch(() => ({ ok: false, error: `HTTP ${response.status}` }))
        if (!payload.ok) throw new Error(payload.error ?? `HTTP ${response.status}`)
        return payload.value
      } catch (error) {
        if (error?.name === 'AbortError') {
          throw new Error(`请求超时（${Math.round(timeoutMs / 1000)}s 未响应）：${route}`)
        }
        throw error
      } finally {
        clearTimeout(timer)
      }
    }

    /** The client plugin context, captured in apply for lazy service lookups. */
    const ctxRef = { current: null }

    // ── tiny external store shared by every surface ───────────────────────

    const store = { data: null, error: null, listeners: new Set(), inflight: null }
    function emit() { for (const listener of [...store.listeners]) listener() }
    /**
     * Read the registry. Reads are SERIALIZED and ALWAYS issued fresh after the
     * previous one settles: sharing an in-flight GET would let a read that
     * started before a mutation overwrite the post-mutation state, which reads
     * as "the change did not apply".
     */
    function refresh() {
      const previous = store.inflight ?? Promise.resolve()
      const next = previous
        .catch(() => {})
        .then(() => api('GET', '/state'))
        .then((value) => { store.data = value; store.error = null })
        .catch((error) => { store.error = String(error?.message ?? error) })
        .finally(() => {
          if (store.inflight === next) store.inflight = null
          emit()
        })
      store.inflight = next
      return next
    }
    function useUvroot() {
      const [, force] = React.useReducer((value) => value + 1, 0)
      React.useEffect(() => {
        store.listeners.add(force)
        if (store.data === null && store.inflight === null) void refresh()
        return () => { store.listeners.delete(force) }
      }, [])
      return store
    }
    async function mutate(promise) {
      const value = await promise
      await refresh()
      emit()
      return value
    }

    /** Seconds since `active` turned true (0 while idle) — progress feedback. */
    function useElapsed(active) {
      const [seconds, setSeconds] = React.useState(0)
      React.useEffect(() => {
        if (active !== true) { setSeconds(0); return undefined }
        const started = Date.now()
        const timer = setInterval(() => { setSeconds(Math.floor((Date.now() - started) / 1000)) }, 1000)
        return () => { clearInterval(timer) }
      }, [active])
      return seconds
    }

    /** Modal signalling shared between the switcher, settings page and overlay. */
    const dialogs = { manager: null, listeners: new Set() }
    function openManager(request) {
      dialogs.manager = request ?? { path: null, containerId: null }
      for (const listener of [...dialogs.listeners]) listener()
    }
    function closeManager() {
      dialogs.manager = null
      for (const listener of [...dialogs.listeners]) listener()
    }
    function useDialogs() {
      const [, force] = React.useReducer((value) => value + 1, 0)
      React.useEffect(() => {
        dialogs.listeners.add(force)
        return () => { dialogs.listeners.delete(force) }
      }, [])
      return dialogs
    }

    // ── styles ────────────────────────────────────────────────────────────

    // Every colour comes from the host theme tokens (--dsw-*), so the plugin
    // follows the active light/dark theme instead of imposing one.
    const CSS = `
.uv-btn{font:inherit;display:inline-flex;align-items:center;gap:6px;border:1px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary);border-radius:6px;padding:4px 8px;cursor:pointer;line-height:1.4}
.uv-btn:hover{background:var(--dsw-alias-button-ghost-active-hover)}
.uv-btn[disabled]{opacity:.5;cursor:default}
.uv-btn.uv-primary{background:var(--dsw-alias-button-primary-fill);border-color:transparent;color:var(--dsw-alias-label-primary-foreground)}
.uv-btn.uv-primary:hover{background:var(--dsw-alias-button-primary-hover)}
.uv-btn.uv-danger{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.uv-row{display:flex;align-items:center;gap:8px}
.uv-col{display:flex;flex-direction:column;gap:8px}
.uv-menu{position:absolute;z-index:60;min-width:260px;max-height:60vh;overflow:auto;background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.18);padding:6px}
.uv-item{display:flex;flex-direction:column;gap:2px;padding:6px 8px;border-radius:6px;cursor:pointer}
.uv-item:hover{background:var(--dsw-alias-interactive-bg-hover)}
.uv-item.uv-active{outline:1px solid var(--dsw-alias-brand-primary)}
.uv-item small{color:var(--dsw-alias-label-secondary)}
.uv-overlay{position:fixed;inset:0;z-index:200;background:rgba(0,0,0,.35);display:flex;align-items:center;justify-content:center;padding:24px;pointer-events:auto}
.uv-dialog{background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);border-radius:12px;min-width:min(680px,92vw);max-width:min(860px,94vw);max-height:88vh;overflow:auto;padding:16px;box-shadow:0 18px 48px rgba(0,0,0,.28);pointer-events:auto}
.uv-dialog h3{margin:0 0 10px;font-size:15px}
.uv-field{display:flex;flex-direction:column;gap:4px;font-size:12px}
.uv-field>span{color:var(--dsw-alias-label-secondary)}
.uv-input,.uv-select,.uv-textarea{font:inherit;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l3);border-radius:6px;padding:5px 7px;width:100%;box-sizing:border-box}
.uv-input:focus,.uv-select:focus,.uv-textarea:focus{outline:none;border-color:var(--dsw-alias-brand-primary);box-shadow:0 0 0 1px var(--dsw-alias-brand-primary)}
.uv-input::placeholder,.uv-textarea::placeholder{color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary))}
.uv-textarea{min-height:64px;font-family:ui-monospace,monospace;font-size:12px}
.uv-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
.uv-seg{display:inline-flex;border:1px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-module-platform);border-radius:8px;overflow:hidden}
.uv-seg button{font:inherit;border:0;background:transparent;color:var(--dsw-alias-label-primary);padding:4px 10px;cursor:pointer}
.uv-seg button:hover{background:var(--dsw-alias-button-ghost-active-hover)}
.uv-seg button.uv-on{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}
.uv-list{display:flex;flex-direction:column;gap:6px;max-height:240px;overflow:auto}
.uv-card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-module-platform);border-radius:8px;padding:8px}
.uv-muted{color:var(--dsw-alias-label-secondary);font-size:12px}
.uv-error{color:var(--dsw-alias-state-error-primary);font-size:12px;white-space:pre-wrap}
.uv-badge{display:inline-flex;align-items:center;gap:4px;font-size:11px;border:1px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-secondary);border-radius:999px;padding:1px 7px}
.uv-chip{display:inline-flex;align-items:center;gap:4px;font-size:11px;color:var(--dsw-alias-label-secondary)}
.uv-mounts{display:flex;flex-direction:column;gap:6px}

`
    function StyleSheet() {
      React.useEffect(() => {
        const element = document.createElement('style')
        element.setAttribute('data-dsh-uvroot-env', '')
        element.textContent = CSS
        document.head.appendChild(element)
        return () => { element.remove() }
      }, [])
      return null
    }

    // ── helpers ───────────────────────────────────────────────────────────

    function workspacePathFor(useWorkspaces, sessionId) {
      if (typeof useWorkspaces !== 'function' || sessionId === undefined) return undefined
      const snapshot = useWorkspaces((state) => state)
      const items = snapshot?.items ?? []
      const owner = items.find((workspace) => (workspace.sessionIds ?? []).includes(sessionId))
      return owner?.path
    }

    function workspaceOf(data, path) {
      if (data === null || path === undefined) return undefined
      const direct = data.workspaces?.[path]
      if (direct !== undefined) return direct
      let best
      for (const [key, value] of Object.entries(data.workspaces ?? {})) {
        if (path === key || path.startsWith(`${key}/`)) {
          if (best === undefined || key.length > best.path.length) best = { path: key, value }
        }
      }
      return best?.value
    }

    const TYPE_LABEL = { directory: '目录', image: '镜像', network: '网络磁盘' }

    function Banner({ text, tone }) {
      if (text === null || text === undefined || text === '') return null
      return h('div', { className: 'uv-error', style: tone === 'ok' ? { color: 'var(--dsw-alias-state-success-primary)' } : undefined }, String(text))
    }

    // ── 1. permission control (two options) ───────────────────────────────

/** Human label for the session's current file policy. */
    function permissionLabel(current) {
      if (current === 'read-only') return '工作区只读'
      if (current === 'workspace-write') return '工作区可写'
      if (current === 'danger-full-access') return 'danger-full-access（容器不生效，请切换）'
      return '未设置'
    }

    // ── 2. per-session container switcher (virtual workspaces only) ───────

    function ContainerSwitcher(props) {
      const { sessionId, useWorkspaces, locked, useProjection, setPermission } = props
      const state = useUvroot()
      const [open, setOpen] = React.useState(false)
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState(null)
      const anchor = React.useRef(null)
      const permission = useProjection('permissions')
      const path = workspacePathFor(useWorkspaces, sessionId)
      const workspace = workspaceOf(state.data, path)
      const containers = workspace?.containers ?? []
      const selectedId = workspace?.sessions?.[sessionId]
      const effectiveId = selectedId ?? workspace?.defaultContainerId ?? null
      const selected = containers.find((container) => container.id === effectiveId)
      const isVirtual = workspace?.mode === 'virtual'

      React.useEffect(() => {
        if (!open) return undefined
        const close = (event) => {
          if (anchor.current !== null && anchor.current.contains(event.target)) return
          setOpen(false)
        }
        document.addEventListener('mousedown', close)
        return () => { document.removeEventListener('mousedown', close) }
      }, [open])

      // Nothing at all for a workspace that is not a virtual environment: the
      // composer stays exactly the official one.
      if (path === undefined || isVirtual !== true) return null

      const run = (promise) => {
        setBusy(true)
        setError(null)
        mutate(promise)
          .then(() => { setOpen(false) })
          .catch((reason) => { setError(String(reason?.message ?? reason)) })
          .finally(() => { setBusy(false) })
      }

      const pickNormal = () => {
        run(api('POST', '/workspace', { path, mode: 'normal' }))
      }
      const pickContainer = (containerId) => {
        // Entering a container needs a confined file policy; adopt the writable
        // one only when the session is still on a bypassing mode, so a user's
        // explicit read-only choice is never silently widened.
        const current = permission?.currentValue
        const needsConfined = current === 'danger-full-access' || current === undefined || current === 'custom'
        run(api('POST', '/session', { path, sessionId, containerId })
          .then(() => (needsConfined ? setPermission('workspace-write') : undefined)))
      }
      return h('div', { style: { position: 'relative' }, ref: anchor },
        h('button', {
          type: 'button',
          className: 'uv-btn',
          disabled: locked === true || busy,
          onClick: () => setOpen((value) => !value),
          title: `虚拟环境工作目录：${path}\n容器：${selected?.name ?? '未设置'}`,
        },
        h('span', null, '容器'),
        h('span', null, selected?.name ?? '未选择'),
        h('span', { style: { opacity: 0.6, fontSize: 10 } }, '▾')),
        open ? h('div', { className: 'uv-menu', style: { bottom: '120%', left: 0 } },
          h('div', { className: 'uv-item', onClick: pickNormal },
            h('span', null, '退出虚拟环境（正常模式）'),
            h('small', null, '该工作目录回到官方默认：直接在宿主上受限执行')),
          h('div', { style: { height: 1, background: 'var(--dsw-alias-border-l2)', margin: '4px 0' } }),
          containers.length === 0
            ? h('div', { className: 'uv-item uv-muted' }, '该工作目录还没有容器')
            : containers.map((container) => h('div', {
              key: container.id,
              className: `uv-item${container.id === effectiveId ? ' uv-active' : ''}`,
              onClick: () => pickContainer(container.id),
            },
            h('span', null, `${container.name} `, h('span', { className: 'uv-badge' }, TYPE_LABEL[container.type] ?? container.type)),
            h('small', null, container.type === 'directory' ? container.rootfs
              : container.type === 'image' ? container.image
                : container.networkUri),
            )),
          h('div', { style: { height: 1, background: 'var(--dsw-alias-border-l2)', margin: '4px 0' } }),
          h('div', { className: 'uv-muted', style: { padding: '4px 8px' } },
            `容器内工作区权限：${permissionLabel(permission?.currentValue)}`,
            h('br', null),
            '请用输入框下方的官方权限控件切换（这里不再重复提供，避免两处设置冲突）'),
          h('div', { className: 'uv-item', onClick: () => { setOpen(false); openManager({ path, containerId: effectiveId }) } },
            h('span', null, '管理容器…'),
            h('small', null, '新建、编辑、导出镜像 / rootfs')),
          error === null ? null : h('div', { className: 'uv-error', style: { padding: 6 } }, error),
        ) : null,
      )
    }

    // ── 2b. workspace markers: which folders are virtual environments ─────

    /**
     * The environment marker for one workspace, resolved the same way on every
     * surface: `virtual` only when the folder is registered AND has a usable
     * container.
     */
    function environmentOf(useWorkspaces, sessionId) {
      const path = workspacePathFor(useWorkspaces, sessionId)
      if (path === undefined) return undefined
      const workspace = workspaceOf(store.data, path)
      if (workspace === undefined || workspace.mode !== 'virtual') return undefined
      const id = workspace.defaultContainerId
      const container = (workspace.containers ?? []).find((candidate) => candidate.id === id)
      return { path, container, count: (workspace.containers ?? []).length }
    }

    /** Persistent marker in the conversation header for the open session. */
    function HeaderEnvBadge(props) {
      const { sessionId, useWorkspaces } = props
      const state = useUvroot()
      const environment = environmentOf(useWorkspaces, sessionId)
      if (environment === undefined) return null
      const running = state.data?.uvroot?.available === true
      return h('button', {
        type: 'button',
        className: 'uv-btn',
        title: `虚拟环境工作目录：${environment.path}\n容器：${environment.container?.name ?? '（未设置）'}（共 ${environment.count} 个）${running ? '' : '\nuvroot 当前不可用'}`,
        onClick: () => openManager({ path: environment.path, containerId: environment.container?.id ?? null }),
        style: { fontSize: 11, padding: '2px 7px' },
      },
        h('span', { style: { opacity: 0.6 } }, '虚拟环境'),
        h('span', null, environment.container?.name ?? '未选择容器'),
      )
    }

    // ── 3. container editor dialog (shared by manager and add-workspace) ──

    function emptyContainer() {
      return {
        name: '',
        type: 'directory',
        // `source` is the seed the user picks; the server copies it into the
        // container's private instance and fills rootfs/image with that copy.
        source: '',
        linked: false,
        libraryId: '',
        rootfs: '',
        image: '',
        imageFormat: 'img',
        networkUri: '',
        mounts: [],
        net: { enabled: false, bridge: '', ifaces: [], routes: [], wg: '' },
        options: { link2symlink: true, fakeRoot: true, vperm: false, vpermId: '', vpid: '', shell: '' },
        env: [],
        extraArgs: [],
      }
    }

    /** Merge a stored container over the form defaults, filling nested records. */
    function withDefaults(container) {
      const base = emptyContainer()
      return {
        ...base,
        ...container,
        // Containers created before the seed/instance split only carry the
        // resolved path; treat it as their source until the form is saved.
        source: container.source || container.rootfs || container.image || container.networkUri || '',
        env: container.env ?? [],
        mounts: container.mounts ?? [],
        extraArgs: container.extraArgs ?? [],
        net: { ...base.net, ...(container.net ?? {}) },
        options: { ...base.options, ...(container.options ?? {}) },
      }
    }

    /** Placeholder per mount kind; the URI scheme is what selects the backend. */
    const MOUNT_URI_HINT = {
      image: 'img:///abs/path/disk.img 或 qcow2:///abs/path/disk.qcow2',
      networkFile: 'ftp://user:pass@host/pub | sftp://… | smb://server/share | nfs://server/export',
      networkDisk: 'nbd://127.0.0.1:10809/export | iscsi://user:pass@host/iqn/lun',
    }

    const MOUNT_KIND_LABEL = {
      bind: '宿主路径',
      image: '镜像（img/qcow2）',
      networkFile: '网络文件（FTP/SFTP/SMB/NFS）',
      networkDisk: '网络磁盘（NBD/iSCSI）',
    }

    /**
     * One mount row. `bind` entries bind a host path (`-b host:guest`); the
     * other three are uvroot network mounts (`--netfs=guest:uri`) whose backend
     * is chosen by the URI scheme.
     */
    function MountRow({ mount, index, setMount, images, onRemove }) {
      const kind = mount.kind ?? 'bind'
      const set = (patch) => setMount(index, patch)
      const network = kind !== 'bind'
      return h('div', { className: 'uv-card uv-col', style: { gap: 6 } },
        h('div', { className: 'uv-row' },
          h('select', {
            className: 'uv-select', style: { maxWidth: 190 }, value: kind,
            onChange: (event) => set({ kind: event.target.value }),
          },
          ...Object.entries(MOUNT_KIND_LABEL).map(([value, label]) => h('option', { key: value, value }, label))),
          network
            ? h('input', {
              className: 'uv-input', value: mount.uri ?? '',
              placeholder: MOUNT_URI_HINT[kind] ?? 'scheme://…',
              onChange: (event) => set({ uri: event.target.value }),
            })
            : h('input', {
              className: 'uv-input', value: mount.host ?? '',
              placeholder: '宿主路径，如 /home/user/data',
              onChange: (event) => set({ host: event.target.value }),
            }),
          h('button', { type: 'button', className: 'uv-btn', title: '删除这条映射', onClick: onRemove }, '×')),
        h('div', { className: 'uv-row' },
          h('input', {
            className: 'uv-input', value: mount.guest ?? '',
            placeholder: network ? '容器内挂载点，如 /mnt/pub（必填）' : '容器内路径（留空＝同宿主路径）',
            onChange: (event) => set({ guest: event.target.value }),
          }),
          h('select', {
            className: 'uv-select', style: { maxWidth: 96 }, value: mount.mode ?? 'rw',
            onChange: (event) => set({ mode: event.target.value }),
          },
          h('option', { value: 'rw' }, '可写'),
          h('option', { value: 'ro' }, '只读'))),
        kind === 'image' && (images ?? []).length > 0
          ? h('select', {
            className: 'uv-select', value: '',
            onChange: (event) => {
              const entry = (images ?? []).find((candidate) => candidate.path === event.target.value)
              if (entry !== undefined) set({ uri: `${entry.format}://${entry.path}` })
            },
          },
          h('option', { value: '' }, '— 从镜像库填入 —'),
          ...(images ?? []).map((entry) => h('option', { key: entry.id, value: entry.path }, `${entry.name} (${entry.format})`)))
          : null,
      )
    }

    function ContainerForm({ draft, setDraft, library, uvroot }) {
      // Normalize here as well as at every producer: a render must never crash
      // on a partial draft (the slot entry would abdicate and the dialog would
      // silently fail to open).
      const defaults = emptyContainer()
      const value = {
        ...defaults,
        ...(draft ?? {}),
        net: { ...defaults.net, ...(draft?.net ?? {}) },
        options: { ...defaults.options, ...(draft?.options ?? {}) },
        mounts: draft?.mounts ?? [],
        env: draft?.env ?? [],
        extraArgs: draft?.extraArgs ?? [],
      }
      const set = (patch) => setDraft({ ...value, ...patch })
      const setOption = (patch) => setDraft({ ...value, options: { ...value.options, ...patch } })
      const setNet = (patch) => setDraft({ ...value, net: { ...value.net, ...patch } })
      const setMount = (index, patch) => {
        const mounts = value.mounts.map((mount, cursor) => (cursor === index ? { ...mount, ...patch } : mount))
        setDraft({ ...value, mounts })
      }
      const rootfsLibrary = library?.rootfs ?? []
      const imageLibrary = library?.images ?? []
      return h('div', { className: 'uv-col' },
        h('div', { className: 'uv-grid' },
          h('label', { className: 'uv-field' }, h('span', null, '名称'),
            h('input', {
              className: 'uv-input',
              value: value.name,
              placeholder: 'alpine-dev',
              onChange: (event) => set({ name: event.target.value }),
            })),
          h('label', { className: 'uv-field' }, h('span', null, '类型'),
            h('select', {
              className: 'uv-select',
              value: value.type,
              onChange: (event) => set({ type: event.target.value }),
            },
            h('option', { value: 'directory' }, '目录 rootfs'),
            h('option', { value: 'image' }, '镜像（img / qcow2）'),
            h('option', { value: 'network' }, '网络磁盘（nbd / iscsi / nfs / ftp / smb）'),
            )),
        ),
        value.type === 'directory'
          ? h('div', { className: 'uv-grid' },
            h('label', { className: 'uv-field' }, h('span', null, 'rootfs 源目录（种子）'),
              h('input', {
                className: 'uv-input',
                value: value.source,
                placeholder: '/home/user/rootfs/alpine',
                onChange: (event) => set({ source: event.target.value }),
              })),
            h('label', { className: 'uv-field' }, h('span', null, '从 rootfs 库选择'),
              h('select', {
                className: 'uv-select',
                value: '',
                onChange: (event) => { if (event.target.value) set({ source: event.target.value }) },
              },
              h('option', { value: '' }, '— 选择 —'),
              ...rootfsLibrary.map((entry) => h('option', { key: entry.id, value: entry.path }, entry.name)),
              )),
          )
          : null,
        value.type === 'image'
          ? h('div', { className: 'uv-grid' },
            h('label', { className: 'uv-field' }, h('span', null, '镜像源文件（种子）'),
              h('input', {
                className: 'uv-input',
                value: value.source,
                placeholder: '/home/user/images/alpine.qcow2',
                onChange: (event) => set({ source: event.target.value }),
              })),
            h('label', { className: 'uv-field' }, h('span', null, '从镜像库选择'),
              h('select', {
                className: 'uv-select',
                value: '',
                onChange: (event) => {
                  const entry = imageLibrary.find((candidate) => candidate.path === event.target.value)
                  if (entry) set({ source: entry.path, imageFormat: entry.format, libraryId: entry.id })
                },
              },
              h('option', { value: '' }, '— 选择 —'),
              ...imageLibrary.map((entry) => h('option', { key: entry.id, value: entry.path }, `${entry.name} (${entry.format})`)),
              )),
          )
          : null,
        value.type === 'network'
          ? h('label', { className: 'uv-field' }, h('span', null, '网络磁盘 URI'),
            h('input', {
              className: 'uv-input',
              value: value.source,
              placeholder: 'nbd://127.0.0.1:10809/export 或 iscsi://user:pass@host/iqn/lun',
              onChange: (event) => set({ source: event.target.value }),
            }))
          : null,

        value.type === 'network'
          ? null
          : h('div', { className: 'uv-card uv-col', style: { gap: 4 } },
            h('label', { className: 'uv-row', style: { gap: 6 } },
              h('input', {
                type: 'checkbox',
                checked: value.linked !== true,
                onChange: (event) => set({ linked: !event.target.checked }),
              }),
              h('span', null, '创建时复制一份到容器专属目录（推荐）')),
            h('div', { className: 'uv-muted' }, value.linked === true
              ? '⚠ 已关闭复制：容器直接读写种子路径，对该容器的修改会污染镜像/rootfs 库。'
              : '种子镜像/rootfs 只读使用；容器的所有改动都落在下方的专属副本里。'),
            value.rootfs !== '' && value.source !== '' && value.rootfs !== value.source
              ? h('div', { className: 'uv-muted' }, `容器副本：${value.rootfs}`)
              : null,
            value.image !== '' && value.source !== '' && value.image !== value.source
              ? h('div', { className: 'uv-muted' }, `容器副本：${value.image}`)
              : null),

        h('div', { className: 'uv-field' }, h('span', null, '挂载映射（宿主路径 / 网络文件 / 镜像 / 网络磁盘 → 容器）'),
          h('div', { className: 'uv-mounts' },
            ...value.mounts.map((mount, index) => h(MountRow, {
              key: index,
              mount,
              index,
              setMount,
              library,
              images: (library?.images ?? []),
              onRemove: () => set({ mounts: value.mounts.filter((_, cursor) => cursor !== index) }),
            })),
            h('div', { className: 'uv-row', style: { flexWrap: 'wrap' } },
              h('button', {
                type: 'button', className: 'uv-btn',
                onClick: () => set({ mounts: [...value.mounts, { kind: 'bind', host: '', guest: '', uri: '', mode: 'rw' }] }),
              }, '+ 宿主路径'),
              h('button', {
                type: 'button', className: 'uv-btn',
                onClick: () => set({ mounts: [...value.mounts, { kind: 'networkFile', host: '', guest: '', uri: '', mode: 'ro' }] }),
              }, '+ 网络文件'),
              h('button', {
                type: 'button', className: 'uv-btn',
                onClick: () => set({ mounts: [...value.mounts, { kind: 'image', host: '', guest: '', uri: '', mode: 'rw' }] }),
              }, '+ 镜像'),
              h('button', {
                type: 'button', className: 'uv-btn',
                onClick: () => set({ mounts: [...value.mounts, { kind: 'networkDisk', host: '', guest: '', uri: '', mode: 'rw' }] }),
              }, '+ 网络磁盘')),
          )),

        h('div', { className: 'uv-card uv-col' },
          h('label', { className: 'uv-row', style: { gap: 6 } },
            h('input', { type: 'checkbox', checked: value.net.enabled, onChange: (event) => setNet({ enabled: event.target.checked }) }),
            h('span', null, '虚拟网络（用户态 WireGuard / NAT，无需 root）')),

          value.net.enabled ? h('div', { className: 'uv-col' },
            h('label', { className: 'uv-field' }, h('span', null, '桥接实现'),
              h('input', {
                className: 'uv-input', value: value.net.bridge,
                placeholder: '留空为默认 userspace；可选 userspace / nat / none / kernel',
                onChange: (event) => setNet({ bridge: event.target.value }),
              })),
            h('label', { className: 'uv-field' }, h('span', null, '虚拟接口（每行一个 --net-if 参数）'),
              h('textarea', {
                className: 'uv-textarea', value: value.net.ifaces.join('\n'),
                placeholder: 'wlan0,addr=192.168.1.2/24,up',
                onChange: (event) => setNet({ ifaces: event.target.value.split('\n').map((line) => line.trim()).filter(Boolean) }),
              })),
            h('label', { className: 'uv-field' }, h('span', null, '虚拟路由（每行一个 --net-route 参数）'),
              h('textarea', {
                className: 'uv-textarea', value: value.net.routes.join('\n'),
                placeholder: '10.8.0.0/24 dev vtun',
                onChange: (event) => setNet({ routes: event.target.value.split('\n').map((line) => line.trim()).filter(Boolean) }),
              })),
            h('label', { className: 'uv-field' }, h('span', null, 'WireGuard 配置'),
              h('textarea', {
                className: 'uv-textarea', value: value.net.wg,
                placeholder: '[Interface]\\nPrivateKey = ...\\n[Peer]\\nPublicKey = ...\\nAllowedIPs = 0.0.0.0/0',
                onChange: (event) => setNet({ wg: event.target.value }),
              })),
          ) : null),

        h('div', { className: 'uv-field' }, h('span', null, '容器选项'),
          h('div', { className: 'uv-row', style: { flexWrap: 'wrap' } },
            h('label', { className: 'uv-chip' }, h('input', { type: 'checkbox', checked: value.options.link2symlink, onChange: (event) => setOption({ link2symlink: event.target.checked }) }), h('span', null, '硬链接转符号链接')),
            h('label', { className: 'uv-chip' }, h('input', { type: 'checkbox', checked: value.options.fakeRoot, onChange: (event) => setOption({ fakeRoot: event.target.checked }) }), h('span', null, '容器内显示为 root')), 
            h('label', { className: 'uv-chip' }, h('input', { type: 'checkbox', checked: value.options.vperm, onChange: (event) => setOption({ vperm: event.target.checked }) }), h('span', null, '虚拟权限（vperm）')),
          ),
          h('div', { className: 'uv-grid', style: { marginTop: 6 } },
            h('label', { className: 'uv-field' }, h('span', null, '虚拟身份 uid:gid'),
              h('input', { className: 'uv-input', value: value.options.vpermId, placeholder: '0:0', onChange: (event) => setOption({ vpermId: event.target.value }) })),
            h('label', { className: 'uv-field' }, h('span', null, '虚拟 PID 起点'),
              h('input', { className: 'uv-input', value: value.options.vpid, placeholder: '留空则不虚拟', onChange: (event) => setOption({ vpid: event.target.value }) })),
            h('label', { className: 'uv-field' }, h('span', null, '容器内 shell（留空自动：有 bash 用 bash，否则用 sh）'),
              h('input', { className: 'uv-input', value: value.options.shell, placeholder: 'bash / sh', onChange: (event) => setOption({ shell: event.target.value }) })),
          )),

        h('label', { className: 'uv-field' }, h('span', null, '容器环境变量（每行 KEY=VALUE，DSH 的非交互命令也生效）'),
          h('textarea', {
            className: 'uv-textarea', value: value.env.join('\n'),
            placeholder: 'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin\nTZ=Asia/Shanghai\nPIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple',
            onChange: (event) => set({ env: event.target.value.split('\n').map((line) => line.trim()).filter(Boolean) }),
          })),

        h('label', { className: 'uv-field' }, h('span', null, '额外 uvroot 参数（每行一个）'),
          h('textarea', {
            className: 'uv-textarea', value: value.extraArgs.join('\n'),
            placeholder: '--kernel-release=5.15.0',
            onChange: (event) => set({ extraArgs: event.target.value.split('\n').map((line) => line.trim()).filter(Boolean) }),
          })),

        uvroot?.available === false
          ? h(Banner, { text: `uvroot 不可用：${uvroot.detail}。请在设置里配置 uvroot 可执行文件路径。` })
          : null,
      )
    }

    // ── 4. container manager overlay ──────────────────────────────────────

    function ManagerDialog() {
      const state = useUvroot()
      const request = useDialogs().manager
      const [path, setPath] = React.useState('')
      const [draft, setDraft] = React.useState(() => emptyContainer())
      const [editingId, setEditingId] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState(null)
      const [notice, setNotice] = React.useState(null)
      const [confirmDelete, setConfirmDelete] = React.useState(null)
      const [exported, setExported] = React.useState(null)
      const busySeconds = useElapsed(busy)

      React.useEffect(() => {
        if (request === null) return
        setPath(request.path ?? '')
        // Always start a fresh "new container" form; a previous container is
        // only loaded when its own 编辑 button is pressed.
        setEditingId(null)
        setConfirmDelete(null)
        setDraft(emptyContainer())
        setError(null)
        setNotice(null)
      }, [request])

      if (request === null) return null
      const workspace = workspaceOf(state.data, path)
      const containers = workspace?.containers ?? []

      const run = (promise, message) => {
        setBusy(true)
        setError(null)
        mutate(promise)
          .then((value) => { if (message) setNotice(message(value)) })
          .catch((reason) => { setError(String(reason?.message ?? reason)) })
          .finally(() => { setBusy(false) })
      }

      const save = () => {
        if (path.trim() === '') { setError('请先填写工作目录路径'); return }
        const creating = editingId === null
        setBusy(true)
        setError(null)
        setNotice(null)
        mutate(creating
          ? api('POST', '/container/create', { path, container: containerPayload(draft) })
          : api('POST', '/container/update', { path, id: editingId, patch: containerPayload(draft) }))
          .then((value) => {
            const saved = value?.container
            if (creating) {
              // Leave the form empty for the next container instead of keeping
              // the just-created configuration on screen.
              setDraft(emptyContainer())
              setEditingId(null)
            } else if (saved !== undefined) {
              setDraft(withDefaults(saved))
            }
            setNotice(creating ? `已创建：${saved?.name ?? ''}` : '已保存修改')
          })
          .catch((reason) => { setError(String(reason?.message ?? reason)) })
          .finally(() => { setBusy(false) })
      }
      const remove = (id) => {
        setBusy(true)
        setError(null)
        setNotice(null)
        // The server answers with the POST-delete workspace snapshot, so a
        // mutation that did not land is reported instead of looking silent.
        mutate(api('POST', '/container/delete', { path, id }))
          .then((value) => {
            if ((value?.containers ?? []).some((container) => container.id === id)) {
              setError(`删除未生效（登记路径：${value?.path ?? path}）`)
              return
            }
            setNotice('已删除')
          })
          .catch((reason) => { setError(String(reason?.message ?? reason)) })
          .finally(() => { setBusy(false) })
      }
      const makeDefault = (id) => run(api('POST', '/container/default', { path, id }), () => '已设为默认容器')
      const exportContainer = (id) => {
        setBusy(true)
        setError(null)
        setNotice(null)
        setExported(null)
        // Directory containers export a rootfs tar; image containers export
        // the image file itself.
        mutate(api('POST', '/container/export', { path, id }))
          .then((value) => {
            setExported(value)
            setNotice(`已导出：${value.path}`)
          })
          .catch((reason) => { setError(String(reason?.message ?? reason)) })
          .finally(() => { setBusy(false) })
      }

      return h('div', { className: 'uv-overlay', onMouseDown: (event) => { if (event.target === event.currentTarget) closeManager() } },
        h('div', { className: 'uv-dialog' },
          h('div', { className: 'uv-row', style: { justifyContent: 'space-between' } },
            h('h3', null, 'uvroot 容器管理'),
            h('button', { type: 'button', className: 'uv-btn', onClick: closeManager }, '关闭')),

          h('div', { className: 'uv-col' },
            h('label', { className: 'uv-field' }, h('span', null, '工作目录（容器按工作目录共享）'),
              h('input', {
                className: 'uv-input', value: path,
                placeholder: '/home/user/project',
                onChange: (event) => setPath(event.target.value),
              })),
            workspace === undefined
              ? h('div', { className: 'uv-row' },
                h('span', { className: 'uv-muted' }, '填写目录后可把它登记为虚拟环境。'),
                h('button', {
                  type: 'button', className: 'uv-btn', disabled: busy || path.trim() === '',
                  onClick: () => run(api('POST', '/workspace', { path, mode: 'virtual' }), () => '已登记为虚拟环境'),
                }, '登记为虚拟环境'))
              : h('div', { className: 'uv-row' },
                h('span', { className: 'uv-muted' }, `当前模式：${workspace.mode === 'virtual' ? '虚拟环境' : '正常模式'}`),
                h('button', {
                  type: 'button', className: 'uv-btn', disabled: busy,
                  onClick: () => run(api('POST', '/workspace', { path, mode: workspace.mode === 'virtual' ? 'normal' : 'virtual' })),
                }, workspace.mode === 'virtual' ? '切换为正常模式' : '切换为虚拟环境')),

            h('div', { className: 'uv-field' }, h('span', null, `已有容器（${containers.length}）`),
              h('div', { className: 'uv-list' },
                ...containers.map((container) => h('div', { className: 'uv-card', key: container.id }, 
                  h('div', { className: 'uv-row', style: { justifyContent: 'space-between' } },
                    h('div', null,
                      h('div', null, `${container.name} `, h('span', { className: 'uv-badge' }, TYPE_LABEL[container.type] ?? container.type),
                        container.id === workspace.defaultContainerId ? h('span', { className: 'uv-badge' }, '默认') : null),
                      h('div', { className: 'uv-muted' }, container.type === 'directory' ? container.rootfs
                        : container.type === 'image' ? `${container.image} (${container.imageFormat})`
                          : container.networkUri)),
                    h('div', { className: 'uv-row' },
                      h('button', { className: 'uv-btn', type: 'button', disabled: busy, onClick: () => { setEditingId(container.id); setDraft(withDefaults(container)) } }, '编辑'),
                      h('button', { className: 'uv-btn', type: 'button', disabled: busy, onClick: () => makeDefault(container.id) }, '设为默认'),
                      h('button', { className: 'uv-btn', type: 'button', disabled: busy, onClick: () => exportRootfs(container.id) }, '导出 rootfs'),
                      container.type === 'network'
                        ? null
                        : h('button', {
                          className: 'uv-btn', type: 'button', disabled: busy,
                          title: container.type === 'image' ? '把该容器的镜像导出到导出目录' : '把该容器的 rootfs 打包成 tar.gz',
                          onClick: () => exportContainer(container.id),
                        }, container.type === 'image' ? '导出镜像' : '导出 rootfs'),
                      confirmDelete === container.id
                        ? h('button', {
                          className: 'uv-btn uv-danger', type: 'button', disabled: busy,
                          onClick: () => { setConfirmDelete(null); remove(container.id) },
                        }, '确认删除')
                        : h('button', {
                          className: 'uv-btn', type: 'button', disabled: busy,
                          onClick: () => setConfirmDelete(container.id),
                        }, '删除'),
                    )),
                )),
              )),

            h('div', { className: 'uv-card uv-col' },
              h('div', { className: 'uv-row', style: { justifyContent: 'space-between' } },
                h('strong', null, editingId === null ? '新建容器' : `编辑容器 ${editingId}`),
                editingId === null ? null : h('button', { className: 'uv-btn', type: 'button', onClick: () => { setEditingId(null); setDraft(emptyContainer()) } }, '改为新建')),
              h(ContainerForm, { draft, setDraft, library: state.data?.library, uvroot: state.data?.uvroot }),
              h('div', { className: 'uv-row' },
                h('button', { className: 'uv-btn uv-primary', type: 'button', disabled: busy, onClick: save }, busy ? `处理中… ${busySeconds}s` : '保存容器'),
                h(Banner, { text: error }),
                notice === null ? null : h('span', { className: 'uv-muted' }, notice),
              )),
            exported === null ? null : h('div', { className: 'uv-card uv-col', style: { gap: 4 } },
              h('strong', null, exported.kind === 'image' ? '已导出镜像' : '已导出 rootfs 归档'),
              h('div', { className: 'uv-muted' }, exported.path),
              h('div', { className: 'uv-muted' }, `大小：${(exported.size / 1024 / 1024).toFixed(1)} MiB · 格式：${exported.format}`),
              h('div', { className: 'uv-row' },
                h('a', {
                  className: 'uv-btn uv-primary',
                  href: exported.download,
                  download: exported.name,
                }, '下载'),
                h('span', { className: 'uv-muted' }, '也可直接从上面的路径取用（可作为新的种子导入镜像库 / rootfs 库）'))),
          ),
        ))
    }

    /** The workspace-row marker, as a title prefix (see TITLE_MARK below). */
    const TITLE_MARK = '⟨📁⟩ '

    function OverlayHost(props) {
      const state = useUvroot()
      useDialogs()
      const useWorkspaces = props.useWorkspaces
      const items = typeof useWorkspaces === 'function' ? useWorkspaces((snapshot) => snapshot.items) : []
      // Keep the workspace ROW marked. The host half reconciles this too; this
      // pass exists so the marker appears without waiting for a host restart.
      // Both writers compute the same idempotent predicate, so they converge.
      React.useEffect(() => {
        const remote = ctxRef.current?.get?.('remote.workspace')
        if (remote === undefined || typeof remote.rename !== 'function') return
        for (const workspace of items ?? []) {
          const entry = state.data?.workspaces?.[workspace.path]
          const virtual = entry?.mode === 'virtual'
          const marked = workspace.title.startsWith(TITLE_MARK)
          if (virtual === marked) continue
          const title = virtual ? `${TITLE_MARK}${workspace.title}` : workspace.title.slice(TITLE_MARK.length)
          Promise.resolve(remote.rename({ workspaceId: workspace.workspaceId, title }))
            .then((result) => { if (result?.ok === false) console.warn('uvroot-env: 无法更新工作区标题', result.error) })
            .catch(() => {})
        }
      }, [items, state.data])
      return h(React.Fragment, null, h(StyleSheet, null), h(ManagerDialog, null))
    }

    // ── 5. add-workspace directory flow with environment selection ────────

    function DirectoryFlow(props) {
      const { open, busy, onPicked, onCancel, onError, pick } = props
      const state = useUvroot()
      const [path, setPath] = React.useState('')
      const [mode, setMode] = React.useState('normal')
      const [containerId, setContainerId] = React.useState(null)
      const [creating, setCreating] = React.useState(false)
      const [draft, setDraft] = React.useState(emptyContainer())
      const [working, setWorking] = React.useState(false)
      const [error, setError] = React.useState(null)
      const [confirmDelete, setConfirmDelete] = React.useState(null)
      const workingSeconds = useElapsed(working)

      const workspace = workspaceOf(state.data, path)
      const containers = workspace?.containers ?? []

      React.useEffect(() => {
        if (open) {
          // A fresh add-workspace interaction never inherits the previous one's
          // directory, environment choice, or half-filled container form.
          setError(null)
          setCreating(false)
          setPath('')
          setMode('normal')
          setContainerId(null)
          setDraft(emptyContainer())
          setConfirmDelete(null)
        }
      }, [open])

      if (open !== true) return null

      const browse = () => {
        Promise.resolve()
          .then(() => pick())
          .then((picked) => { if (typeof picked === 'string' && picked.length > 0) setPath(picked) })
          .catch((reason) => { onError(String(reason?.message ?? reason)) })
      }

      const toggleCreating = () => {
        setCreating((value) => !value)
        // A new-container form must never inherit whatever was typed for a
        // previous container (or a previous visit to this dialog).
        setDraft(emptyContainer())
        setConfirmDelete(null)
        setError(null)
      }

      const removeContainer = (id) => {
        if (path.trim() === '') return
        setWorking(true)
        setError(null)
        mutate(api('POST', '/container/delete', { path, id }))
          .then((value) => {
            if ((value?.containers ?? []).some((containers) => containers.id === id)) {
              setError(`删除未生效（登记路径：${value?.path ?? path}）`)
            }
            if (containerId === id) setContainerId(null)
          })
          .catch((reason) => { setError(String(reason?.message ?? reason)) })
          .finally(() => { setWorking(false) })
      }

      const createContainer = () => {
        if (path.trim() === '') { setError('请先选择目录'); return }
        setWorking(true)
        setError(null)
        mutate(api('POST', '/container/create', { path, container: containerPayload(draft) }))
          .then((value) => {
            setMode('virtual')
            setContainerId(value.container.id)
            setCreating(false)
            setDraft(emptyContainer())
          })
          .catch((reason) => { setError(String(reason?.message ?? reason)) })
          .finally(() => { setWorking(false) })
      }

      const confirm = () => {
        if (path.trim() === '') { setError('请选择或填写目录路径'); return }
        setWorking(true)
        setError(null)
        // Normal mode is the official default: only touch the plugin registry
        // when this directory already carries an environment (so choosing
        // "normal" clears a previous virtual assignment).
        const known = workspace !== undefined
        const first = mode === 'virtual' || known
          ? mutate(api('POST', '/workspace', { path, mode }))
          : Promise.resolve()
        first
          .then(() => {
            if (mode === 'virtual' && containerId !== null) {
              return api('POST', '/container/default', { path, id: containerId }).then(() => undefined)
            }
            return undefined
          })
          .then(() => { onPicked(path) })
          .catch((reason) => { setError(String(reason?.message ?? reason)) })
          .finally(() => { setWorking(false) })
      }

      return h('div', { className: 'uv-overlay' },
        h('div', { className: 'uv-dialog' },
          h('h3', null, '添加工作目录'),
          h('div', { className: 'uv-col' },
            h('label', { className: 'uv-field' }, h('span', null, '目录路径'),
              h('div', { className: 'uv-row' },
                h('input', {
                  className: 'uv-input', value: path,
                  placeholder: '/home/user/project',
                  onChange: (event) => setPath(event.target.value),
                }),
                h('button', { className: 'uv-btn', type: 'button', onClick: browse }, '浏览…'))),

            h('div', { className: 'uv-field' }, h('span', null, '运行环境'),
              h('div', { className: 'uv-row' },
                h('div', { className: 'uv-seg' },
                  h('button', { type: 'button', className: mode === 'normal' ? 'uv-on' : undefined, onClick: () => setMode('normal') }, '官方默认（正常模式）'),
                  h('button', { type: 'button', className: mode === 'virtual' ? 'uv-on' : undefined, onClick: () => setMode('virtual') }, '虚拟用户态环境（uvroot）')),
                h('span', { className: 'uv-muted' }, mode === 'virtual'
                  ? '命令在 uvroot 容器内执行，无需宿主 root，不影响外部系统'
                  : '命令在宿主上执行，由 bubblewrap 限制'))),

            mode === 'virtual' ? h('div', { className: 'uv-card uv-col' },
              h('div', { className: 'uv-row', style: { justifyContent: 'space-between' } },
                h('strong', null, '该目录已有的容器'),
                h('button', { className: 'uv-btn', type: 'button', onClick: toggleCreating }, creating ? '收起' : '+ 新建容器')),
              h('div', { className: 'uv-muted' }, workspace === undefined
                ? '该目录尚未登记，添加后即可使用下面的容器。'
                : '这些容器由该工作目录下的所有会话共用，选中一个作为默认容器；也可以在这里删除。'),
              containers.length === 0
                ? h('div', { className: 'uv-muted' }, '该目录还没有容器，请先新建一个。')
                : h('div', { className: 'uv-list' },
                  ...containers.map((container) => h('div', {
                    key: container.id,
                    className: `uv-item${(containerId ?? workspace?.defaultContainerId) === container.id ? ' uv-active' : ''}`,
                    onClick: () => setContainerId(container.id),
                  },
                  h('div', { className: 'uv-row', style: { justifyContent: 'space-between', gap: 8 } },
                    h('span', null, `${container.name} `, h('span', { className: 'uv-badge' }, TYPE_LABEL[container.type] ?? container.type)),
                    confirmDelete === container.id
                      ? h('button', {
                        className: 'uv-btn uv-danger', type: 'button', disabled: working,
                        onClick: (event) => { event.stopPropagation(); setConfirmDelete(null); removeContainer(container.id) },
                      }, '确认删除')
                      : h('button', {
                        className: 'uv-btn', type: 'button', disabled: working,
                        onClick: (event) => { event.stopPropagation(); setConfirmDelete(container.id) },
                      }, '删除')),
                  h('small', null, container.type === 'directory' ? container.rootfs
                    : container.type === 'image' ? container.image : container.networkUri)))),
              creating
                ? h('div', { className: 'uv-col', style: { borderTop: '1px solid var(--dsw-alias-border-l2)', paddingTop: 8 } },
                  h('strong', null, '新建容器'),
                  h(ContainerForm, { draft, setDraft, library: state.data?.library, uvroot: state.data?.uvroot }),
                  h('div', { className: 'uv-row' },
                    h('button', { className: 'uv-btn uv-primary', type: 'button', disabled: working, onClick: createContainer }, working ? `创建中… ${workingSeconds}s` : '创建容器'),
                    h('button', { className: 'uv-btn', type: 'button', onClick: toggleCreating }, '取消')),
                )
                : null,
            ) : null,

            h(Banner, { text: error }),
            h('div', { className: 'uv-row', style: { justifyContent: 'flex-end' } },
              h('button', { className: 'uv-btn', type: 'button', onClick: onCancel }, '取消'),
              h('button', {
                className: 'uv-btn uv-primary', type: 'button',
                disabled: working || busy === true,
                onClick: confirm,
              }, working ? `处理中… ${workingSeconds}s` : '添加')),
          )),
      )
    }

    // ── 6. settings page ──────────────────────────────────────────────────

    function SettingsPage() {
      const state = useUvroot()
      const [uvrootBin, setUvrootBin] = React.useState('')
      const [libDir, setLibDir] = React.useState('')
      const [strict, setStrict] = React.useState(true)
      const [tarPath, setTarPath] = React.useState('')
      const [tarName, setTarName] = React.useState('')
      const [imagePath, setImagePath] = React.useState('')
      const [dirPath, setDirPath] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState(null)
      const [notice, setNotice] = React.useState(null)
      const loaded = React.useRef(false)

      React.useEffect(() => {
        if (state.data === null || loaded.current) return
        loaded.current = true
        setUvrootBin(state.data.settings.uvrootBin ?? '')
        setLibDir(state.data.settings.libDir ?? '')
        setStrict(state.data.settings.strictIsolation !== false)
      }, [state.data])

      const run = (promise, message) => {
        setBusy(true)
        setError(null)
        setNotice(null)
        mutate(promise)
          .then(() => { if (message) setNotice(message) })
          .catch((reason) => { setError(String(reason?.message ?? reason)) })
          .finally(() => { setBusy(false) })
      }

      const library = state.data?.library ?? { rootfs: [], images: [] }
      const uvroot = state.data?.uvroot

      return h('div', { className: 'uv-col', style: { padding: 4 } },
        h(StyleSheet, null),
        h('div', { className: 'uv-card uv-col' },
          h('strong', null, 'uvroot 运行时'),
          h('div', { className: 'uv-muted' }, uvroot === undefined ? '加载中…'
            : uvroot.available ? `可用：${uvroot.bin} — ${uvroot.detail}` : `不可用：${uvroot.detail}`),
          h('div', { className: 'uv-grid' },
            h('label', { className: 'uv-field' }, h('span', null, 'uvroot 可执行文件'),
              h('input', { className: 'uv-input', value: uvrootBin, placeholder: '/path/to/uvroot', onChange: (event) => setUvrootBin(event.target.value) })),
            h('label', { className: 'uv-field' }, h('span', null, '驱动库目录（libext2fs 等 dlopen 依赖，可留空）'),
              h('input', { className: 'uv-input', value: libDir, placeholder: '/path/to/lib64', onChange: (event) => setLibDir(event.target.value) })),
          ),
          h('label', { className: 'uv-row', style: { gap: 6, alignItems: 'flex-start' } },
            h('input', { type: 'checkbox', checked: strict, onChange: (event) => setStrict(event.target.checked) }),
            h('span', null,
              '严格隔离：阻止绕过容器的宿主访问',
              h('br', null),
              h('span', { className: 'uv-muted' }, '开启后，虚拟环境工作区里会拒绝 run_code（PTC 在宿主进程执行）、MCP 工具（宿主进程），以及 read/write/edit/glob/grep/read_image 访问工作目录以外的路径。'))),
          h('div', { className: 'uv-row' },
            h('button', {
              className: 'uv-btn uv-primary', type: 'button', disabled: busy,
              onClick: () => run(api('POST', '/settings', { uvrootBin, libDir, strictIsolation: strict }), '已保存，容器脚本已重新生成'),
            }, '保存'),
            h('button', { className: 'uv-btn', type: 'button', onClick: () => void refresh() }, '重新检测'),
          ),
        ),

        h('div', { className: 'uv-card uv-col' },
          h('strong', null, 'rootfs 库'),
          h('div', { className: 'uv-muted' }, `数据目录：${state.data?.paths?.rootfsDir ?? ''}`),
          h('div', { className: 'uv-list' },
            ...(library.rootfs.length === 0 ? [h('div', { className: 'uv-muted' }, '还没有 rootfs')]
              : library.rootfs.map((entry) => h('div', { className: 'uv-card uv-row', key: entry.id, style: { justifyContent: 'space-between' } },
                h('div', null, h('div', null, entry.name), h('div', { className: 'uv-muted' }, entry.path)),
                h('div', { className: 'uv-row' },
                  h('button', { className: 'uv-btn', type: 'button', onClick: () => { setDirPath(entry.path) } }, '选用'),
                  h('button', { className: 'uv-btn uv-danger', type: 'button', onClick: () => run(api('POST', '/library/remove', { kind: 'rootfs', id: entry.id })) }, '移除'),
                ))))),
          h('div', { className: 'uv-grid' },
            h('label', { className: 'uv-field' }, h('span', null, '从 tar / tar.gz 导入 rootfs'),
              h('input', { className: 'uv-input', value: tarPath, placeholder: '/path/to/alpine.tar.gz', onChange: (event) => setTarPath(event.target.value) })),
            h('label', { className: 'uv-field' }, h('span', null, '名称（可留空）'),
              h('input', { className: 'uv-input', value: tarName, onChange: (event) => setTarName(event.target.value) })),
          ),
          h('div', { className: 'uv-row' },
            h('button', {
              className: 'uv-btn', type: 'button', disabled: busy || tarPath.trim() === '',
              onClick: () => run(api('POST', '/library/import', { tarPath, name: tarName }), '已导入 rootfs'),
            }, '导入 tar'),
            h('input', {
              className: 'uv-input', value: dirPath, style: { maxWidth: 320 },
              placeholder: '已有 rootfs 目录路径', onChange: (event) => setDirPath(event.target.value),
            }),
            h('button', {
              className: 'uv-btn', type: 'button', disabled: busy || dirPath.trim() === '',
              onClick: () => run(api('POST', '/library/rootfs', { dirPath }), '已添加目录'),
            }, '添加目录'),
          ),
        ),

        h('div', { className: 'uv-card uv-col' },
          h('strong', null, '镜像库'),
          h('div', { className: 'uv-muted' }, `图片目录：${state.data?.paths?.imagesDir ?? ''}`),
          h('div', { className: 'uv-list' },
            ...(library.images.length === 0 ? [h('div', { className: 'uv-muted' }, '还没有镜像')]
              : library.images.map((entry) => h('div', { className: 'uv-card uv-row', key: entry.id, style: { justifyContent: 'space-between' } },
                h('div', null, h('div', null, `${entry.name} `, h('span', { className: 'uv-badge' }, entry.format)), h('div', { className: 'uv-muted' }, entry.path)),
                h('div', { className: 'uv-row' },
                  h('button', { className: 'uv-btn', type: 'button', onClick: () => { setImagePath(entry.path) } }, '选用'),
                  h('button', { className: 'uv-btn uv-danger', type: 'button', onClick: () => run(api('POST', '/library/remove', { kind: 'images', id: entry.id })) }, '移除'),
                ))))),
          h('div', { className: 'uv-row' },
            h('input', {
              className: 'uv-input', value: imagePath,
              placeholder: '/path/to/alpine.img 或 alpine.qcow2', onChange: (event) => setImagePath(event.target.value),
            }),
            h('button', {
              className: 'uv-btn', type: 'button', disabled: busy || imagePath.trim() === '',
              onClick: () => run(api('POST', '/library/image', { filePath: imagePath }), '已添加镜像'),
            }, '添加镜像'),
          ),
        ),

        h('div', { className: 'uv-card uv-col' },
          h('strong', null, '容器管理'),
          h('div', { className: 'uv-muted' }, `导出目录：${state.data?.paths?.exportsDir ?? ''}`),
          h('button', { className: 'uv-btn', type: 'button', onClick: () => openManager({ path: null }) }, '打开容器管理器'),
        ),

        h(Banner, { text: error }),
        notice === null ? null : h('div', { className: 'uv-muted' }, notice),
      )
    }

    // ── plugin body ───────────────────────────────────────────────────────

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctxRef.current = ctx
        const NS = 'uvroot.env'
        const zh = {
          'nav': '虚拟环境',
          'env.normal': '正常模式',
          'env.virtual': '虚拟环境模式',
        }
        ctx.effect(() => ctx.locale.register(NS, { zh, en: { 'nav': 'Virtual environments', 'env.normal': 'Normal', 'env.virtual': 'Virtual' } }), 'uvroot-env: locale')
        const t = ctx.locale.bind(NS)

        // The composer's permission control is left to the official plugin: it
        // is never shadowed, so a normal workspace keeps the stock interface.
        // A virtual workspace still gets the two confined choices inside the
        // container switcher below.

        // Per-session container switcher in the composer tool row. It renders
        // nothing unless the current session's workspace is a virtual
        // environment, so normal workspaces never see plugin UI.
        ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
          name: 'conversation.input.left',
          id: 'uvroot-container',
          order: 5,
          inject: (sessionId) => ({
            setPermission: async (preset) => {
              const sessions = ctx.get('sessions')
              const live = sessions?.binding?.(sessionId)?.session
              if (live === undefined) throw new Error('会话尚未就绪，无法切换权限')
              const result = await live.command(`/permission ${preset}`)
              if (result?.ok !== true) {
                throw new Error(`权限切换失败：${result?.error?.code ?? ''} ${result?.error?.message ?? ''}`)
              }
              if (result.value?.matched !== true) throw new Error('宿主未提供 /permission 命令')
              return true
            },
          }),
        }, ContainerSwitcher))

        // The workspace ROW is marked through the workspace title (see the host
        // half: DSH has no per-workspace-row slot). The header keeps a
        // persistent marker for the open session.
        ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
          name: 'conversation.session.header.utilities',
          id: 'uvroot-env',
          order: 5,
          inject: () => ({}),
        }, HeaderEnvBadge))

        // Environment choice inside the add-workspace directory flow.
        const flowInject = () => ({
          pick: async () => {
            const uiWorkspace = ctx.get('uiWorkspace')
            return uiWorkspace === undefined ? null : await uiWorkspace.pickDirectory()
          },
        })
        for (const slot of ['sidebar.workspaces.directoryFlow', 'conversation.hero.workspace.directoryFlow']) {
          ctx.slots.inject(slot, () => ctx.slots.register({
            name: slot,
            priority: -1,
            inject: flowInject,
          }, DirectoryFlow))
        }

        // Settings page and the manager overlay host.
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'uvroot-env',
          order: 40,
          label: () => t('nav'),
        }, SettingsPage))
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'uvroot-env-manager',
          order: 60,
        }, OverlayHost))

        void refresh()
      },
    }
  },
})
