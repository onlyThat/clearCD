'use strict';

/**
 * 通用 Windows 工具层：目录遍历、大小统计、回收站、提权、磁盘容量。
 * 全部使用原生 fs，避免调用 PowerShell 造成的启动开销。
 */

const fs = require('fs');
const path = require('path');
const { execFile, execFileSync } = require('child_process');

const MB = 1024 * 1024;

/* ------------------------------------------------------------------ */
/* 目录遍历                                                            */
/* ------------------------------------------------------------------ */

/**
 * 递归统计目录大小与文件数。
 * @param {string} dir
 * @param {{shouldStop?: () => boolean}} [opts]
 * @returns {{size:number, files:number}}
 */
function dirSize(dir, opts = {}) {
  let size = 0;
  let files = 0;
  const shouldStop = opts.shouldStop || (() => false);

  // 显式栈，避免深目录递归爆栈
  const stack = [dir];
  while (stack.length) {
    if (shouldStop()) break;
    const cur = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue; // 无权限 / 已消失，跳过
    }
    for (const ent of entries) {
      const full = cur + path.sep + ent.name;
      if (ent.isDirectory()) {
        stack.push(full);
      } else if (ent.isFile()) {
        try {
          const st = fs.statSync(full);
          size += st.size;
          files += 1;
        } catch {
          /* 文件正在被占用 */
        }
      }
    }
  }
  return { size, files };
}

/**
 * 并行版目录大小统计。
 * 非系统盘上的缓存目录（如 D 盘 .pnpm-store 有 37 万文件）用同步版会卡死主进程，
 * 这里用 readdir + Promise.all 分目录并发，让出事件循环。
 * @param {string} dir
 * @param {{concurrency?:number}} [opts]
 * @returns {Promise<{size:number, files:number}>}
 */
async function dirSizeAsync(dir, opts = {}) {
  const fsp = fs.promises;
  const concurrency = opts.concurrency || 48;
  let size = 0;
  let files = 0;
  const stack = [dir];

  await new Promise((resolve) => {
    let active = 0;
    let settled = false;

    const finish = () => {
      if (settled) return;
      if (active !== 0 || stack.length !== 0) return;
      settled = true;
      resolve();
    };

    const pump = () => {
      if (active === 0 && stack.length === 0) return finish();
      while (active < concurrency && stack.length) {
        const cur = stack.pop();
        active++;
        fsp
          .readdir(cur, { withFileTypes: true })
          .then(async (entries) => {
            const subdirs = [];
            const stamp = [];
            for (const ent of entries) {
              const full = cur + path.sep + ent.name;
              if (ent.isDirectory()) {
                subdirs.push(full);
              } else if (ent.isFile()) {
                stamp.push(
                  fsp
                    .stat(full)
                    .then((st) => {
                      size += st.size;
                      files += 1;
                    })
                    .catch(() => {})
                );
              }
            }
            for (const d of subdirs) stack.push(d);
            // 单个目录内的文件并发取大小，避免大目录里串行 await
            await Promise.all(stamp);
          })
          .catch(() => {
            /* 无权限 / 已消失 */
          })
          .finally(() => {
            active--;
            pump();
          });
      }
    };

    pump();
  });

  return { size, files };
}

/**
 * 收集目录下所有文件路径（用于删除）。
 */
function listFiles(dir, opts = {}) {
  const max = opts.max || Infinity;
  const out = [];
  const stack = [dir];
  while (stack.length && out.length < max) {
    const cur = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (out.length >= max) break;
      const full = cur + path.sep + ent.name;
      if (ent.isDirectory()) {
        stack.push(full);
      } else {
        out.push(full);
      }
    }
  }
  return out;
}

/**
 * 目录下按扩展名/前缀筛选文件。
 */
function listFilesMatching(dir, test, opts = {}) {
  const out = [];
  const max = opts.max || Infinity;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ent of entries) {
    if (out.length >= max) break;
    if (!ent.isFile()) continue;
    const full = path.join(dir, ent.name);
    if (!test(ent.name)) continue;
    out.push(full);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 删除                                                                */
/* ------------------------------------------------------------------ */

/**
 * 逐文件删除，返回释放字节数。删除失败（占用/无权限）静默跳过。
 */
function deleteFiles(files, onProgress) {
  let freed = 0;
  let removed = 0;
  let skipped = 0;
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    let sz = 0;
    try {
      sz = fs.statSync(f).size;
    } catch {
      skipped++;
      continue;
    }
    try {
      fs.unlinkSync(f);
      freed += sz;
      removed++;
    } catch {
      skipped++;
    }
    if (onProgress && i % 50 === 0) onProgress(i + 1, files.length);
  }
  return { freed, removed, skipped };
}

/**
 * 递归收集目录下的全部文件与全部子目录。
 */
function collectAll(root) {
  const files = [];
  const dirs = [];
  const stack = [root];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const full = path.join(cur, ent.name);
      if (ent.isDirectory()) {
        dirs.push(full);
        stack.push(full);
      } else if (ent.isFile()) {
        files.push(full);
      }
    }
  }
  return { files, dirs };
}

/**
 * 清空目录内容但保留目录本身（用于缓存目录）。
 * 文件删完后自底向上移除空子目录，避免成千上万的空目录壳残留。
 */
function emptyDir(dir, opts = {}) {
  if (!fs.existsSync(dir)) return { freed: 0, removed: 0, skipped: 0 };

  const { files, dirs } = collectAll(dir);
  const res = deleteFiles(files, opts.onProgress);

  // 按深度倒序，先删最深一层；非空（含锁定文件）或被占用的目录保留
  dirs
    .sort((a, b) => b.split(path.sep).length - a.split(path.sep).length)
    .forEach((d) => {
      try {
        fs.rmdirSync(d);
      } catch {
        /* 非空 / 被占用，保留 */
      }
    });

  return res;
}

