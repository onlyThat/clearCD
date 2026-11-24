'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

const wu = require('./winutil');
const scanners = require('./scanners');

// 单实例：提权重启时用 --elevated 标记避免误判
const isDev = process.argv.includes('--dev');

/* ------------------------------------------------------------------ */
/* 便携模式                                                            */
/* ------------------------------------------------------------------ */

/**
 * 免安装版 / 绿色版把数据写在 exe 同目录，拷走程序目录即可带走配置与缓存。
 * 安装版保持系统默认 userData，避免在程序目录里混入运行时文件。
 */
function resolvePortableDataDir() {
  if (!app.isPackaged) return null;
  // 单文件免安装版运行时 execPath 是临时解压目录，
  // 真实 exe 位置由 electron-builder 通过 PORTABLE_EXECUTABLE_DIR 给出
  const portableRoot = process.env.PORTABLE_EXECUTABLE_DIR;
  const exeDir = portableRoot || path.dirname(process.execPath);
  // 安装版会在程序目录放卸载程序；检测到它就回退到系统默认 userData
  if (!portableRoot) {
    try {
      if (fs.readdirSync(exeDir).some((n) => /^Uninstall .*\.exe$/i.test(n))) return null;
    } catch {
      return null;
    }
  }
  return path.join(exeDir, 'onlyThatLove-data');
}

// userData 必须在 app ready 之前设置，否则 Chromium 已经初始化完路径
const portableDataDir = resolvePortableDataDir();
if (portableDataDir) {
  try {
    fs.mkdirSync(portableDataDir, { recursive: true });
    app.setPath('userData', portableDataDir);
  } catch {
    /* 目录不可写（只读介质等）→ 用系统默认 userData，保证能启动 */
  }
}

let mainWindow = null;
let scanSignal = { stopped: false };

/* ------------------------------------------------------------------ */
/* 窗口                                                                */
/* ------------------------------------------------------------------ */

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 1100,
    minHeight: 680,
    show: false,
    backgroundColor: '#0b1220',
    title: 'onlyThatLove · 磁盘清理助手',
    autoHideMenuBar: true,
    frame: false, // 使用渲染层的自绘标题栏
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  Menu.setApplicationMenu(null);

  // 最大化状态变化时通知渲染层切换图标
  const sendMaxState = () =>
    mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents.send('win:maxstate', mainWindow.isMaximized());
  mainWindow.on('maximize', sendMaxState);
  mainWindow.on('unmaximize', sendMaxState);
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    if (isDev) mainWindow.webContents.openDevTools({ mode: 'detach' });
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // 拦截外链，用系统浏览器打开
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

/* ------------------------------------------------------------------ */
/* 提权                                                                */
/* ------------------------------------------------------------------ */

/**
 * 以管理员身份重新启动自身。
 * 使用 Electron 的 app.relaunch + runAsAdmin 不足以保证 UAC 提示，
 * 因此直接调用 PowerShell 的 Start-Process -Verb RunAs。
 */
function relaunchElevated() {
  const exe = process.execPath;
  const args = app.isPackaged ? [] : [path.resolve(__dirname, '..', '..')];
  const argLine = args.map((a) => `"${a}"`).join(' ');
  const ps =
    `Start-Process -FilePath '${exe.replace(/'/g, "''")}' ` +
    (argLine ? `-ArgumentList '${argLine}' ` : '') +
    `-Verb RunAs`;

  const child = spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', ps],
    { detached: true, stdio: 'ignore', windowsHide: true }
  );
  child.unref();

  // 稍等让 UAC 弹出，然后退出当前实例
  setTimeout(() => app.quit(), 900);
  return { ok: true };
}

/* ------------------------------------------------------------------ */
/* IPC                                                                 */
/* ------------------------------------------------------------------ */

/** 从 package.json 读版本，未打包时 app.getVersion() 可能拿到 electron 自身的版本 */
function appVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'));
    if (pkg.version) return pkg.version;
  } catch {
    /* 回退到 app.getVersion() */
  }
  return app.getVersion();
}

ipcMain.handle('env:info', async () => {
  const [drives] = await Promise.all([wu.getDrives()]);
  return {
    isAdmin: wu.isAdmin(),
    drives,
    version: appVersion(),
    platform: process.platform,
    node: process.versions.node,
    electron: process.versions.electron,
    hostname: os.hostname(),
    username: os.userInfo().username,
  };
});

