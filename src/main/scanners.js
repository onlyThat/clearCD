'use strict';

/**
 * 清理项定义与扫描实现。
 * 每一项返回结构化结果，UI 直接渲染。
 *
 * 顺序即截图中的列表示例顺序。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const wu = require('./winutil');

const { MB } = wu;

const LOCAL = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
const ROAMING = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

function exists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

/** 删除时最常被占用的浏览器目录（Cache 层可安全删） */
function chromeCacheDirs(userDataRoot) {
  const dirs = [];
  if (!exists(userDataRoot)) return dirs;
  let profiles = [];
  try {
    profiles = fs
      .readdirSync(userDataRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .filter((n) => n === 'Default' || /^Profile \d+$/.test(n) || n === 'Guest Profile');
  } catch {
    return dirs;
  }
  for (const p of profiles) {
    // Cache / Code Cache / GPUCache / ShaderCache 可安全删除，不伤登录态
    for (const sub of ['Cache', 'Code Cache', 'GPUCache', 'ShaderCache', 'GrShaderCache']) {
      const d = path.join(userDataRoot, p, sub);
      if (exists(d)) dirs.push(d);
    }
  }
  // 根级共享缓存
  for (const sub of ['ShaderCache', 'GrShaderCache', 'GraphiteDawnCache']) {
    const d = path.join(userDataRoot, sub);
    if (exists(d)) dirs.push(d);
  }
  return dirs;
}

/* ------------------------------------------------------------------ */
/* 清理项定义                                                          */
/* ------------------------------------------------------------------ */

/**
 * 每项：
 *  id         唯一键
 *  name       显示名
 *  size       字节
 *  risk       'low' | 'mid' | 'high'
 *  level      分组：'user' 用户级（无需管理员） | 'system' 系统级（需管理员）
 *  sizeText   可选，覆盖默认格式化
 */
const ITEMS = [
  /* ---------------- 用户级 ---------------- */
  {
    id: 'user-temp',
    name: '用户临时文件',
    risk: 'low',
    level: 'user',
    consequence:
      '程序运行时产生的临时文件。删除后不影响系统，个别正在安装的软件可能需要重新安装。',
    suggestion: '建议清理，收益通常较大。',
    location: path.join(LOCAL, 'Temp'),
    async scan() {
      const p = path.join(LOCAL, 'Temp');
      if (!exists(p)) return 0;
      return wu.dirSize(p).size;
    },
    async clean() {
      return wu.emptyDir(path.join(LOCAL, 'Temp'));
    },
  },
  {
    id: 'npm-cache',
    name: 'npm 缓存',
    risk: 'low',
    level: 'user',
    consequence:
      'npm 下载过的包副本。删除后下次安装依赖会重新从网络下载，磁盘不会损坏。',
    suggestion: '建议清理，收益通常较大。',
    location: path.join(ROAMING, 'npm-cache'),
    async scan() {
      // npm 缓存目录可能被自定义，优先读 .npmrc
      const custom = readNpmCacheDir();
      const p = custom || path.join(ROAMING, 'npm-cache');
      if (!exists(p)) return 0;
      return wu.dirSize(p).size;
    },
    async clean() {
      const custom = readNpmCacheDir();
      const p = custom || path.join(ROAMING, 'npm-cache');
      return wu.emptyDir(p);
    },
  },
  {
    id: 'chrome-cache',
    name: 'Chrome 缓存',
    risk: 'mid',
    level: 'user',
    consequence:
      '浏览器网页缓存与图片副本。删除后首次打开网页会略慢，登录状态和书签不受影响。',
    suggestion: '可以删。清除前请关闭 Chrome，否则部分文件会被占用。',
    location: path.join(LOCAL, 'Google', 'Chrome', 'User Data'),
    async scan() {
      const root = path.join(LOCAL, 'Google', 'Chrome', 'User Data');
      let total = 0;
      for (const d of chromeCacheDirs(root)) total += wu.dirSize(d).size;
      return total;
    },
    async clean() {
      const root = path.join(LOCAL, 'Google', 'Chrome', 'User Data');
      let freed = 0;
      for (const d of chromeCacheDirs(root)) freed += wu.emptyDir(d).freed;
      return { freed };
    },
  },
  {
    id: 'edge-cache',
    name: 'Edge 缓存',
    risk: 'mid',
    level: 'user',
    consequence:
      '浏览器网页缓存与图片副本。删除后首次打开网页会略慢，登录状态和收藏夹不受影响。',
    suggestion: '可以删。清除前请关闭 Edge，否则部分文件会被占用。',
    location: path.join(LOCAL, 'Microsoft', 'Edge', 'User Data'),
    async scan() {
      const root = path.join(LOCAL, 'Microsoft', 'Edge', 'User Data');
      let total = 0;
      for (const d of chromeCacheDirs(root)) total += wu.dirSize(d).size;
      return total;
    },
    async clean() {
      const root = path.join(LOCAL, 'Microsoft', 'Edge', 'User Data');
      let freed = 0;
      for (const d of chromeCacheDirs(root)) freed += wu.emptyDir(d).freed;
      return { freed };
    },
  },
  {
    id: 'crash-dumps',
    name: '崩溃转储',
    risk: 'low',
    level: 'user',
    consequence:
      '程序崩溃时保存的内存快照。删除后不影响修复问题，仅少了一份事后排查依据。',
    suggestion: '建议清理。',
    location: path.join(LOCAL, 'CrashDumps'),
    async scan() {
      let total = 0;
      for (const p of [path.join(LOCAL, 'CrashDumps'), 'C:\\Windows\\Minidump']) {
        if (exists(p)) total += wu.dirSize(p).size;
      }
      return total;
    },
    async clean() {
      let freed = 0;
      for (const p of [path.join(LOCAL, 'CrashDumps'), 'C:\\Windows\\Minidump']) {
        if (exists(p)) freed += wu.emptyDir(p).freed;
      }
      return { freed };
    },
  },
  {
    id: 'pip-cache',
    name: 'pip 缓存',
    risk: 'low',
    level: 'user',
    consequence:
      'pip 下载过的 Python 包副本。删除后下次安装依赖会重新下载。',
    suggestion: '建议清理。',
    location: path.join(LOCAL, 'pip', 'Cache'),
    async scan() {
      const p = path.join(LOCAL, 'pip', 'Cache');
      if (!exists(p)) return 0;
      return wu.dirSize(p).size;
    },
    async clean() {
      return wu.emptyDir(path.join(LOCAL, 'pip', 'Cache'));
    },
  },
  {
    id: 'recycle-bin',
    name: '回收站',
    risk: 'high',
    level: 'user',
    consequence:
      '已删除但尚未彻底移除的文件。清空后文件无法通过回收站还原。',
    suggestion: '谨慎：确认里面没有还需要的东西后再清理。',
    location: '回收站',
    // 唯一按磁盘选区统计的清理项：每块盘各有自己的 $Recycle.Bin
    driveScoped: true,
    async scan(ctx) {
      // 选区为空表示用户没选任何盘，不统计（渲染层会先拦下并提示）
      const letters = Array.isArray(ctx.drives) ? ctx.drives : [];
      if (!letters.length) return 0;
      const results = await Promise.all(letters.map((l) => wu.queryRecycleBin(l + ':\\')));
      return results.reduce((acc, r) => acc + r.size, 0);
    },
    async clean() {
      await wu.emptyRecycleBin();
      return { freed: 0 };
    },
  },
  {
    id: 'thumbnail-cache',
    name: '缩略图 / 图标缓存',
    risk: 'low',
    level: 'user',
    consequence:
      '资源管理器用于加速显示的图片缩略图和图标。删除后图标首次加载会重新生成。',
    suggestion: '可以删。清除前建议关闭资源管理器窗口。',
    location: path.join(LOCAL, 'Microsoft', 'Windows', 'Explorer'),
    async scan() {
      const dir = path.join(LOCAL, 'Microsoft', 'Windows', 'Explorer');
      const files = wu.listFilesMatching(dir, (n) => /^(thumbcache|iconcache).*\.db$/i.test(n), {
        max: 500,
      });
      let total = 0;
      for (const f of files) {
        try {
          total += fs.statSync(f).size;
        } catch {
          /* ignore */
        }
      }
      return total;
    },
    async clean() {
      const dir = path.join(LOCAL, 'Microsoft', 'Windows', 'Explorer');
      const files = wu.listFilesMatching(dir, (n) => /^(thumbcache|iconcache).*\.db$/i.test(n), {
        max: 500,
      });
      return wu.deleteFiles(files);
    },
  },
  {
    id: 'prefetch',
    name: '预读取文件（Prefetch）',
    risk: 'low',
    level: 'system',
    consequence:
      '系统预读取记录，删除后常用程序首次启动会慢一点，之后自动重建。',
    suggestion: '可以删，但收益通常不大。',
    location: 'C:\\Windows\\Prefetch',
    async scan() {
      try {
        return wu.dirSize('C:\\Windows\\Prefetch').size;
      } catch {
        return 0;
      }
    },
    async clean() {
      return wu.emptyDir('C:\\Windows\\Prefetch');
    },
  },
  {
    id: 'dx-shader',
    name: 'DirectX 着色器缓存',
    risk: 'low',
    level: 'user',
    consequence:
      '显卡着色器编译结果缓存。删除后游戏或绘图程序首次运行时会重新编译，略有卡顿。',
    suggestion: '可以删，收益通常不大。',
    location: path.join(LOCAL, 'D3DSCache'),
    async scan() {
      let total = 0;
      for (const p of [
        path.join(LOCAL, 'D3DSCache'),
        path.join(LOCAL, 'NVIDIA', 'DXCache'),
        path.join(LOCAL, 'AMD', 'DxCache'),
        path.join(LOCAL, 'Intel', 'ShaderCache'),
      ]) {
        if (exists(p)) total += wu.dirSize(p).size;
      }
      return total;
    },
    async clean() {
      let freed = 0;
      for (const p of [
        path.join(LOCAL, 'D3DSCache'),
        path.join(LOCAL, 'NVIDIA', 'DXCache'),
        path.join(LOCAL, 'AMD', 'DxCache'),
        path.join(LOCAL, 'Intel', 'ShaderCache'),
      ]) {
        if (exists(p)) freed += wu.emptyDir(p).freed;
      }
      return { freed };
    },
  },
  {
    id: 'system-temp',
    name: '系统临时文件',
    risk: 'low',
    level: 'system',
    consequence:
      '系统和安装程序使用的临时目录（C:\\Windows\\Temp 等）。删除后不影响系统运行。',
    suggestion: '建议清理。需要管理员权限。',
    location: 'C:\\Windows\\Temp',
    async scan() {
      let total = 0;
      for (const p of [
        'C:\\Windows\\Temp',
        'C:\\Windows\\SoftwareDistribution\\Download',
        'C:\\Windows\\LiveKernelReports',
      ]) {
        if (exists(p)) total += wu.dirSize(p).size;
      }
      return total;
    },
    async clean() {
      let freed = 0;
      for (const p of [
        'C:\\Windows\\Temp',
        'C:\\Windows\\SoftwareDistribution\\Download',
        'C:\\Windows\\LiveKernelReports',
      ]) {
        if (exists(p)) freed += wu.emptyDir(p).freed;
      }
      return { freed };
    },
  },
];

function readNpmCacheDir() {
  try {
    const npmrc = path.join(os.homedir(), '.npmrc');
    if (!exists(npmrc)) return null;
    const txt = fs.readFileSync(npmrc, 'utf8');
    const m = txt.match(/^\s*cache\s*=\s*(.+)$/m);
    if (!m) return null;
    const v = m[1].trim().replace(/^["']|["']$/g, '');
    // npm 在 Windows 上把 ~ 展开为 home
    return v.startsWith('~') ? path.join(os.homedir(), v.slice(1)) : v;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* 非系统盘的可清理目录                                                */
/* ------------------------------------------------------------------ */

/**
 * 上面 ITEMS 里的路径全部固定在系统盘（用户缓存、Windows 目录）。
 * 但 D 盘、外置盘上同样存在大量缓存与残留：包管理器 store、下载缓存、
 * 软件迁移残留、下载目录、IM 聊天数据等。这些目录的名字与位置没有统一规范，
 * 因此按「规则」在每块选中的盘上探测，探测到的才成为一行。
 *
 * 关键取舍：
 * - 只做存在性探测，大小在扫描阶段异步统计，避免开扫前先卡住几十秒
 * - 一律按目录名精确匹配，不做通配递归，避免误伤
 * - 所有项目的 clean 都只把目标移入回收站，不做永久删除
 * - 下载目录与聊天数据虽标为高风险，但仍会列出，由用户自己决定
 */
const DRIVE_RULES = [
  /* ---- 包管理器缓存：可安全删除，重新安装依赖时会重新下载 ---- */
  {
    key: 'pnpm-store',
    name: 'pnpm 包缓存',
    dirs: ['.pnpm-store', 'pnpm-store'],
    risk: 'low',
    consequence: 'pnpm 下载过的包副本。删除后下次安装依赖会重新下载，不影响已有项目。',
    suggestion: '建议清理，通常占用很大。清理前请关闭正在运行的开发工具。',
  },
  {
    key: 'npm-cache-drive',
    name: 'npm 缓存',
    dirs: ['npm-cache', '.npm'],
    risk: 'low',
    consequence: 'npm 包副本与缓存索引。删除后下次安装会重新下载。',
    suggestion: '建议清理。',
  },
  {
    key: 'yarn-cache',
    name: 'Yarn / pip 缓存',
    dirs: ['Yarn', 'pip', 'uv'],
    risk: 'low',
    consequence: '包管理器缓存的依赖副本，可随时重新下载。',
    suggestion: '建议清理。',
  },
  /* ---- Windows 与系统缓存 ---- */
  {
    key: 'wu-cache',
    name: 'Windows 更新下载缓存',
    dirs: ['WUDownloadCache', 'DeliveryOptimization'],
    risk: 'low',
    consequence: '系统更新与传递优化下载的文件，安装完成后即无用。',
    suggestion: '建议清理。',
  },
  {
    key: 'onedrive-temp',
    name: 'OneDrive 临时目录',
    dirs: ['OneDriveTemp'],
    risk: 'mid',
    consequence: 'OneDrive 同步过程的临时文件。若有未完成的同步任务，建议先让同步跑完。',
    suggestion: '可以清理，建议先确认 OneDrive 已完成同步。',
  },
  /* ---- 音频软件缓存 ---- */
  {
    key: 'music-cache',
    name: '音乐软件缓存',
    dirs: ['QQMusicCache', 'KuGou/Temp', 'CloudMusic/cache'],
    risk: 'low',
    consequence: '在线音乐播放产生的缓冲与封面缓存。删除后下次播放会重新缓冲。',
    suggestion: '建议清理。',
  },
  /* ---- 开发残留 ---- */
  {
    key: 'broken-node-modules',
    name: '损坏的依赖残留',
    dirPrefixes: ['node_modules.broken'],
    risk: 'low',
    consequence: '依赖安装失败后留下的残骸。项目已不可用，删除后需重新 npm install。',
    suggestion: '建议清理。确认没有正在使用的项目依赖此目录。',
  },
  /* ---- 软件迁移 / 自动恢复残留 ---- */
  {
    key: 'ps-autorecover',
    name: 'Photoshop 自动恢复文件',
    dirs: ['PSAutoRecover'],
    risk: 'mid',
    consequence: 'Photoshop 崩溃后生成的自动恢复副本。删除后无法再恢复未保存的工程。',
    suggestion: '谨慎：若近期有未保存的 PSD，请先打开确认。',
  },
  {
    key: 'migrate-files',
    name: '软件管家迁移文件',
    dirs: ['电脑管家迁移文件'],
    risk: 'mid',
    consequence: '软件搬家工具迁移目录时留下的原始文件副本，可能仍被程序引用。',
    suggestion: '谨慎：建议先确认对应软件能正常运行再删除。',
  },
  /* ---- 用户数据：仅列出，是否删除由用户判断 ---- */
  {
    key: 'downloads',
    name: '下载目录',
    dirs: ['迅雷下载', 'BaiduNetdiskDownload', 'Downloads', 'ThunderDownload'],
    risk: 'high',
    consequence: '这里是你下载保存的文件，属于个人数据，不是缓存。删除后需重新下载。',
    suggestion: '请自行确认内容。程序不会自动清理，只在你勾选并二次确认后移入回收站。',
    userData: true,
  },
  {
    key: 'im-data',
    name: '聊天软件数据',
    dirs: ['WeChat', 'Weixin', 'xwechat_files', 'Tencent Files'],
    risk: 'high',
    consequence: '微信 / QQ 的聊天记录、图片与文件，属于重要个人数据。删除后无法恢复。',
    suggestion: '强烈建议保留。如需清理请使用软件自带的存储管理功能。',
    userData: true,
  },
  /* ---- 根目录临时文件残留 ---- */
  {
    key: 'tmp-files',
    name: '临时文件残留',
    filePrefixes: ['_tmp_'],
    risk: 'low',
    consequence: '程序异常退出后残留在根目录的临时文件，通常已无用。',
    suggestion: '建议清理。',
  },
];

/**
 * 按盘探测出的清理项注册表。
 * 这些项的生命周期是「本次扫描」，但清理动作发生在扫描之后，
 * 因此需要按 id 保留引用，让 cleanItems 能找回它们的目标路径。
 */
const discoveredRegistry = new Map();

/**
 * 在选中盘上探测规则命中的目录 / 文件。
 * 只列一层（盘根），不做递归，命中即生成一条清理项。
 * @param {string[]} drives 盘符字母数组
 * @returns {Array} 清理项定义，与 ITEMS 同构，可直接参与扫描
 */
function discoverDriveItems(drives) {
  const out = [];
  // 每次重新扫描都以最新一次探测结果为准，清掉上一轮的旧引用
  discoveredRegistry.clear();
  for (const letter of drives) {
    const root = letter + ':\\';
    let entries;
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    const dirNames = new Set(entries.filter((e) => e.isDirectory()).map((e) => e.name));
    const fileNames = entries.filter((e) => e.isFile()).map((e) => e.name);

    for (const rule of DRIVE_RULES) {
      const hits = [];

      // 精确目录名（支持 a/b 形式的两级路径）
      for (const rel of rule.dirs || []) {
        const first = rel.split('/')[0];
        if (!dirNames.has(first)) continue;
        const full = path.join(root, ...rel.split('/'));
        if (exists(full)) hits.push({ path: full, kind: 'dir' });
      }

      // 前缀匹配的目录（如 node_modules.broken-20261109）
      for (const pre of rule.dirPrefixes || []) {
        for (const n of dirNames) {
          if (!n.toLowerCase().startsWith(pre.toLowerCase())) continue;
          hits.push({ path: path.join(root, n), kind: 'dir' });
        }
      }

      // 前缀匹配的根目录文件（如 _tmp_xxx）
      const files = [];
      for (const pre of rule.filePrefixes || []) {
        for (const n of fileNames) {
          if (!n.startsWith(pre)) continue;
          files.push(path.join(root, n));
        }
      }

      if (!hits.length && !files.length) continue;

      const id = `drv-${letter}-${rule.key}`;
      const def = {
        id,
        name: `${rule.name}（${letter}:）`,
        risk: rule.risk,
        level: 'user',
        consequence: rule.consequence,
        suggestion: rule.suggestion,
        location: hits.length ? hits[0].path : path.join(root),
        // 非标准路径，清理前一律要求二次确认
        confirmClean: true,
        userData: !!rule.userData,
        driveLetter: letter,
        targets: hits.map((h) => h.path),
        files,
        async scan() {
          let total = 0;
          let count = 0;
          for (const t of this.targets) {
            try {
              const r = await wu.dirSizeAsync(t);
              total += r.size;
              count += r.files;
            } catch {
              /* 目录消失或无权访问 */
            }
          }
          for (const f of this.files) {
            try {
              total += fs.statSync(f).size;
              count += 1;
            } catch {
              /* 已被删除 */
            }
          }
          this.fileCount = count;
          return total;
        },
        // clean 由主进程注入的 trash 完成，只移入回收站，绝不永久删除
        async clean(ctx) {
          const trash = ctx && ctx.trash;
          if (typeof trash !== 'function') {
            return { freed: 0, error: '缺少回收站接口，已跳过以保护数据' };
          }
          let freed = 0;
          const errors = [];
          for (const t of this.targets) {
            try {
              const sz = await wu.dirSizeAsync(t);
              await trash(t);
              freed += sz.size;
            } catch (e) {
              errors.push(`${path.basename(t)}：${e.code || e.message}`);
            }
          }
          for (const f of this.files) {
            try {
              const sz = fs.statSync(f).size;
              await trash(f);
              freed += sz;
            } catch (e) {
              errors.push(`${path.basename(f)}：${e.code || e.message}`);
            }
          }
          return { freed, error: errors.length ? errors.join('；') : null };
        },
      };

      discoveredRegistry.set(id, def);
      out.push(def);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 扫描协调                                                            */
/* ------------------------------------------------------------------ */

/** 系统盘盘符（通常是 C）。清理项里的用户缓存、系统目录都固定落在系统盘上。 */
function getSystemDriveLetter() {
  const sys = process.env.SystemDrive || 'C:';
  return sys.replace(':', '').toUpperCase();
}

/**
 * 扫描全部项目，逐项回调。
 * @param {{drives?:string[], onItem:(item)=>void, onProgress?:(p)=>void, signal?:{stopped:boolean}}} opts
 */
async function scanAll(opts = {}) {
  const { onItem, onProgress } = opts;

  // 扫描范围来自侧边栏选区；未传时退化为系统盘，避免主进程被误调时扫出空结果
  const drives =
    Array.isArray(opts.drives) && opts.drives.length
      ? opts.drives.map((d) => String(d).replace(':', '').toUpperCase())
      : await detectFastLetters();
  const selected = new Set(drives);
  const systemDrive = getSystemDriveLetter();

  // 固定路径项（用户缓存 / 系统缓存）只存在于系统盘：没勾选系统盘就不该统计它们，
  // 否则用户明明只选了 D 盘，界面上却仍然是 C 盘的数字。
  // 回收站是唯一每盘各有一份的项目，永远按选区统计。
  const fixed = ITEMS.filter((def) => def.driveScoped || selected.has(systemDrive));

  // 非系统盘上没有固定路径，改为按规则探测该盘实际存在的缓存 / 残留目录，
  // 探测到的每一项都会单独成行，由用户自己决定是否勾选清理。
  const discovered = discoverDriveItems(drives);

  // 系统盘放在前面（用户最常清理），发现的项按盘符跟在后面
  const scoped = [...fixed, ...discovered];

  const results = [];
  const total = scoped.length;
  const ctx = { drives, selected, systemDrive, isAdmin: wu.isAdmin(), trash: opts.trash };

  for (let i = 0; i < total; i++) {
    if (opts.signal && opts.signal.stopped) break;
    const def = scoped[i];
    if (onProgress) {
      onProgress({ index: i, total, name: def.name, percent: Math.round((i / total) * 100) });
    }

    let size = 0;
    let error = null;
    const t0 = Date.now();
    try {
      size = await def.scan(ctx);
    } catch (e) {
      error = e.message || String(e);
    }

    const item = {
      id: def.id,
      name: def.name,
      risk: def.risk,
      level: def.level,
      size,
      sizeText: '',
      location: def.location,
      consequence: def.consequence,
      suggestion: def.suggestion,
      error,
      // 系统级项目在非管理员下无法枚举，不能当成 0 字节，需要单独标识
      needAdmin: def.level === 'system' && !ctx.isAdmin && size === 0,
      // 按盘探测出的项：让界面知道需要二次确认，以及里面有多少文件
      confirmClean: !!def.confirmClean,
      userData: !!def.userData,
      driveLetter: def.driveLetter || null,
      fileCount: typeof def.fileCount === 'number' ? def.fileCount : null,
      elapsed: Date.now() - t0,
    };
    results.push(item);
    if (onItem) onItem(item);
  }

  if (onProgress) onProgress({ index: total, total, percent: 100, done: true });
  return results;
}

/**
 * 默认扫描盘：系统盘（C）。回收站在系统盘上通常条目最少、响应最快。
 */
async function detectFastLetters() {
  const drives = await wu.getDrives();
  const letters = drives.map((d) => d.letter.toUpperCase());
  const sys = getSystemDriveLetter();
  if (letters.includes(sys)) return [sys];
  return letters.slice(0, 1);
}

/**
 * 全量回收站扫描（用户明确要求时）。
 */
async function scanRecycleAll() {
  return wu.queryRecycleBin(null);
}

/**
 * 执行清理。
 * @param {string[]} ids
 * @param {{onProgress?:Function, trash?:Function}} opts
 *   trash 用于把按盘探测出的目录移入回收站；不做永久删除
 */
async function cleanItems(ids, opts = {}) {
  const out = [];
  for (const id of ids) {
    // 按盘探测出的项是每次扫描动态生成的，不在静态 ITEMS 里，需要查注册表
    const def = ITEMS.find((x) => x.id === id) || discoveredRegistry.get(id);
    if (!def) continue;
    let freed = 0;
    let error = null;
    try {
      // 传入上下文，让按盘项能拿到回收站接口
      const r = await def.clean({ trash: opts.trash });
      freed = r && typeof r.freed === 'number' ? r.freed : r && typeof r.size === 'number' ? r.size : 0;
      if (r && r.error) error = r.error;
    } catch (e) {
      error = e.message || String(e);
    }
    out.push({ id, name: def.name, freed, error });
    if (opts.onProgress) opts.onProgress({ id, name: def.name, freed, error });
  }
  return out;
}

module.exports = {
  ITEMS,
  DRIVE_RULES,
  discoverDriveItems,
  discoveredRegistry,
  scanAll,
  scanRecycleAll,
  cleanItems,
  detectFastLetters,
  getSystemDriveLetter,
  getItemById: (id) => ITEMS.find((x) => x.id === id) || discoveredRegistry.get(id),
};