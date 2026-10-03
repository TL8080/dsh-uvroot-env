# 故障排查

这份文档记录的是**实际踩过的坑**：现象 → 根因 → 处理方式 → 怎么快速确认。
每条都对应一次真实的调试，不是推测。

---

## 0. 先做这三件事

| 目的 | 命令 / 操作 |
|---|---|
| 确认合成配置对不对 | `node apps/cli/lib/bin.js --profile web --dump-config \| grep -A6 'id: sandbox'` |
| 确认插件行活着 | `plugin_manager list_plugins` 找 `include:uvroot-env`，看 `fiberPhase` 是否 `active` |
| 确认客户端插槽活着 | `cordis_inspect_query` (client / Slots / listSubTree, `root: 'shell.overlay'`)，看我们的 occupant 是否 `active: true` |

客户端插槽里 `active: false` 是**关键信号**：说明那个 entry 渲染时抛错并"退位"了，
症状就是"界面元素不出现 / 点了没反应"（DSH 的插槽有崩溃隔离，不会把整页搞崩，也不会弹错）。

---

## 1. 容器管理器打不开 / 编辑删除没反应

**现象**：点「管理容器…」什么都不出现；或者以前能看到列表但点编辑/删除毫无反应。

**根因**：`ManagerDialog` 的表单状态初始化成了 `null`：

```js
const [draft, setDraft] = React.useState(null)   // 错
React.useEffect(() => { ...; setDraft(...) }, [request])   // effect 在首次渲染之后才跑
```

打开管理器的**第一帧**就是 `request != null && draft == null`，`null` 被传进容器表单 →
`Cannot read properties of null` → 该 slot entry 退位 → 弹层永远不出现。

**处理**：

```js
const [draft, setDraft] = React.useState(() => emptyContainer())
```

并且在 `ContainerForm` 内部再做一次归一化（缺字段/为 null 都补齐）——渲染绝不能因为
半个 draft 崩掉。

**确认**：`Slots.listSubTree(root:'shell.overlay')` 里 `uvroot-env-manager` 从
`active:false` 变回 `active:true`。

---

## 2. 弹层里的按钮点不动

**现象**：管理器显示出来了，但按钮没反应。

**根因**：容器管理器挂在 `shell.overlay` 上，而这一层的 CSS 是：

```css
.overlayLayer { pointer-events: none; }
.overlayLayer > * { pointer-events: auto; }
```

层本身**点击穿透**，每个 occupant 必须自己 opt-in。

**处理**：`.uv-overlay` / `.uv-dialog` 显式 `pointer-events: auto`。

---

## 3. 删除/编辑"看起来没生效"

**现象**：点了删除，列表里那个容器还在。

**根因**：客户端读取状态复用了**正在飞行中的 GET**。如果这次读是在写操作之前发出的，
返回的就是写之前的数据，界面照旧。

**处理**：把读请求**串行化**，并且每次写操作之后**重新发起**一次读：

```js
const previous = store.inflight ?? Promise.resolve()
const next = previous.catch(() => {}).then(() => api('GET', '/state'))...
```

另外：删除、保存都会用服务端返回的**写后快照**校验是否真的落地，没落地会明确报
`删除未生效（登记路径：…）`，不再静默。

---

## 4. 界面是深色 / 对比度太低

**现象**：浅色主题下插件面板仍是深色；或者按钮、输入框和背景糊在一起。

**根因（两处）**：

1. 用了**不存在的变量名** `--dsh-color-*`，浏览器取不到就用了 fallback 里的深色字面量。
   DSH 的主题 token 是 `--dsw-alias-*`。
2. 描边用了 `--dsw-alias-border-l1`（浅色下只有 4% 黑），按钮底色 `bg-layer-1` 在浅色主题里
   就是纯白——白底白按钮 + 几乎看不见的边。

**处理**：

| 元素 | 取值 |
|---|---|
| 弹窗 / 菜单底色 | `--dsw-alias-bg-overlay` |
| 卡片 / 按钮底色 | `--dsw-alias-bg-module-platform`（浅色浅灰、深色比弹窗更暗） |
| 输入框底色 | `--dsw-alias-bg-base` |
| 描边 | `--dsw-alias-border-l3`（12%/16%）；卡片与分隔线 `--dsw-alias-border-l2` |
| 主按钮 | `--dsw-alias-button-primary-fill` + `--dsw-alias-label-primary-foreground` |
| 悬停 | `--dsw-alias-button-ghost-active-hover` / `--dsw-alias-interactive-bg-hover` |

**注意**：主按钮的文字**不能**写死 `#fff`——深色主题里 `brand-primary` 是近白色，
必须用 `label-primary-foreground`（它会跟着主题反转）。

