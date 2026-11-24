'use strict';

/* ==========================================================================
   onlyThatLove 渲染进程
   ========================================================================== */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const state = {
  env: null,
  items: [],
  selected: new Set(),
  activeId: null,
  sortDesc: true,
  filter: '',
  scanning: false,
  cleaning: false,
  logs: [],
  // 侧边栏磁盘条的选区：存盘符字母，决定大文件扫描扫哪些盘
  scanDrives: new Set(),
};

/* ------------------------------------------------------------------ */
/* 格式化                                                              */
/* ------------------------------------------------------------------ */

function fmtSize(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  // 与设计稿一致：不足 10 时保留一位小数
  const digits = v >= 100 ? 0 : v >= 10 ? 1 : v >= 1 ? 1 : 2;
  return `${v.toFixed(i === 0 ? 0 : digits)} ${units[i]}`;
}

function fmtTime(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function fmtDate(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

const RISK_TEXT = { low: '低风险', mid: '中风险', high: '高风险' };

/* ------------------------------------------------------------------ */
/* 提示                                                                */
/* ------------------------------------------------------------------ */

function toast(msg, type = '', ms = 3200) {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  $('#toast-wrap').appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .25s, transform .25s';
    el.style.opacity = '0';
    el.style.transform = 'translateY(8px)';
    setTimeout(() => el.remove(), 260);
  }, ms);
}

function log(msg, type = '') {
  state.logs.unshift({ time: new Date(), msg, type });
  if (state.logs.length > 300) state.logs.length = 300;
  if ($('#view-logs').classList.contains('active')) renderLogs();
}

function renderLogs() {
  const box = $('#log-body');
  if (!state.logs.length) {
    box.innerHTML = '<div class="empty-state">暂无日志</div>';
    return;
  }
  box.innerHTML = state.logs
    .map(
      (l) =>
        `<div class="log-entry ${l.type}"><span class="log-time">${fmtDate(l.time)}</span><span class="log-msg"></span></div>`
    )
    .join('');
  $$('.log-entry').forEach((el, i) => {
    el.querySelector('.log-msg').textContent = state.logs[i].msg;
  });
}

/* ------------------------------------------------------------------ */
/* 视图切换                                                            */
/* ------------------------------------------------------------------ */

function switchView(name) {
  $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
  if (name === 'logs') renderLogs();
}

$$('.nav-item').forEach((b) => b.addEventListener('click', () => switchView(b.dataset.view)));

/* ------------------------------------------------------------------ */
/* 环境信息                                                            */
/* ------------------------------------------------------------------ */

async function loadEnv() {
  const env = await window.api.envInfo();
  state.env = env;

  $('#app-version').textContent = env.version;

  // 默认只选系统盘（C）。全选会让首次启动就扫描所有盘，
  // D 盘上有几十万文件时，仅统计大小就要一分钟，用户会以为程序卡住了。
  // 想扫别的盘，点一下侧边栏对应的磁盘条即可，每点一次切换一次选中状态，可多选。
  if (!state.scanDrives.size) {
    const sys = env.drives.find((d) => d.letter.toUpperCase() === 'C');
    const pick = sys || env.drives[0];
    if (pick) state.scanDrives.add(pick.letter);
  }

  renderDrives(env.drives);
  syncScanDrives();
  renderScanRange(pickedDrives());
  renderAdmin(env.isAdmin);
}

function renderDrives(drives) {
  const box = $('#drives');
  box.innerHTML = drives
    .map((d) => {
      const usedPct = d.total ? (d.used / d.total) * 100 : 0;
      const cls = usedPct >= 90 ? 'danger' : usedPct >= 75 ? 'warn' : '';
      // 侧边栏磁盘条同时是扫描范围的选区：点击切换该盘是否参与扫描
      const on = state.scanDrives.has(d.letter);
      const tip = on
        ? `扫描范围已包含 ${d.letter}: 盘；点击移出`
        : `点击将 ${d.letter}: 盘加入扫描范围`;
      return `
        <div class="drive-item ${on ? 'selected' : ''}" data-letter="${escapeHtml(d.letter)}" role="checkbox"
             aria-checked="${on}" title="${escapeHtml(tip)}">
          <div class="drive-head">
            <span class="drive-letter">${d.letter}:</span>
            <span class="drive-free"><b>${fmtSize(d.free)}</b> 可用<span class="drive-pct">${Math.round(usedPct)}%</span></span>
          </div>
          <div class="drive-bar"><i class="${cls}" style="width:${usedPct.toFixed(1)}%"></i></div>
          <div class="drive-total">总容量 ${fmtSize(d.total)}</div>
        </div>`;
    })
    .join('');

  $$('#drives .drive-item').forEach((el) => {
    el.addEventListener('click', (e) => {
      const letter = el.dataset.letter;
      if (!letter) return;

      const before = Array.from(state.scanDrives).sort().join(',');

      // 点击切换该盘是否参与扫描，天然支持多选。
      // 允许减到空，由扫描前的校验提示「先选盘」，不静默扫全盘。
      if (state.scanDrives.has(letter)) {
        state.scanDrives.delete(letter);
      } else {
        state.scanDrives.add(letter);
      }

      // 侧边栏选区是唯一来源，磁盘下拉与大文件扫描范围都跟随它
      syncScanDrives();

      // 选区没变就不必重扫，避免点一下当前盘就触发一次全量扫描
      const after = Array.from(state.scanDrives).sort().join(',');
      if (after === before) return;

      // 体检结果与大文件结果都属于旧范围，一并作废
      invalidateScanResults();
      bigList = [];
      bigSel.clear();
      $('#bigfile-body').innerHTML = '<div class="empty-state">扫描范围已变更，请重新扫描</div>';
      updateBigFileSelection();
    });
  });
}

