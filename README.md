# dsh-uvroot-env

> 给 DeepSeek Harness 的**按工作目录隔离的系统环境**：每个工作目录 / 会话跑在 uvroot
> 用户态容器里，**不需要宿主 root，不写宿主系统目录，不需要 Docker 或 namespace 权限**。

`uvroot` 是一个从 PRoot fork 出来的用户态虚拟根（`ptrace` + `seccomp` 拦截 syscall），
所以它能在普通用户身份下提供"另一个根文件系统"：镜像、目录、甚至网络磁盘都可以当根，
容器里 `pwd`、文件权限、用户身份、`/proc`、网络设备都由 uvroot 虚拟出来。

---

## 目录

- [1. 它能做什么](#1-它能做什么)
- [2. 安装](#2-安装)
- [3. 快速开始](#3-快速开始)
- [4. 核心概念](#4-核心概念)
- [5. 界面说明](#5-界面说明)
- [6. 容器配置项](#6-容器配置项)
- [7. 安全模型](#7-安全模型)
- [8. 运行原理](#8-运行原理)
- [9. 数据文件与 HTTP API](#9-数据文件与-http-api)
- [10. 常见问题](#10-常见问题)
- [11. 已知限制](#11-已知限制)
- [12. 文件清单与卸载](#12-文件清单与卸载)

---

## 1. 它能做什么

| 能力 | 说明 |
|---|---|
| 添加工作目录时选择环境 | `官方默认（正常模式）` 或 `虚拟用户态环境（uvroot）`；只有选了后者才出现容器相关选项 |
| 同一目录多个容器 | 新建 / 编辑 / 删除 / 设为默认；该目录下的**所有会话共用**这些容器 |
| 三种容器根 | 目录 rootfs、磁盘镜像（`img` / `qcow2`）、网络磁盘（nbd / iSCSI / NFS / FTP / SMB） |
| 挂载与网络 | 宿主→容器映射（可标只读）、用户态虚拟网络（WireGuard / NAT，无需 root） |
| 种子与副本隔离 | 库里的镜像/rootfs 只作种子，创建容器时复制一份专属副本，容器改动**永不污染种子** |
| 导入与导出 | 导入 rootfs tar、登记已有目录、登记镜像；导出：目录容器 → `tar.gz`，镜像容器 → 镜像文件，带下载链接 |
| 会话内无缝切换容器 | 输入框左侧的「容器」选择器，按会话记忆选择 |
| 不绕过容器 | 严格隔离守卫拦截 PTC / MCP / 工作目录外的文件工具 |
| 普通工作区零影响 | 不覆盖任何全局策略；非虚拟环境工作区不渲染任何插件 UI |

---

## 2. 安装

### 2.1 前置条件

| 依赖 | 用途 | 检查 |
|---|---|---|
| `uvroot` 可执行文件 | 容器运行时 | `uvroot --version` |
| `bwrap`（bubblewrap） | 普通（非虚拟）工作区的官方沙箱 | `bwrap --version` |
| `libext2fs.so.2` | 只有**镜像 / 网络磁盘**容器需要（uvroot 用 `dlopen` 加载） | 见下 |
| 容器 rootfs 里最好有 `bash` | DSH 命令是 `bash -c`；没有时插件会自动降级为 `sh` | — |

`uvroot` 编译时若带上了 e2fsprogs 头文件（`HAVE_LIBEXT2FS`），镜像支持才可用：

```bash
export PKG_CONFIG_PATH="$WORK/netfs-deps/sysroot/usr/lib64/pkgconfig:$WORK/netfs-deps/sysroot/usr/share/pkgconfig"
export PKG_CONFIG_SYSROOT_DIR="$WORK/netfs-deps/sysroot"
make -C src uvroot
```

运行期 uvroot 用 `dlopen("libext2fs.so.2")` 找这个库，所以要在插件的
**设置 → 虚拟环境 → 驱动库目录**里填上存放它的目录（例如 `/path/to/netfs-deps/sysroot/usr/lib64`），
runner 会据此导出 `LD_LIBRARY_PATH`。

### 2.2 安装插件

插件以 bundle 形式安装到 DSH profile（这里是 `web`）：

```text
plugin_manager install_bundle  target=<abs-path-to>/dsh-uvroot-env
```

安装会：把 `@local/dsh-uvroot-env` 链接进 profile、把 bundle 追加到 `dsh.profile.bundles`、
应用它的 `cordis.patch.yml`（只覆盖 `sandbox.runnerCommand` + 插入插件行）。

**安装/更新宿主代码后需要重启 dsh**（见 [§10.1](#101-改了代码没生效)）：

```bash
# 在你启动 dsh 的终端 Ctrl+C，然后
cd <dsh-checkout>
node apps/cli/lib/bin.js web --host 127.0.0.1 --port 3080 --no-open
```

客户端 `client.js` 支持热重载，改完刷新页面即可，不必重启。

---

## 3. 快速开始

**① 准备一个容器根**

设置 → **虚拟环境**：

- `从 tar / tar.gz 导入 rootfs` → 解包到 `$DSH_HOME/uvroot/rootfs/<name>/`；
- `添加目录` → 登记一个已存在的 rootfs 目录；
- `添加镜像` → 登记 `.img` / `.qcow2`。

同时确认 **uvroot 可执行文件**与**驱动库目录**（镜像容器必需）。

**② 新建一个虚拟环境工作区**

侧边栏 `+` → 选择目录 → 运行环境选「虚拟用户态环境（uvroot）」→ `+ 新建容器`：

```text
名称：alpine-dev
类型：镜像（img / qcow2）
镜像源文件：从镜像库选择 alpine-cn 16G (qcow2)
☑ 创建时复制一份到容器专属目录（推荐）
→ 创建容器 → 添加
```

添加后，该工作目录在侧边栏里的标题会变成 `⟨📁⟩ <名称>`。

**③ 在新会话里验证**

输入框左侧出现 **`容器 alpine-dev ▾`**，执行：

```bash
cat /etc/alpine-release      # 容器里的发行版
df -h /                      # 容器根的大小（镜像容器是虚拟盘容量）
id                           # 容器内身份
pwd                          # 仍是宿主原路径，文件与 read/write/edit 工具互通
apk add git                  # 装包只落在容器副本里
```

**④ 导出**

`容器 ▾ → 管理容器… → 导出镜像 / 导出 rootfs`，面板会给路径、大小和「下载」按钮。

---

## 4. 核心概念

### 4.1 种子（seed）与实例（instance）

镜像库 / rootfs 库里的条目只当**种子**用。创建容器时插件会把种子复制成容器专属副本：

```
~/.dsh/uvroot/
├── images/alpine-cn-16g.qcow2        ← 种子，永远只读使用
└── instances/uvc-5736b851/
    └── disk.qcow2                    ← 这个容器的副本，所有写入都在这里
```

| 容器类型 | 复制方式 | 副本位置 |
|---|---|---|
| 目录 | `cp -a`（保留符号链接） | `instances/<id>/rootfs/` |
| 镜像 | `cp --sparse=always`（稀疏，16G 虚拟盘只占几十 MB） | `instances/<id>/disk.<img\|qcow2>` |
| 网络磁盘 | 不复制（数据在远端） | — |

- 删除容器时副本目录一并清理；导出的也是副本；
- 同一个容器重复保存不会重新复制（种子路径与复制开关都没变时沿用已有副本）；
- 想刻意共享种子，取消勾选「创建时复制一份…」——会显示污染警告。

### 4.2 工作区 · 会话 · 容器

```
工作目录（工作区）  /home/user/project
├── 容器 ce        ← 全目录共用
├── 容器 alpine-dev
└── 会话 A → 选 ce        会话 B → 选 alpine-dev      会话 C → 未选（默认用 ce）
```

- 容器按**工作目录**登记，因此该目录下所有会话都能复用；
- 会话只记录"当前选中哪一个"（按会话记忆）；
- 「退出虚拟环境（正常模式）」把整个目录切回官方默认。

---

## 5. 界面说明

| 位置 | 内容 |
|---|---|
| 添加工作目录对话框 | 路径 + 原生目录选择器 + 运行环境单选；选虚拟环境后才展开容器区（已有容器列表带删除、新建容器表单） |
| 工作区行（侧边栏） | 标题前缀 `⟨📁⟩ ` 表示该目录是虚拟环境（切回正常模式自动去掉） |
| 会话标题栏 | `虚拟环境 <容器名>`，点击打开容器管理器 |
| 输入框工具行 | `容器 <容器名> ▾` 选择器：退出虚拟环境 / 切换容器 / 打开管理器（纯文字，不放图标） |
| 输入框权限控件 | **只有官方那一个**，插件不提供第二处权限入口 |
| 设置 → 虚拟环境 | uvroot 路径、驱动库目录、rootfs 库、镜像库、严格隔离开关、打开容器管理器 |
| 容器管理器（浮层） | 新建/编辑/删除/设默认/导出；每步失败都会给出具体原因 |

---

## 6. 容器配置项

| 字段 | 说明 | 对应 uvroot 参数 |
|---|---|---|
| `name` | 容器名 | — |
| `source` | **种子**路径（库条目或手填） | — |
| `linked` | `true` 时不复制，直接使用种子（有污染风险） | — |
| `type` | `directory` / `image` / `network` | — |
| `imageFormat` | `img` / `qcow2` | — |
| `mounts[]` | 四类挂载，见下 | `-b host:guest` / `--netfs=guest:uri`、`--ro=<guest>` |
| `net.enabled` | 用户态虚拟网络 | `--net` |
| `net.bridge` | 桥接实现 | `--net-bridge=userspace\|nat\|none\|kernel` |
| `net.ifaces[]` | 虚拟接口 | `--net-if=...` |
| `net.routes[]` | 虚拟路由 | `--net-route=...` |
| `net.wg` | WireGuard 配置 | `--wg=...` |
| `options.link2symlink` | 硬链接转符号链接（无 root 环境常用） | `--link2symlink` |
| `options.fakeRoot` | 容器内显示为 root | `-i 0:0` |
| `options.vperm` / `vpermId` | 持久虚拟权限 / 身份 | `--vperm`、`--vperm-id` |
| `options.vpid` | 虚拟 PID 起点 | `--vpid` |
| `options.shell` | 容器内 shell（留空自动：有 bash 用 bash，否则 sh） | — |
| `env[]` | `KEY=VALUE` 行，非交互命令也生效 | runner 在宿主 source 后由 guest 继承 |
| `extraArgs[]` | 追加任意 uvroot 参数 | 原样透传 |

### 挂载映射的四类

容器表单里「+ 宿主路径 / + 网络文件 / + 镜像 / + 网络磁盘」对应 uvroot 的两种挂载方式：

| 类型 | 填什么 | 生成的 uvroot 参数 | 说明 |
|---|---|---|---|
| **宿主路径** | 宿主路径 + 容器路径（留空＝同路径） | `-b host:guest`，只读再加 `--ro=guest` | 把宿主目录/文件映射进容器；这是唯一能双向共享宿主文件的方式 |
| **镜像** | URI（可从镜像库一键填入）+ 容器挂载点 | `--netfs=guest:img:///abs/disk.img`<br>`--netfs=guest:qcow2:///abs/disk.qcow2` | 把磁盘镜像当目录树挂载；**块设备后端，uvroot 强制要求 `--vperm`**（插件会自动补） |
| **网络文件** | URI + 容器挂载点 | `--netfs=guest:ftp://user:pass@host/pub`<br>`--netfs=guest:sftp://…`<br>`--netfs=guest:smb://server/share`<br>`--netfs=guest:nfs://server/export` | 远端共享目录，按需拉取到私有缓存再绑定进容器；不需要 `/dev/fuse` 或内核模块，Android 上也能用 |
| **网络磁盘** | URI + 容器挂载点 | `--netfs=guest:nbd://127.0.0.1:10809/export`<br>`--netfs=guest:iscsi://user:pass@host/iqn/lun` | 远端块设备（NBD / iSCSI），同样强制 `--vperm` |

要点：

- 后端由 **URI 的 scheme** 决定，插件只是把它拼成 `--netfs=<guest>:<uri>`；
- **网络挂载必须填容器挂载点**（容器路径不能留空）——uvroot 的语法是 `guest:uri`，
  省略 guest 会被 scheme 里的冒号切错；
- 只读映射追加 `--ro=<guest>`，写入返回 `Read-only file system`；
- 镜像 / 网络磁盘这类块后端会自动补 `--vperm`（虚拟权限层），否则 uvroot 直接拒绝；
- 保存时会丢弃没填完的行；
- 挂载失败是 uvroot 自己的报错（缺驱动、远端不可达、认证失败），会原样回显在命令输出里。
  网络磁盘需要 libnbd / libiscsi，镜像需要 libext2fs，见[§2.1](#21-前置条件)。

`type` 决定的根参数：

- `directory` → `-r <副本目录>`
- `image` → `--netfs=/:<img|qcow2>://<副本文件>` + `--vperm`（块设备根强制虚拟权限）
- `network` → `--netfs=/:<uri>` + `--vperm`

**工作区读写**由权限控件决定：`工作区可写` → 工作区可写绑定；`工作区只读` → 追加
`--ro=<工作区>`（写入返回 `Read-only file system`）。工作区始终以**宿主原路径**绑定进容器，
所以容器内 `pwd` 与 DSH 文件工具看到的路径一致。

**环境变量注入**：DSH 的命令是非交互 `bash -c`，不会读 `/etc/profile.d`。runner 因此在宿主上按顺序
source 这些文件，再由 guest 进程继承：

1. 容器专属：`$DSH_HOME/uvroot/env/<容器ID>.sh`（编辑容器时的「容器环境变量」写在这里）
2. 全局共享：`$DSH_HOME/uvroot/env.sh`

---

## 7. 安全模型

### 7.1 默认姿态

- **不需要 root**：整套流程以普通用户身份运行；
- **不写宿主系统目录**：容器根是独立目录/镜像，宿主文件只有你显式映射的路径可见；
- **普通工作区不变**：不覆盖全局权限预设、默认沙箱模式、审批策略；没有容器的会话由 runner
  原样回放官方 bubblewrap 参数。

### 7.2 严格隔离（默认开启）

虚拟环境的意义是"命令在容器里、碰不到宿主"。DSH 里还有别的工具能绕过容器，所以插件注册了一个
全局 tool guard，**只在当前会话的工作目录是虚拟环境时**生效：

| 工具 | 处理 | 原因 |
|---|---|---|
| `bash` / `bash_persistent` | 走 uvroot runner（容器内） | 正路 |
| `terminal_*`（持久终端） | 已被容器覆盖 | 官方终端后端本身就读 `ctx.sandbox` 策略，走同一个 runner |
| `run_code`（PTC） | **拒绝** | 在宿主 Node 进程里执行代码 = 绕过容器 |
| `mcp__*` | **拒绝** | MCP server 是宿主进程 |
| `read` / `write` / `edit` / `glob` / `grep` / `read_image` | 只允许**工作目录内**路径（符号链接按 realpath 判定） | 写入本来被官方 fs-sandbox 限制在工作区，读取没有；这里把读取也收进来 |
| 子代理 / workflow / 子会话 | 不单独拦截 | 它们的每次工具调用仍被同一条守卫按各自会话判定 |

关闭方式：**设置 → 虚拟环境 → 严格隔离**（调试用）。

### 7.3 权限模式约束

容器只在 `工作区只读` / `工作区可写` 两种受限模式下生效。若会话仍是 `danger-full-access`：

- 切换到容器时插件会自动把会话切到 `工作区可写`（已经是 `工作区只读` 的不会被放宽）；
- 若仍处于 `danger-full-access`，`bash` 会被守卫**拒绝**并提示切换权限——
  避免"以为在容器里、其实跑在宿主上"。

---

## 8. 运行原理

```
DSH bash 工具
  → ctx.shellEnv        注入 DSH_UVROOT_SPEC / _CONTAINER / _WORKSPACE（按会话解析）
  → bash-sandbox        ctx.sandbox.confine(['bash','-c',cmd], policy)
  → sandbox-local       被 cordis.patch.yml 的 runnerCommand 指向 ↓
  → $DSH_HOME/uvroot/bin/runner.sh
        ├── 有容器：exec uvroot <生成的参数> --kill-on-exit -w <工作区> <命令>
        └── 无容器：exec bwrap <原 profile 参数> -- <命令>      ← 官方行为不变
```

`runner.sh` 每次执行时做的事：

1. 把参数的 `--` 前后拆成「bwrap profile 参数」和「真实命令」；
2. 从 profile 里是否出现 `--bind` 判定只读 / 可写；
3. source 容器环境变量文件；
4. 把工作区按宿主原路径 `-b` 进容器，只读模式追加 `--ro=`；
5. 如果命令是 `bash` 而容器里没有 bash，自动换成 `sh`（先看 `-r` 指向的目录，再看显式配置）；
6. `LD_LIBRARY_PATH` 加入「驱动库目录」，让 uvroot 能 `dlopen` 到 `libext2fs`；
7. `exec` uvroot（或回退 bwrap）。

客户端所有 UI 走 DSH 的 slot 机制；宿主数据通过 `connection/request` 上注册的
`/api/uvroot/*` JSON API 读写（该瀑布在连接鉴权**之后**运行，因此接口已鉴权、同源）。

---

## 9. 数据文件与 HTTP API

### 9.1 数据目录

```
$DSH_HOME/uvroot/
├── state.json                 全部登记（设置 / 库 / 工作区容器 / 会话选择）
├── bin/runner.sh              由 lib/runner.sh 复制而来
├── specs/<容器ID>.sh          每个容器生成的 uvroot 参数（shell 数组）
├── env/<容器ID>.sh            容器专属环境变量
├── env.sh                     全局容器环境变量（所有容器共享）
├── rootfs/<名称>/             导入的 rootfs
├── images/                    登记的镜像
├── instances/<容器ID>/        容器专属副本（种子复制而来）
└── exports/                   导出的 tar.gz / 镜像（只有这里可下载）
```

`state.json` 结构：

```jsonc
{
  "version": 1,
  "settings": { "uvrootBin": "...", "libDir": "...", "strictIsolation": true },
  "library": { "rootfs": [ /* {id,name,path,kind,...} */ ], "images": [ /* {...,format,size} */ ] },
  "workspaces": {
    "/abs/path": {
      "mode": "virtual",              // 或 "normal"
      "containers": [ /* 容器定义 */ ],
      "defaultContainerId": "uvc-xxxxxxxx",
      "sessions": { "session-id": "uvc-xxxxxxxx" }
    }
  }
}
```

### 9.2 HTTP API

全部挂载在 `/api/uvroot/` 下，同源 + 已鉴权（浏览器 cookie），返回 `{ok:true,value}` 或
`{ok:false,error}`。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/state?workspace=<path>` | 全量状态 / 单个工作区 |
| GET | `/browse?path=&extensions=` | 列目录（`extensions` 时只列匹配的文件） |
| GET | `/download?path=` | 只允许下载 `exports/` 下的文件 |
| POST | `/settings` | `uvrootBin` / `libDir` / `strictIsolation` |
| POST | `/workspace` | `{ path, mode }` |
| POST | `/session` | `{ path, sessionId, containerId }` |
| POST | `/container/create` | `{ path, container }` |
| POST | `/container/update` | `{ path, id, patch }` |
| POST | `/container/delete` | `{ path, id }` |
| POST | `/container/default` | `{ path, id }` |
| POST | `/container/export` | `{ path, id }` → `{kind,format,name,path,size,download}` |
| POST | `/library/rootfs` \| `/library/import` \| `/library/image` \| `/library/remove` | 库管理 |

---

## 10. 常见问题

更多症状 → 原因 → 处理见 **[docs/troubleshooting.md](docs/troubleshooting.md)**。

### 10.1 改了代码没生效

| 改动 | 生效方式 |
|---|---|
| `client.js` | 热重载，刷新页面即可 |
| `cordis.patch.yml` | 需要一次 bundle 重整（`plugin_manager set_bundle`） |
| `index.js` / `lib/*.js` | **需要重启 dsh**（DSH 缓存宿主 ESM 模块，切换插件不会重新 import） |

### 10.2 镜像容器报 `no user-space filesystem driver could read`

uvroot 编译时没启用 `libext2fs`，或运行时 `dlopen` 找不到 `libext2fs.so.2`。见 [§2.1](#21-前置条件)：
重编 uvroot（`HAVE_LIBEXT2FS`）并在设置里填「驱动库目录」。

### 10.3 容器里 `bash: not found`

容器 rootfs 里没有 bash。插件会自动降级成 `sh`（在容器表单的「容器内 shell」也能显式指定），
但依赖 bash 特有语法的命令会失败——建议镜像内装 bash。

### 10.4 装包时刷 `No space left on device` 但其实有空间

uvroot ext2 写入驱动的误报（`ext2fs_block_alloc_stats: Illegal block number` 同源）。实测
`apk add` 退出码 0、文件齐全、命令可用，可忽略；必要时容器内 `apk fix <包>`。

---

## 11. 已知限制

1. **工作区文件夹标识走的是标题**：DSH 的 `sidebar.workspaces` 是单占位槽，工作区行没有扩展槽，
   官方客户端包也没有导出 `WorkspaceBrowser` 组件，所以插件无法在行内插入图标。当前用官方
   `setTitle` 把标题改成 `⟨📁⟩ <名称>`（虚拟环境时加、切回正常模式时去掉）。副作用是**标题真的被改写**，
   会话标题等位置也会带上这个前缀。若上游给 `ui-workspace` 加一个工作区行槽位，就能改成真正的行内图标。
2. **添加工作目录的对话框由插件接管**（为了提供环境选择），普通模式下它是「路径 + 原生目录选择器 +
   环境单选」，不含官方内置的目录浏览器。
3. **镜像 / 网络磁盘容器**依赖 uvroot 的用户态驱动（libext2fs / libnbd / libiscsi / libnfs）；
   缺哪个就报哪个的原始错误。
4. 容器只在两种受限文件策略下生效；`danger-full-access` 会被守卫拒绝（见 [§7.3](#73-权限模式约束)）。
5. 虚拟网络是**用户态**实现（`--net`）：容器内 `ip addr` / `getifaddrs` 看到的是虚拟设备，
   但 `cat /proc/version` 之类仍是宿主内核信息。
6. 宿主 JS 改动需要重启 dsh（见 [§10.1](#101-改了代码没生效)）。

---

## 12. 文件清单与卸载

```
dsh-uvroot-env/
├── package.json          bundle 清单（dsh.bundle.patch + dsh.client）
├── cordis.patch.yml      只覆盖 sandbox.runnerCommand + 插入插件行
├── index.js              宿主插件：shellEnv 贡献器、/api/uvroot 路由、标题同步、工具守卫
├── client.js             客户端 UI：切换器、目录流、设置页、容器管理器
├── lib/store.js          登记、种子复制、spec 生成、库管理、导入导出
├── lib/api.js            /api/uvroot/* JSON API
├── lib/runner.sh         sandbox 执行包装器（uvroot / bwrap 回退 + 环境注入）
├── locale/{zh,en}.json   插件显示名与描述
├── icon.svg              插件列表图标（尖括号 + 文件夹）
├── icon-preview.html     图标在明/暗主题下的预览
├── docs/troubleshooting.md
└── README.md
```

卸载：

```text
plugin_manager remove_bundle  target=@local/dsh-uvroot-env
```

然后（可选）删除数据目录 `$DSH_HOME/uvroot/`。注意：删掉它会一并丢掉容器副本与导出，
但**种子镜像/rootfs 若在别处则不受影响**。

---

## 13. 许可

GPL-2.0-only（见 [LICENSE](LICENSE)）。

插件本身驱动 [uvroot](https://github.com/TL8080/uvroot)（PRoot 的 fork，同样是 GPLv2）。
本仓库只包含 DSH 插件代码，不包含 uvroot 源码，也不包含任何 rootfs / 镜像。