/* ------------------------------------------------------------------ */
/* 回收站                                                              */
/* ------------------------------------------------------------------ */

let _cachedSid = null;

/** 取当前用户 SID：先走环境变量，避免每次扫描启进程 */
function getCurrentSid() {
  if (_cachedSid) return _cachedSid;
  try {
    const out = execFileSync('C:\\Windows\\System32\\whoami.exe', ['/user', '/fo', 'csv', '/nh'], {
      windowsHide: true,
      timeout: 8000,
      encoding: 'utf8',
    });
    const m = out.match(/"(S-1-[\d-]+)"/);
    if (m) _cachedSid = m[1];
  } catch {
    /* 取不到就退化为不排序 */
  }
  return _cachedSid;
}

/**
 * 直接从 NTFS $Recycle.Bin 解析 $I 记录。
 * 每条 $I 文件头 16 字节：[0..8) 版本号 [8..16) 原文件大小。
 * 相比 SHQueryRecycleBin（D 盘 19 万项需 70s）快约 2 倍，且不依赖 PowerShell。
 * 使用多路并发打开文件，瓶颈在机械盘的随机寻道。
 */
async function scanRecycleNative(root, concurrency = 64) {
  const fsp = fs.promises;
  const bin = path.join(root, '$Recycle.Bin');
  let sids;
  try {
    sids = (await fsp.readdir(bin, { withFileTypes: true })).filter((e) => e.isDirectory());
  } catch {
    return { size: 0, items: 0 };
  }

  // 当前用户目录排在前面：其他用户的目录需要管理员权限，通常列不出内容
  const mySid = getCurrentSid();
  sids.sort((a, b) => (b.name === mySid ? 1 : 0) - (a.name === mySid ? 1 : 0));

  const all = [];
  for (const sid of sids) {
    const dir = path.join(bin, sid.name);
    let names;
    try {
      names = await fsp.readdir(dir);
    } catch {
      continue; // 他人的回收站目录，跳过
    }
    for (const n of names) if (n.startsWith('$I')) all.push(path.join(dir, n));
  }

  let size = 0;
  let items = 0;
  let idx = 0;
  async function worker() {
    while (idx < all.length) {
      const p = all[idx++];
      try {
        const fh = await fsp.open(p, 'r');
        // read() 返回新分配的 buffer，天然线程安全；复用外部 buffer 会并发覆盖
        const { buffer, bytesRead } = await fh.read(Buffer.allocUnsafe(16), 0, 16, 0);
        await fh.close();
        if (bytesRead < 16) continue;
        const sz = buffer.readBigInt64LE(8);
        if (sz > 0n) size += Number(sz);
        items++;
      } catch {
        /* 记录正在被写入或已被清空 */
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, all.length || 1) }, worker));
  return { size, items };
}

/**
 * 查询指定卷的回收站（root 传 null 表示全部驱动器，各盘并行）。
 */
async function queryRecycleBin(root = null) {
  if (process.platform !== 'win32') return { size: 0, items: 0 };
  if (root) return scanRecycleNative(root);

  const drives = await getDrives();
  // 不同盘位于不同物理设备，可以并行
  const results = await Promise.all(drives.map((d) => scanRecycleNative(d.letter + ':\\')));
  return results.reduce(
    (acc, r) => ({ size: acc.size + r.size, items: acc.items + r.items }),
    { size: 0, items: 0 }
  );
}

/**
 * 清空回收站。
 */
function emptyRecycleBin() {
  return new Promise((resolve) => {
    const script =
      'Clear-RecycleBin -Force -ErrorAction SilentlyContinue; ' +
      'Write-Output "done"';
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, timeout: 300000 },
      () => resolve(true)
    );
  });
}

/* ------------------------------------------------------------------ */
/* 磁盘与权限                                                          */
/* ------------------------------------------------------------------ */

/**
 * 是否以提升的管理员权限运行。
 * 判断依据是令牌完整性级别 S-1-16-12288（High），而不是管理员组 SID ——
 * 未提权时管理员组 SID 会以 deny-only 形式出现，用它判断会误报。
 */
function isAdmin() {
  if (process.platform !== 'win32') return false;
  try {
    const out = execFileSync('C:\\Windows\\System32\\whoami.exe', ['/groups'], {
      windowsHide: true,
      timeout: 8000,
      encoding: 'utf8',
    });
    return /S-1-16-12288/.test(out) || /S-1-16-16384/.test(out);
  } catch {
    return false;
  }
}

/**
 * 获取各驱动器容量（字节）。
 */
function getDrives() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve([]);
    const script = `Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" | ForEach-Object { "$($_.DeviceID)|$($_.Size)|$($_.FreeSpace)|$($_.VolumeName)" }`;
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true, timeout: 20000, maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        if (err) return resolve([]);
        const drives = String(stdout)
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter(Boolean)
          .map((line) => {
            const [dev, size, free, name] = line.split('|');
            return {
              letter: String(dev).replace(':', ''),
              total: Number(size) || 0,
              free: Number(free) || 0,
              used: (Number(size) || 0) - (Number(free) || 0),
              name: name || '',
            };
          });
        resolve(drives);
      }
    );
  });
}

module.exports = {
  MB,
  dirSize,
  dirSizeAsync,
  listFiles,
  listFilesMatching,
  deleteFiles,
  emptyDir,
  queryRecycleBin,
  emptyRecycleBin,
  isAdmin,
  getDrives,
};