ipcMain.handle('drives:get', () => wu.getDrives());

ipcMain.handle('admin:elevate', () => relaunchElevated());

ipcMain.handle('win:minimize', () => mainWindow && mainWindow.minimize());
ipcMain.handle('win:maximize', () => {
  if (!mainWindow) return;
  mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
});
ipcMain.handle('win:close', () => mainWindow && mainWindow.close());

ipcMain.handle('scan:start', async (event, opts = {}) => {
  scanSignal = { stopped: false };
  const sender = event.sender;
  // 扫描范围完全由渲染层的磁盘选区决定，主进程不再兜底成某个固定盘
  const drives = Array.isArray(opts.drives) ? opts.drives : [];

  const results = await scanners.scanAll({
    drives,
    signal: scanSignal,
    onProgress: (p) => {
      if (!sender.isDestroyed()) sender.send('scan:progress', p);
    },
    onItem: (item) => {
      if (!sender.isDestroyed()) sender.send('scan:item', item);
    },
  });

  const stats = summarize(results);
  // 未勾选系统盘时，用户缓存 / 系统缓存这类固定路径项不在统计范围内，
  // 需要把原因回传给界面，否则用户只会看到列表变短、以为扫描出错。
  const systemDrive = scanners.getSystemDriveLetter();
  const includesSystem = drives.some((d) => String(d).toUpperCase() === systemDrive);
  // 只通过 invoke 的返回值交付结果；再推一条 scan:done 会让渲染层重复处理
  return { items: results, stats, drives, systemDrive, fixedItemsSkipped: !includesSystem };
});

ipcMain.handle('scan:stop', () => {
  scanSignal.stopped = true;
  return true;
});

ipcMain.handle('clean:run', async (event, ids = [], opts = {}) => {
  const sender = event.sender;
  const drives = Array.isArray(opts.drives) ? opts.drives : [];
  const results = await scanners.cleanItems(ids, {
    // 按盘探测出的目录一律移入回收站，不做永久删除：
    // 这些路径不像系统缓存那样有明确的重建方式，一旦误删无法挽回
    trash: (p) => shell.trashItem(p),
    onProgress: (p) => {
      if (!sender.isDestroyed()) sender.send('clean:progress', p);
    },
  });

  // 清理后重新统计受影响项的大小；沿用与扫描时相同的磁盘选区，
  // 否则刚清完 C 盘缓存却按 D 盘刷新，数字会对不上。
  const refreshed = {};
  for (const r of results) {
    const def = scanners.getItemById(r.id);
    if (!def) continue;
    try {
      refreshed[r.id] = await def.scan({ drives, selected: new Set(drives) });
    } catch {
      refreshed[r.id] = 0;
    }
  }

  return { results, refreshed };
});

ipcMain.handle('shell:openPath', async (event, p) => {
  if (!p) return { ok: false };
  // 回收站是一个虚拟位置，需要用 shell:RecycleBinFolder
  if (p === '回收站' || p === 'recycle-bin') {
    await shell.openPath('C:\\$Recycle.Bin');
    return { ok: true };
  }
  // 系统 protected 目录直接打开所在上级
  const target = fs.existsSync(p) ? p : path.dirname(p);
  const err = await shell.openPath(target);
  return { ok: !err, error: err };
});

ipcMain.handle('shell:showItem', (event, p) => {
  if (!p) return false;
  if (fs.existsSync(p)) {
    shell.showItemInFolder(p);
    return true;
  }
  const parent = path.dirname(p);
  if (fs.existsSync(parent)) {
    shell.openPath(parent);
    return true;
  }
  return false;
});

ipcMain.handle('files:findBig', async (event, { drives, threshold }) => {
  // 扫整盘而不是只挑 Users/ProgramData 这类固定子目录：
  // D 盘、外置盘根本没有 Users 目录，写死子目录会漏掉绝大多数文件。
  // 遍历时只按目录名跳过缓存类目录（见 SKIP_NAMES），系统目录不做路径裁剪，
  // 保证用户在任意盘的任意位置都能找到自己的大文件。
  const letters = Array.isArray(drives) && drives.length ? drives : drives ? [drives] : [];
  if (!letters.length) return [];

  const sender = event.sender;
  const lists = await Promise.all(
    letters.map((letter) => findBigFiles(letter + ':\\', threshold, sender))
  );

  const seen = new Set();
  return lists
    .flat()
    .filter((f) => (seen.has(f.path) ? false : seen.add(f.path)))
    .sort((a, b) => b.size - a.size)
    .slice(0, 500);
});