/**
 * 把 state.scanDrives 同步到各处：侧边栏高亮、大文件页磁盘下拉、已选汇总。
 */
function syncScanDrives() {
  $$('#drives .drive-item').forEach((el) => {
    const on = state.scanDrives.has(el.dataset.letter);
    el.classList.toggle('selected', on);
    el.setAttribute('aria-checked', String(on));
    const letter = el.dataset.letter;
    el.title = on
      ? `扫描范围已包含 ${letter}: 盘；点击移出`
      : `点击将 ${letter}: 盘加入扫描范围`;
  });

  const sel = $('#bigfile-drive');
  if (sel && state.env?.drives) {
    const picked = state.env.drives.filter((d) => state.scanDrives.has(d.letter));
    // 下拉始终列出全部盘 + 「全部磁盘」，未选的盘也能从这里加回来；
    // 当前值是选区的镜像，多盘组合时落到一个只用于显示的「已选磁盘」项。
    let html = `<option value="ALL">全部磁盘（${state.env.drives.map((d) => d.letter).join(' / ')}）</option>`;
    html += state.env.drives
      .map((d) => `<option value="${d.letter}">${d.letter}:${d.name ? ' · ' + escapeHtml(d.name) : ''}</option>`)
      .join('');
    if (picked.length === 0) {
      html = '<option value="">未选择磁盘</option>' + html;
    } else if (picked.length > 1 && picked.length !== state.env.drives.length) {
      html = `<option value="MULTI">已选磁盘（${picked.map((d) => d.letter).join(' / ')}）</option>` + html;
    }
    sel.innerHTML = html;

    if (picked.length === 0) sel.value = '';
    else if (picked.length === state.env.drives.length) sel.value = 'ALL';
    else if (picked.length === 1) sel.value = picked[0].letter;
    else sel.value = 'MULTI';
  }
  updateBigFileSelection();
}

function renderAdmin(isAdmin) {
  const line = $('#admin-line');
  const btn = $('#btn-elevate');
  if (isAdmin) {
    line.className = 'admin-line';
    line.innerHTML = '<span class="dot-live"></span>已获得管理员权限';
    btn.textContent = '管理员';
    btn.classList.add('is-admin');
    btn.disabled = true;
  } else {
    line.className = 'admin-line warn';
    line.innerHTML = '<span class="dot-live"></span>未以管理员运行';
    btn.textContent = '管理员';
    btn.classList.remove('is-admin');
    btn.disabled = false;
  }
}

/* ------------------------------------------------------------------ */
/* 扫描                                                                */
/* ------------------------------------------------------------------ */

/** 当前选区对应的盘符数组（顺序跟随系统返回的磁盘列表） */
function pickedDrives() {
  const all = state.env?.drives || [];
  return all.map((d) => d.letter).filter((l) => state.scanDrives.has(l));
}

/** 选区为空时不允许扫描，统一在这里给出提示 */
function requireDrives() {
  const drives = pickedDrives();
  if (!drives.length) {
    toast('请先在左侧选择至少一块磁盘', 'err', 3600);
    log('扫描未开始：未选择任何磁盘', 'err');
    return null;
  }
  return drives;
}