**确认**：`cordis_inspect_query` (client / Theme / listTokens) 拿当前 token 名单。

---

## 5. 镜像容器报 `no user-space filesystem driver could read`

**现象**：

```
uvroot error: netfs: no user-space filesystem driver could read xxx.qcow2 (supported: ext2/3/4)
```

**根因**：uvroot 用 `dlopen` 加载 `libext2fs`，两种可能：

1. 编译时没启用——`src/extension/netfs/fs_ext2.c` 里 `HAVE_LIBEXT2FS` 未定义，
   驱动变成 `.implemented = false`，**任何**镜像都会被跳过；
2. 运行时找不到 `libext2fs.so.2`（它不在默认 loader 搜索路径里）。

**处理**：

```bash
# ① 确认 pkg-config 能看到 e2fsprogs 头文件
export PKG_CONFIG_PATH="$WORK/netfs-deps/sysroot/usr/lib64/pkgconfig:$WORK/netfs-deps/sysroot/usr/share/pkgconfig"
export PKG_CONFIG_SYSROOT_DIR="$WORK/netfs-deps/sysroot"
pkg-config --exists ext2fs && echo ok

# ② 只改了 CFLAGS 时 make 不会重编（.o 比源文件新），戳一下再编
touch src/extension/netfs/fs_ext2.c
make -C src uvroot
```

然后在该插件的 **设置 → 虚拟环境 → 驱动库目录** 填 `.../netfs-deps/sysroot/usr/lib64`，
runner 会据此导出 `LD_LIBRARY_PATH`。

**自检**：

```bash
LD_LIBRARY_PATH=/path/to/lib64 uvroot --netfs=/:qcow2:///abs/disk.qcow2 --vperm -i 0:0 /bin/sh -c 'ls /'
```

---

## 6. 容器里 `bash: not found`

**现象**：`uvroot error: 'bash' not found`。

**根因**：DSH 的命令固定是 `bash -c`，但容器 rootfs 里只有 busybox `sh`（Alpine 默认）。

**处理**：runner 会自动把 `bash` 换成容器里真实存在的 `sh`：

- 先看 spec 里的 `UVROOT_SHELL`（容器表单的「容器内 shell」，留空则自动）；
- 否则从 `-r <rootfs>` 里推出 rootfs 路径，用 `lstat` 探测 `bin/bash`、`usr/bin/bash`、
  `bin/sh`、`usr/bin/sh`。

> 探测必须用 `lstat`/`-L`：rootfs 里的 `/bin/sh -> /bin/busybox` 是**绝对符号链接**，
> 在宿主上按宿主根解析会"不存在"，`existsSync`/`test -e` 会误判。

最省事的做法是镜像里装 `bash`（`apk add bash`）。

---

## 7. 装包时刷 `No space left on device`

**现象**：`apk add` 期间大量

```
uvroot warning: netfs: cannot create symlink "usr/libexec/git-core/.apk.xxx" ...: No space left on device
uvroot warning: ext2fs_block_alloc_stats: Illegal block number: ...
```

但 `df -h /` 显示还有十几 G 空闲。

**根因**：uvroot ext2 写入驱动在**符号链接创建**路径上的误报（和 `block_alloc_stats`
的非法块号是同一处）。与 `--link2symlink` **无关**：关掉它一样出现。

**结论：可以直接忽略**。实测 `apk add` 退出码 0、`/usr/libexec/git-core/` 159 个条目齐全、
`git --version` 正常、命令可用。必要时容器内 `apk fix <包>` 再跑一次。

---

## 8. 改了代码不生效

| 改动 | 生效方式 |
|---|---|
| `client.js` | **热重载**，刷新页面即可 |
| `cordis.patch.yml` | 需要一次 bundle 重整：`plugin_manager set_bundle`（值不变也会重新合成） |
| `index.js` / `lib/*.js` | **必须重启 dsh** |

**为什么宿主代码要重启**：DSH 的 Loader 用普通 ESM `import()` 加载插件模块，模块按 URL 缓存；
`plugin_manager` 的 enable/disable 只会**重新执行 `apply()`**，不会重新 import 模块。

**怎么确认到底有没有重新加载**：在 `UvrootStore` 构造函数里插一行探针，然后 toggle 插件：

```js
try { writeFileSync(join(root, 'apply-probe.txt'), String(Date.now())) } catch {}
```

- 出现 `apply-probe.txt` → 模块被重新 import（新代码生效）；
- 只有 `bin/runner.sh` 的 mtime 变了、探针文件没出现 → `apply()` 重跑了但模块仍是旧的。

`runner.sh` **每次 `apply()` 都会从磁盘重新复制**，所以只改 runner 不用重启。

---