/* ------------------------------------------------------------------ */
/* 删除 / 移入回收站                                                   */
/* ------------------------------------------------------------------ */

/**
 * 把文件移入回收站（shell.trashItem，等同资源管理器删除，可从回收站还原）。
 * 界面承诺「可从回收站还原」，所以回收站不可用时只报错、绝不退化为永久删除，
 * 避免用户以为还能还原却已经丢失数据。
 */
ipcMain.handle('files:trash', async (event, paths = []) => {
  const out = [];
  if (!Array.isArray(paths)) return out;
  for (const p of paths) {
    if (typeof p !== 'string' || !p) continue;
    const r = { path: p, ok: false, error: null };
    try {
      const st = await fs.promises.stat(p);
      if (st.isDirectory()) {
        // 目录不允许在此删除，避免误操作整棵目录树
        r.error = '目录不能在此删除';
        out.push(r);
        continue;
      }
      r.size = st.size;
    } catch (e) {
      r.error = '文件不存在或无权访问';
      out.push(r);
      continue;
    }

    try {
      await shell.trashItem(p);
      r.ok = true;
    } catch (e) {
      // 回收站不可用（网络盘 / 策略禁用）时不做永久删除，交由用户处置
      r.error = '无法移入回收站（' + (e.code || e.message) + '）';
    }
    out.push(r);
  }
  return out;
});

ipcMain.handle('dialog:confirm', async (event, { title, message, detail, confirmText }) => {
  const r = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    buttons: [confirmText || '确认', '取消'],
    defaultId: 1,
    cancelId: 1,
    title: title || '确认',
    message: message || '',
    detail: detail || '',
    noLink: true,
  });
  return r.response === 0;
});

/* ------------------------------------------------------------------ */
/* 大文件扫描                                                          */
/* ------------------------------------------------------------------ */

// 按目录名跳过的项：这些目录没有用户意义，且体量巨大或访问受限
const SKIP_NAMES = new Set([
  '$Recycle.Bin',
  'System Volume Information',
  '$WinREAgent',
  'node_modules',
  '.git',
  'WinSxS',
  'servicing',
  'DriverStore',
  'assembly',
  'CSC',
  // 包管理缓存：内容全是可重新下载的包副本，文件数极多但没有值得展示的大文件。
  // 实测本机 Yarn 缓存 64 万文件、npm-cache 21 万文件，两者占了全盘扫描的八成耗时。
  // 只跳过这类缓存；JetBrains caches、浏览器 Cache 里存在真实大文件，不能跳。
  'npm-cache',
  '_cacache',
  '_npx',
  '.npm',
  'pip',
  'Yarn',
  'pnpm-cache',
  'pnpm-store',
  'uv',
  'node-gyp',
  '.gradle',
  '.m2',
  '.nuget',
  'Cargo',
  // IDE 扩展目录：每套扩展的图标包就有 1.7 万个小文件，且多个 IDE 各存一份。
  // 内容全是可重新安装的插件资源，不会有用户数据的大文件。
  '.vscode',
  '.vscode-insiders',
  '.trae-cn',
  '.trae',
  '.windsurf',
  '.cursor',
  'extensions',
]);

// stat 并发上限。Windows 的 Dirent 不提供文件大小，必须逐个 stat；
// 不设上限时峰值可达 10 万并发，libuv 队列雪崩，实测慢 10 倍以上。
const STAT_CONCURRENCY = 512;

// 全局共享的 stat 名额：多个 root 并行遍历时，总并发仍受这一份限制
let statActive = 0;
const statWaiters = [];
async function withStatSlot(fn) {
  while (statActive >= STAT_CONCURRENCY) {
    await new Promise((r) => statWaiters.push(r));
  }
  statActive++;
  try {
    return await fn();
  } finally {
    statActive--;
    const w = statWaiters.shift();
    if (w) w();
  }
}