async function startScan() {
  if (state.scanning || state.cleaning) return;

  const drives = requireDrives();
  if (!drives) return;

  state.scanning = true;
  state.items = [];
  state.selected.clear();
  state.activeId = null;
  setStatsLoading();
  $('#table-body').innerHTML = '<div class="empty-state"><div class="spinner"></div><div>正在扫描…</div></div>';
  renderDetail(null);

  renderScanRange(drives);
  showOverlay('正在扫描…', '准备中');

  const offItem = window.api.onScanItem((item) => {
    state.items.push(item);
    appendPartial(item);
    updateStatsLive();
  });
  const offProgress = window.api.onScanProgress((p) => {
    if (p.done) return;
    $('#overlay-sub').textContent = `${p.name}（${p.index + 1}/${p.total}）`;
    setProgress(p.percent);
  });

  try {
    const res = await window.api.startScan({ drives });
    state.items = res.items;
    renderTable();
    renderStats(res.stats);
    const t = new Date();
    $('#last-scan-time').textContent = fmtTime(t);
    log(
      `扫描完成，可清理 ${fmtSize(res.stats.total)}，共 ${res.stats.count} 项，` +
        `范围 ${drives.map((d) => d + ':').join(' ')}`
    );
    // 只选了非系统盘时，用户缓存 / 系统缓存不在范围内，明确告知而不是让界面默默变短
    if (res.fixedItemsSkipped) {
      log(
        `当前只扫描了 ${drives.map((d) => d + ':').join(' ')}，` +
          `用户缓存与系统缓存位于 ${res.systemDrive}: 盘，未计入本次结果`,
        'warn'
      );
      toast(`用户缓存与系统缓存位于 ${res.systemDrive}: 盘，本次未计入`, '', 5200);
    }
  } catch (e) {
    toast('扫描失败：' + e.message, 'err', 5000);
    log('扫描失败：' + e.message, 'err');
  } finally {
    offItem();
    offProgress();
    state.scanning = false;
    hideOverlay();
  }
}

/** 标题栏展示本次扫描范围，避免「选了 D 却显示 C 数字」的困惑 */
function renderScanRange(drives) {
  const el = $('#scan-range');
  if (!el) return;
  el.textContent = drives && drives.length ? `范围 ${drives.map((d) => d + ':').join(' ')}` : '未选择磁盘';
}

/**
 * 磁盘选区变化后，已扫出的结果属于旧范围，必须作废。
 * 用短延迟合并连续点击，避免每点一下就触发一次全盘扫描。
 */
let driveChangeTimer = null;
function invalidateScanResults() {
  const drives = pickedDrives();
  renderScanRange(drives);

  if (!state.items.length) return;
  state.items = [];
  state.selected.clear();
  state.activeId = null;
  $('#table-body').innerHTML = '<div class="empty-state">扫描范围已变更，正在重新扫描…</div>';
  renderDetail(null);

  clearTimeout(driveChangeTimer);
  driveChangeTimer = setTimeout(() => {
    if (!state.scanning && !state.cleaning) startScan();
  }, 600);
}

function setProgress(pct) {
  $('#progress-bar').style.width = `${Math.max(2, Math.min(100, pct))}%`;
}

function showOverlay(title, sub) {
  $('#overlay-title').textContent = title;
  $('#overlay-sub').textContent = sub;
  setProgress(0);
  $('#btn-overlay-cancel').hidden = false;
  $('#overlay').hidden = false;
}

function hideOverlay() {
  $('#overlay').hidden = true;
}

function setStatsLoading() {
  ['total', 'low', 'mid', 'high'].forEach((k) => {
    $(`#stat-${k}`).textContent = '--';
  });
  $('#stat-total-sub').textContent = '扫描中…';
  ['low', 'mid', 'high'].forEach((k) => ($(`#stat-${k}-sub`).textContent = '--'));
}

/** 扫描过程中实时更新卡片 */
function updateStatsLive() {
  const stats = computeStats(state.items);
  renderStats(stats, true);
}

function computeStats(items) {
  const sum = (a) => a.reduce((x, y) => x + (y.size || 0), 0);
  const pick = (r) => items.filter((i) => i.risk === r);
  // 项数按全部项统计，与列表行数保持一致
  return {
    total: sum(items),
    count: items.length,
    low: sum(pick('low')),
    lowCount: pick('low').length,
    mid: sum(pick('mid')),
    midCount: pick('mid').length,
    high: sum(pick('high')),
    highCount: pick('high').length,
  };
}

function renderStats(s, partial) {
  $('#stat-total').textContent = fmtSize(s.total);
  $('#stat-total-sub').textContent = partial ? `已发现 ${s.count} 个清理项` : `${s.count} 个清理项`;
  $('#stat-low').textContent = fmtSize(s.low);
  $('#stat-low-sub').textContent = `${s.lowCount} 项`;
  $('#stat-mid').textContent = fmtSize(s.mid);
  $('#stat-mid-sub').textContent = `${s.midCount} 项`;
  $('#stat-high').textContent = fmtSize(s.high);
  $('#stat-high-sub').textContent = `${s.highCount} 项`;
}