## 9. 权限出现两套 / 图标位置不对（设计取舍）

- **权限只能有一个入口**：官方 `conversation.input.permission` 是 `single` 槽，插件不应再在别处
  放第二套只读/可写按钮（会造成"两处设置同一个东西"）。当前实现：权限只用官方控件；
  容器切换器里只显示一行只读文字说明当前模式。
- **工作区行标识只能用标题**：`sidebar.workspaces` 是单占位槽，工作区行没有扩展槽，官方客户端包
  只导出 `apply`/`inject`（不导出 `WorkspaceBrowser` 组件）。所以在不做 DOM hack 的前提下，
  唯一能落在工作区行上的东西就是**工作区标题**：用官方 `setTitle` 加/去 `⟨📁⟩ ` 前缀。
- **工具栏不放图标**：`容器 ce ▾` / `虚拟环境 ce` 都是纯文字，避免和官方工具栏视觉打架。

---

## 10. uvroot 命令行细节（写 runner 时踩到的）

1. **uvroot 不接受 `--` 分隔符**（那是 bwrap 的约定）：`uvroot error: unknown option '--'`。
   → runner 在 uvroot 分支里直接拼命令，bwrap 回退分支才用 `--`。
2. **只读判定要看 profile**：官方 `bwrapProfileArgs` 在 `workspace-write` 时会插入
   `--bind <root> <root>`，只读时没有。runner 就据此决定是否追加 `--ro=<工作区>`。
3. **块设备根（img/qcow2/NBD/iSCSI）强制要 `--vperm`**，否则 uvroot 直接报错。
4. **深层路径绑定是可行的**：`-b /a/b/c:/a/b/c` 后容器内 `pwd` 就是 `/a/b/c`，
   这样容器内路径与 DSH 文件工具看到的完全一致。

---

## 11. 常用诊断片段

```bash
# 生成的 uvroot 参数（每个容器一份）
cat ~/.dsh/uvroot/specs/<容器ID>.sh

# 容器副本占了多少
du -sh ~/.dsh/uvroot/instances/*

# 种子是否被写坏（大小/mtime 应保持不变）
stat -c '%s %y' ~/.dsh/uvroot/images/*.qcow2

# 手工起一次容器（排查 uvroot 自身问题）
LD_LIBRARY_PATH=/path/to/lib64 uvroot \
  --netfs=/:qcow2://$HOME/.dsh/uvroot/images/xxx.qcow2 --vperm --link2symlink -i 0:0 \
  /bin/sh -c 'uname -a; ls /'

# 当前会话在哪个模式（bash 里）
echo "$DSH_UVROOT_SPEC"      # 空 = 没在容器里
```

**客户端组件崩溃无法从界面判断时**，可以把它单独跑起来（用 dsh checkout 里的真 React）：

```js
// 1. 给 window 打桩，import client.js，拿到注册的 factory
// 2. factory(require) → { apply }；fake ctx 收集 slots.register 的组件
// 3. react-dom/server 的 renderToStaticMarkup 渲染组件，异常会直接抛出来
```

这条路径在本项目里定位过两次渲染期崩溃（`draft=null`、缺 `useProjection` 桩）。

---

## 12. 挂载相关

### 12.1 加了网络挂载后命令报错

先看 uvroot 原始报错，再看驱动：

| 报错 | 原因 |
|---|---|
| `netfs: no backend for "..."` | URI 没有 scheme（例如 `--netfs=/mnt/x:/abs/path`）。镜像要写 `img:///abs/...` |
| `netfs: no user-space filesystem driver could read ...` | 块后端缺 `libext2fs`（见 [§5](#5-镜像容器报-no-user-space-filesystem-driver-could-read)） |
| `netfs: the virtual permission layer is required for ...` | 块后端缺 `--vperm`（插件会自动补，手写 spec 时要自己加） |
| `netfs: cannot reach ...` | 远端不可达 / 认证失败 / 缺 libnbd、libiscsi、libnfs、libcurl |

### 12.2 网络挂载的容器路径必须填

uvroot 的语法是 `--netfs=<guest>:<uri>`，解析靠**第一个冒号**分隔。如果 guest 省了：

```
--netfs=ftp://host/pub      ✗ 会被切成 guest="ftp", uri="//host/pub"
```

所以插件的表单对网络类挂载强制要求填容器挂载点。

### 12.3 相对 / 深层容器路径

`-b host:guest` 的 guest 不存在时 uvroot 会尝试创建中间目录；如果失败，命令会以
`can't chdir(...)` 之类的 warning 出现。容器内工作目录始终绑定在**工作区原路径**上，
所以 `pwd` 与 DSH 文件工具一致，不要把工作区再映射到别的位置。