// 全盘扫描时的最大递归深度。普通用户目录很少超过 15 层，
// 设上限是为了挡住 junction 形成的环（如 Documents 指向 OneDrive 再指回来）
const MAX_DEPTH = 24;

/**
 * 深度遍历磁盘，收集超过阈值的文件。
 *
 * 关键点：
 * - 并行处理目录（默认 32 路），单线程逐个 await readdir 在 30 万个目录上要几分钟
 * - 目录项类型由 readdir.withFileTypes 给出，只有文件才需要 stat 取大小
 * - stat 用全局信号量限流，否则十万级并发会把事件循环压垮
 * - 跳过 symlink/junction，并限制递归深度，避免全盘扫描时绕成环
 */
async function findBigFiles(root, threshold, sender, concurrency = 32) {
  const fsp = fs.promises;
  const found = [];
  // 队列元素带深度，用于拦住超深路径
  const queue = [{ dir: root, depth: 0 }];
  let activeDir = 0;
  let visited = 0;
  let lastFoundCount = 0;

  return new Promise((resolve) => {
    let finished = false;
    let dirsExhausted = false;
    let pendingStat = 0;

    const emit = () => {
      if (!sender || sender.isDestroyed()) return;
      sender.send('bigfile:progress', {
        scanned: visited,
        found: found.length,
        // 边扫边出结果，用户不必等整个磁盘遍历完
        items: found.slice().sort((a, b) => b.size - a.size).slice(0, 100),
      });
      lastFoundCount = found.length;
    };

    const done = () => {
      if (finished) return;
      // 目录遍历完、且所有 stat 都回来才算结束，否则会漏掉最后一批文件
      if (!dirsExhausted || activeDir !== 0 || pendingStat !== 0) return;
      finished = true;
      found.sort((a, b) => b.size - a.size);
      resolve(found.slice(0, 500));
    };

    const pump = () => {
      if (activeDir === 0 && queue.length === 0) {
        dirsExhausted = true;
        done();
        return;
      }
      while (activeDir < concurrency && queue.length) {
        const { dir, depth } = queue.pop();
        activeDir++;
        visited++;

        fsp
          .readdir(dir, { withFileTypes: true })
          .then((entries) => {
            for (const ent of entries) {
              if (ent.isDirectory()) {
                if (SKIP_NAMES.has(ent.name) || ent.isSymbolicLink()) continue;
                if (depth >= MAX_DEPTH) continue;
                queue.push({ dir: path.join(dir, ent.name), depth: depth + 1 });
              } else if (ent.isFile()) {
                const full = path.join(dir, ent.name);
                pendingStat++;
                withStatSlot(() => fsp.stat(full))
                  .then((st) => {
                    if (st.size >= threshold) {
                      found.push({ path: full, size: st.size, mtime: st.mtimeMs });
                      // 发现新的大文件就立刻推送，不必等遍历结束
                      if (found.length !== lastFoundCount) emit();
                    }
                  })
                  .catch(() => {})
                  .finally(() => {
                    pendingStat--;
                    done();
                  });
              }
            }
          })
          .catch(() => {
            /* 无权限目录 */
          })
          .finally(() => {
            activeDir--;
            // 定期汇报进度，便于界面显示已扫目录数
            if (visited % 1000 === 0) emit();
            pump();
          });
      }
    };

    pump();
  });
}

/* ------------------------------------------------------------------ */
/* 统计                                                                */
/* ------------------------------------------------------------------ */

function summarize(items) {
  const sum = (arr) => arr.reduce((a, b) => a + (b.size || 0), 0);
  // 项数按全部项目统计，与界面列表行数一致；
  // 已清空或需管理员（大小未知）的项同样计入，避免列表有 11 行而卡片只写 7 项
  return {
    total: sum(items),
    count: items.length,
    low: sum(items.filter((i) => i.risk === 'low')),
    lowCount: items.filter((i) => i.risk === 'low').length,
    mid: sum(items.filter((i) => i.risk === 'mid')),
    midCount: items.filter((i) => i.risk === 'mid').length,
    high: sum(items.filter((i) => i.risk === 'high')),
    highCount: items.filter((i) => i.risk === 'high').length,
  };
}