/* ------------------------------------------------------------------ */
/* 表格                                                                */
/* ------------------------------------------------------------------ */

const CHECK_SVG =
  '<svg viewBox="0 0 12 12" width="10" height="10"><path d="M2.5 6.2L4.8 8.5 9.5 3.8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';

const LOCK_SVG =
  '<svg viewBox="0 0 14 14" width="12" height="12" title="需要管理员权限"><rect x="3" y="6.2" width="8" height="6" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M5 6.2V4.8a2 2 0 0 1 4 0v1.4" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>';

/** 获取当前表格要展示的项（过滤 + 排序） */
function displayItems() {
  let list = state.items.slice();
  const kw = state.filter.trim().toLowerCase();
  if (kw) list = list.filter((i) => i.name.toLowerCase().includes(kw));
  list.sort((a, b) => {
    // 已清空（0 字节）的行始终沉底；「需管理员」的大小未知，不应被判为 0
    const za = a.size === 0 && !a.needAdmin ? 1 : 0;
    const zb = b.size === 0 && !b.needAdmin ? 1 : 0;
    if (za !== zb) return za - zb;
    return state.sortDesc ? b.size - a.size : a.size - b.size;
  });
  return list;
}

function renderTable() {
  const body = $('#table-body');
  const list = displayItems();
  if (!list.length) {
    body.innerHTML = `<div class="empty-state">${state.filter ? '没有匹配的项目' : '没有找到可清理项'}</div>`;
    return;
  }
  body.innerHTML = list
    .map((it) => {
      const isSel = state.selected.has(it.id);
      const isActive = state.activeId === it.id;
      return `
      <div class="row ${isSel ? 'selected' : ''} ${isActive ? 'active' : ''} ${it.userData ? 'row-userdata' : ''}" data-id="${it.id}">
        <span class="col-check">
          <span class="chk ${isSel ? 'on' : ''}" data-check="${it.id}" role="checkbox" aria-checked="${isSel}">${CHECK_SVG}</span>
        </span>
        <span class="row-name" title="${escapeHtml(it.name)}">
          ${it.level === 'system' ? `<span class="lock">${LOCK_SVG}</span>` : ''}
          ${escapeHtml(it.name)}
          ${it.userData ? '<span class="tag-userdata">个人数据</span>' : ''}
        </span>
        <span class="row-size ${it.size > 0 && !it.needAdmin ? '' : 'zero'}">${
          it.needAdmin ? '需管理员' : fmtSize(it.size)
        }</span>
        <span class="row-risk"><span class="risk-pill ${it.risk}">${RISK_TEXT[it.risk]}</span></span>
      </div>`;
    })
    .join('');

  body.querySelectorAll('.row').forEach((row) => {
    const id = row.dataset.id;

    row.addEventListener('click', (e) => {
      // 点复选框不切换详情
      if (e.target.closest('[data-check]')) return;
      selectActive(id);
    });

    const chk = row.querySelector('[data-check]');
    chk.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleSelect(id);
    });
  });

  updateSelectionInfo();
}

/** 扫描时逐条追加，不整表重绘 */
function appendPartial(item) {
  const body = $('#table-body');
  const placeholder = body.querySelector('.empty-state');
  if (placeholder) body.innerHTML = '';

  const el = document.createElement('div');
  el.className = 'row anim-in';
  el.dataset.id = item.id;
  el.innerHTML = `
    <span class="col-check">
      <span class="chk" data-check="${item.id}" role="checkbox" aria-checked="false">${CHECK_SVG}</span>
    </span>
    <span class="row-name">${item.level === 'system' ? `<span class="lock">${LOCK_SVG}</span>` : ''}${escapeHtml(item.name)}${item.userData ? '<span class="tag-userdata">个人数据</span>' : ''}</span>
    <span class="row-size ${item.size > 0 && !item.needAdmin ? '' : 'zero'}">${
      item.needAdmin ? '需管理员' : fmtSize(item.size)
    }</span>
    <span class="row-risk"><span class="risk-pill ${item.risk}">${RISK_TEXT[item.risk]}</span></span>`;
  if (item.userData) el.classList.add('row-userdata');
  body.appendChild(el);

  el.addEventListener('click', (e) => {
    if (e.target.closest('[data-check]')) return;
    selectActive(item.id);
  });
  el.querySelector('[data-check]').addEventListener('click', (e) => {
    e.stopPropagation();
    toggleSelect(item.id);
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function toggleSelect(id) {
  if (state.selected.has(id)) state.selected.delete(id);
  else state.selected.add(id);
  syncRowSelection();
}

function syncRowSelection() {
  $$('#table-body .row').forEach((row) => {
    const id = row.dataset.id;
    const on = state.selected.has(id);
    row.classList.toggle('selected', on);
    const chk = row.querySelector('.chk');
    if (chk) {
      chk.classList.toggle('on', on);
      chk.setAttribute('aria-checked', String(on));
    }
  });
  updateSelectionInfo();
}

function updateSelectionInfo() {
  const sel = state.items.filter((i) => state.selected.has(i.id));
  const size = sel.reduce((a, b) => a + b.size, 0);
  $('#selection-info').textContent = `已选 ${sel.length} 项 · ${fmtSize(size)}`;
  const btn = $('#btn-clean');
  btn.disabled = sel.length === 0 || state.cleaning;
  btn.textContent = sel.length ? `清理选中项（${fmtSize(size)}）` : '清理选中项';
}

/* ------------------------------------------------------------------ */
/* 详情面板                                                            */
/* ------------------------------------------------------------------ */

function selectActive(id) {
  state.activeId = id;
  $$('#table-body .row').forEach((r) => r.classList.toggle('active', r.dataset.id === id));
  renderDetail(getItem(id));
}

function getItem(id) {
  return state.items.find((i) => i.id === id) || null;
}

function renderDetail(item) {
  const btnAdd = $('#btn-add-clean');
  const btnOpen = $('#btn-open-folder');

  if (!item) {
    $('#detail-name').textContent = '未选择项目';
    // 空状态下整行留白，比塞两个 "--" 占位更符合原稿
    $('#detail-size-row').hidden = true;
    $('#detail-consequence').textContent = '在上方列表中选择一个清理项目查看详情。';
    $('#detail-suggestion').textContent = '—';
    $('#detail-location').textContent = '—';
    btnAdd.disabled = true;
    btnOpen.disabled = true;
    return;
  }

  $('#detail-size-row').hidden = false;
  $('#detail-title').textContent = item.userData ? '项目详情 · 个人数据' : '项目详情';
  $('#detail-name').textContent = item.name;
  $('#detail-risk').className = `risk-pill ${item.risk}`;
  $('#detail-risk').textContent = RISK_TEXT[item.risk];
  $('#detail-size').textContent = fmtSize(item.size);
  $('#detail-consequence').textContent = item.consequence || '—';
  $('#detail-suggestion').textContent = item.suggestion || '—';
  $('#detail-location').textContent = item.location || '—';

  const selected = state.selected.has(item.id);
  btnAdd.disabled = false;
  btnAdd.textContent = selected ? '移出清理' : '加入清理';
  btnOpen.disabled = !item.location;

  // 无管理员权限时系统级项目无法统计，替换建议文案
  if (item.needAdmin) {
    $('#detail-suggestion').textContent = '需要管理员权限才能统计与清理此项，请点击右上角「管理员」重新启动。';
    $('#detail-size').textContent = '—';
  }
}

$('#btn-add-clean').addEventListener('click', () => {
  if (!state.activeId) return;
  toggleSelect(state.activeId);
  renderDetail(getItem(state.activeId));
});

$('#btn-open-folder').addEventListener('click', async () => {
  const item = getItem(state.activeId);
  if (!item) return;
  const r = await window.api.openPath(item.location);
  if (!r.ok) toast('无法打开该位置', 'err');
});

/* ------------------------------------------------------------------ */
/* 工具栏                                                              */
/* ------------------------------------------------------------------ */

$('#search-input').addEventListener('input', (e) => {
  state.filter = e.target.value;
  if (!state.scanning) renderTable();
});

$('#sort-size').addEventListener('click', () => {
  state.sortDesc = !state.sortDesc;
  renderTable();
});

$('#btn-select-low').addEventListener('click', () => {
  state.items.filter((i) => i.risk === 'low').forEach((i) => state.selected.add(i.id));
  syncRowSelection();
  if (state.activeId) renderDetail(getItem(state.activeId));
});

$('#btn-clear-sel').addEventListener('click', () => {
  state.selected.clear();
  syncRowSelection();
  if (state.activeId) renderDetail(getItem(state.activeId));
});

$('#btn-rescan').addEventListener('click', startScan);

$('#btn-overlay-cancel').addEventListener('click', async () => {
  if (state.cleaning) return;
  await window.api.stopScan();
  hideOverlay();
  toast('已取消扫描');
});

$('#btn-elevate').addEventListener('click', async () => {
  const ok = await window.api.confirm({
    title: '以管理员身份重启',
    message: '需要管理员权限才能清理系统临时文件与预读取文件。',
    detail: '程序会弹出 UAC 授权窗口并重新启动，当前扫描结果将丢失。是否继续？',
    confirmText: '以管理员重启',
  });
  if (!ok) return;
  await window.api.elevate();
});

/* ------------------------------------------------------------------ */
/* 清理                                                                */
/* ------------------------------------------------------------------ */

$('#btn-clean').addEventListener('click', runClean);

async function runClean() {
  if (state.cleaning) return;
  const sel = state.items.filter((i) => state.selected.has(i.id));
  if (!sel.length) return;

  const totalSize = sel.reduce((a, b) => a + b.size, 0);
  const hasHigh = sel.some((i) => i.risk === 'high');
  const hasSystem = sel.some((i) => i.level === 'system');
  const notAdmin = state.env && !state.env.isAdmin;
  // 按盘探测出的目录、以及个人数据目录，一律要求二次确认
  const needsConfirm = sel.some((i) => i.confirmClean || i.userData);
  const userDataItems = sel.filter((i) => i.userData);

  if (hasHigh || (hasSystem && notAdmin) || needsConfirm) {
    const warnings = [];
    // 个人数据排最前：最容易被误删且无法挽回
    if (userDataItems.length) {
      warnings.push(
        `⚠ 包含 ${userDataItems.length} 项个人数据（${userDataItems.map((i) => i.name).join('、')}）。\n` +
          '这些不是缓存，是聊天记录或下载的文件，删除后只能从回收站还原。'
      );
    }
    if (hasHigh) warnings.push('包含高风险项目（如回收站），删除后无法恢复。');
    if (hasSystem && notAdmin) warnings.push('包含系统级项目，未获得管理员权限时将被跳过。');
    if (sel.some((i) => i.confirmClean) && !userDataItems.length) {
      warnings.push('包含非标准路径的缓存目录，将移入回收站，可从回收站还原。');
    }

    const ok = await window.api.confirm({
      title: userDataItems.length ? '⚠ 确认删除个人数据' : '确认清理',
      message: `即将清理 ${sel.length} 个项目，共 ${fmtSize(totalSize)}。`,
      detail: warnings.join('\n\n'),
      confirmText: userDataItems.length ? '我已确认，删除' : '确认清理',
    });
    if (!ok) return;
  }

  state.cleaning = true;
  updateSelectionInfo();
  showOverlay('正在清理…', `共 ${sel.length} 项`);
  $('#btn-overlay-cancel').hidden = true;

  const off = window.api.onCleanProgress((p) => {
    $('#overlay-sub').textContent = p.freed ? `已释放 ${fmtSize(p.freed)} · ${p.name}` : p.name;
  });

  try {
    const res = await window.api.clean(
      sel.map((i) => i.id),
      { drives: pickedDrives() }
    );

    // 更新本地大小 + 汇总
    let freed = 0;
    const skipped = [];
    for (const r of res.results) {
      const it = getItem(r.id);
      if (!it) continue;
      const before = it.size;
      const after = res.refreshed[r.id] ?? 0;
      const delta = Math.max(0, before - after);
      freed += delta;
      it.size = after;
      if (r.error) skipped.push(`${r.name}：${r.error}`);
    }

    // 清掉已删除的项的选择状态
    state.selected.clear();
    renderTable();
    renderStats(computeStats(state.items));
    if (state.activeId) renderDetail(getItem(state.activeId));

    if (freed > 0) {
      toast(`清理完成，释放 ${fmtSize(freed)}`, 'ok', 4200);
      log(`清理完成，释放 ${fmtSize(freed)}（${sel.length} 项）`, 'ok');
    } else {
      toast('没有文件被删除，可能正在被占用或权限不足', 'err', 4600);
      log(`清理未释放空间（${sel.length} 项）`, 'err');
    }
    if (skipped.length) {
      toast(`${skipped.length} 项未能完全清理`, 'err', 4600);
      log('部分项失败：' + skipped.join('；'), 'err');
    }

    // 刷新磁盘容量
    const drives = await window.api.getDrives();
    renderDrives(drives);
  } catch (e) {
    toast('清理失败：' + e.message, 'err', 5000);
    log('清理失败：' + e.message, 'err');
  } finally {
    off();
    state.cleaning = false;
    hideOverlay();
    updateSelectionInfo();
  }
}

/* ------------------------------------------------------------------ */
/* 大文件                                                              */
/* ------------------------------------------------------------------ */

let bigFileScanning = false;

// 大文件选中集合，键是文件绝对路径
const bigSel = new Set();
let bigList = [];

function updateBigFileSelection() {
  const info = $('#bigfile-selection-info');
  if (!info) return;
  const sel = bigList.filter((f) => bigSel.has(f.path));
  const size = sel.reduce((a, b) => a + (b.size || 0), 0);
  info.textContent = `已选 ${sel.length} 项 · ${fmtSize(size)}`;
  const btn = $('#btn-bigfile-delete');
  const label = $('#btn-bigfile-delete-label');
  if (btn) btn.disabled = sel.length === 0 || bigFileScanning;
  // 只改文字节点，避免把按钮内的图标一起抹掉
  if (label) label.textContent = sel.length ? `删除选中项（${fmtSize(size)}）` : '删除选中项';
}

function syncBigFileRows() {
  $$('#bigfile-body .row-bigfile').forEach((row) => {
    const on = bigSel.has(row.dataset.path);
    row.classList.toggle('selected', on);
    const chk = row.querySelector('.chk');
    if (chk) {
      chk.classList.toggle('on', on);
      chk.setAttribute('aria-checked', String(on));
    }
  });
  updateBigFileSelection();
}

function bigFileRowHtml(f) {
  const on = bigSel.has(f.path);
  return `
    <div class="row row-bigfile ${on ? 'selected' : ''}" data-path="${escapeHtml(f.path)}">
      <span class="col-check">
        <span class="chk ${on ? 'on' : ''}" data-bfcheck role="checkbox" aria-checked="${on}">${CHECK_SVG}</span>
      </span>
      <span class="row-path" title="${escapeHtml(f.path)}">${escapeHtml(f.path)}</span>
      <span class="row-size">${fmtSize(f.size)}</span>
      <span class="row-modified">${f.mtime ? fmtDate(new Date(f.mtime)) : '—'}</span>
    </div>`;
}

function wireBigFileRows() {
  $$('#bigfile-body .row-bigfile').forEach((row) => {
    const p = row.dataset.path;
    row.addEventListener('click', (e) => {
      if (e.target.closest('[data-bfcheck]')) return;
      if (bigSel.has(p)) bigSel.delete(p);
      else bigSel.add(p);
      syncBigFileRows();
    });
    row.querySelector('[data-bfcheck]').addEventListener('click', (e) => {
      e.stopPropagation();
      if (bigSel.has(p)) bigSel.delete(p);
      else bigSel.add(p);
      syncBigFileRows();
    });
    row.addEventListener('dblclick', () => window.api.showInFolder(p));
  });
}

function renderBigFileRows(list) {
  const body = $('#bigfile-body');
  if (!list || !list.length) return;
  bigList = list;
  const prevTop = body.scrollTop;
  body.innerHTML = list.map(bigFileRowHtml).join('');
  wireBigFileRows();
  body.scrollTop = prevTop;
  updateBigFileSelection();
}

$('#btn-bigfile-select-all').addEventListener('click', () => {
  bigList.forEach((f) => bigSel.add(f.path));
  syncBigFileRows();
});

$('#btn-bigfile-clear-sel').addEventListener('click', () => {
  bigSel.clear();
  syncBigFileRows();
});

$('#btn-bigfile-delete').addEventListener('click', async () => {
  const sel = bigList.filter((f) => bigSel.has(f.path));
  if (!sel.length || bigFileScanning) return;

  const total = sel.reduce((a, b) => a + b.size, 0);
  const targets = sel.slice(0, 8).map((f) => f.path).join('\n') + (sel.length > 8 ? `\n… 等 ${sel.length} 项` : '');

  const ok = await window.api.confirm({
    title: '删除选中的大文件',
    message: `即将删除 ${sel.length} 个文件，共 ${fmtSize(total)}。`,
    detail: `${targets}\n\n文件会移入回收站，仍可从回收站还原。`,
    confirmText: '删除',
  });
  if (!ok) return;

  const btn = $('#btn-bigfile-delete');
  const label = $('#btn-bigfile-delete-label');
  btn.disabled = true;
  if (label) label.textContent = '删除中…';

  try {
    const res = await window.api.trashFiles(sel.map((f) => f.path));
    const okPaths = new Set(res.filter((r) => r.ok).map((r) => r.path));
    const failed = res.filter((r) => !r.ok);
    const freed = res.filter((r) => r.ok).reduce((a, b) => a + (b.size || 0), 0);

    // 从列表和选中集合里移除成功的项
    bigList = bigList.filter((f) => !okPaths.has(f.path));
    okPaths.forEach((p) => bigSel.delete(p));
    if (!bigList.length) {
      $('#bigfile-body').innerHTML = '<div class="empty-state">没有文件了</div>';
    } else {
      renderBigFileRows(bigList);
    }

    if (freed > 0) {
      toast(`已删除 ${okPaths.size} 个文件，释放 ${fmtSize(freed)}`, 'ok', 4200);
      log(`大文件删除：${okPaths.size} 个文件，释放 ${fmtSize(freed)}`, 'ok');
    }
    if (failed.length) {
      toast(`${failed.length} 个文件删除失败`, 'err', 4600);
      log('大文件删除失败：' + failed.map((f) => `${f.path}（${f.error}）`).join('；'), 'err');
    }

    // 刷新磁盘容量
    renderDrives(await window.api.getDrives());
  } catch (e) {
    toast('删除失败：' + e.message, 'err', 5000);
    log('大文件删除失败：' + e.message, 'err');
  } finally {
    updateBigFileSelection();
  }
});

// 下拉反向写回选区：选「全部磁盘」= 全选，选单个盘 = 只留该盘
$('#bigfile-drive').addEventListener('change', (e) => {
  const v = e.target.value;
  if (!state.env?.drives) return;
  if (v === 'ALL') {
    state.env.drives.forEach((d) => state.scanDrives.add(d.letter));
  } else if (v && v !== 'MULTI') {
    state.scanDrives.clear();
    state.scanDrives.add(v);
  }
  syncScanDrives();
  // 下拉同样改变扫描范围，旧结果需要作废
  invalidateScanResults();
});

$('#btn-bigfile-scan').addEventListener('click', async () => {
  if (bigFileScanning) return;
  const threshold = Number($('#bigfile-threshold').value);

  // 扫描范围以侧边栏磁盘条的选区为准；下拉只是它的镜像，不单独持有状态。
  // 选区为空时提示而不是静默扫描全盘。
  const drives = pickedDrives();
  if (!drives.length) {
    toast('请先在左侧选择至少一块磁盘', 'err', 3600);
    return;
  }

  bigFileScanning = true;
  bigSel.clear();
  bigList = [];
  const btn = $('#btn-bigfile-scan');
  btn.disabled = true;
  btn.textContent = '扫描中…';
  updateBigFileSelection();

  const body = $('#bigfile-body');
  body.innerHTML =
    '<div class="empty-state"><div class="spinner"></div><div id="bf-status">正在扫描，已发现 0 个文件…</div></div>';

  // 边扫边渲染：第一批命中出现后就不再显示 loading 骨架
  const off = window.api.onBigFileProgress((p) => {
    const status = $('#bf-status');
    if (status) status.textContent = `已扫描 ${p.scanned.toLocaleString()} 个目录，发现 ${p.found} 个文件…`;
    if (p.items && p.items.length) renderBigFileRows(p.items);
  });

  const t0 = Date.now();
  try {
    const list = await window.api.findBigFiles({ drives, threshold });
    if (!list.length) {
      bigList = [];
      body.innerHTML = '<div class="empty-state">未找到超过阈值的文件</div>';
    } else {
      renderBigFileRows(list);
      log(
        `大文件扫描完成：${list.length} 个文件 ≥ ${fmtSize(threshold)}，` +
          `范围 ${drives.map((d) => d + ':').join(' ')}，耗时 ${((Date.now() - t0) / 1000).toFixed(0)} 秒`
      );
    }
  } catch (e) {
    toast('扫描失败：' + e.message, 'err', 5000);
    if (!body.querySelector('.row-bigfile')) {
      body.innerHTML = '<div class="empty-state">扫描失败</div>';
    }
  } finally {
    off();
    bigFileScanning = false;
    btn.disabled = false;
    btn.textContent = '开始扫描';
    updateBigFileSelection();
  }
});

$('#btn-log-clear').addEventListener('click', () => {
  state.logs = [];
  renderLogs();
});

/* ------------------------------------------------------------------ */
/* 自绘标题栏                                                          */
/* ------------------------------------------------------------------ */

function wireWindowButtons() {
  $('#btn-min').addEventListener('click', () => window.api.winMinimize());
  $('#btn-max').addEventListener('click', () => window.api.winMaximize());
  $('#btn-close').addEventListener('click', () => window.api.winClose());

  window.api.onMaxState((isMax) => {
    const btn = $('#btn-max');
    btn.title = isMax ? '还原' : '最大化';
    btn.innerHTML = isMax
      ? '<svg viewBox="0 0 12 12" width="10" height="10"><rect x="2" y="3.5" width="6" height="6" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M4 3.5V2h6v6H8.5" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>'
      : '<svg viewBox="0 0 12 12" width="10" height="10"><rect x="2.5" y="2.5" width="7" height="7" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>';
  });
}

/* ------------------------------------------------------------------ */
/* 启动                                                                */
/* ------------------------------------------------------------------ */

async function boot() {
  wireWindowButtons();
  try {
    await loadEnv();
  } catch (e) {
    toast('初始化失败：' + e.message, 'err', 6000);
    return;
  }
  // 启动后自动执行一次扫描
  startScan();
}

boot();