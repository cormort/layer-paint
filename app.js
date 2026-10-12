console.log("APP_JS_LOADED");
// 畫布尺寸是可變的：專案檔帶著自己的尺寸，載入時會一起換掉
let W = 1200, H = 1600;
// 圖層縮圖：跟著畫布比例走，否則非 3:4 的畫布會被壓扁
let TW = 36, TH = 48;
const fitThumbSize = () => {
  const M = 48;
  if (W >= H) { TW = M; TH = Math.max(1, Math.round(M * H / W)); }
  else { TH = M; TW = Math.max(1, Math.round(M * W / H)); }
};
fitThumbSize();
const $ = id => document.getElementById(id);
const wrap = $('wrap');
let layers = [], cur = null, eraser = false, n = 0, undos = [], redos = [];
let tf = null; // 變形中的狀態（覆蓋層一開始就會讀到，所以放最前面）
let picking = false; // 滴管等待點選中
let eCur = null; // 橡皮擦範圍圈：[clientX, clientY, 畫布半徑]
let zsel = null, curZoomOpt = null, mmcv = null, mmview = null, mmbox = null;

// 暫存筆劃層：筆刷畫在這裡，放開時才以「濃度」合成到圖層，避免重疊處變深
const tmp = Object.assign(document.createElement('canvas'), { width: W, height: H });
tmp.style.pointerEvents = 'none';
const tctx = tmp.getContext('2d');
// 預測筆跡層：疊在 tmp 之上，只在落筆期間顯示（見 drawPred）
const pred = Object.assign(document.createElement('canvas'), { width: W, height: H });
pred.style.cssText = 'pointer-events:none;display:none';
const pctx = pred.getContext('2d');

const stage = $('stage'), v = { x: 0, y: 0, s: 1, r: 0 };
// stage 的位置與尺寸只在版面變動時才會改；快取起來，否則每個 coalesced pointer event 都要
// 讀一次 getBoundingClientRect／clientWidth，等於一帧強制同步 layout 幾十次
let sRect = null, sW = 0, sH = 0;
const stageRect = () => {
  if (!sRect) { sRect = stage.getBoundingClientRect(); sW = stage.clientWidth; sH = stage.clientHeight; }
  return sRect;
};
const stageSize = () => { stageRect(); return [sW, sH]; }; // 只在 stageRect() 驗證過後才讀 sW/sH
addEventListener('resize', () => { sRect = null; });
addEventListener('scroll', () => { sRect = null; }, true);
const apply = () => {
  wrap.style.transform = `translate(${v.x}px,${v.y}px) rotate(${v.r}rad) scale(${v.s})`;
  drawGuide();
  updateMinimapView?.();
  updateZoomUi?.();
};
// 畫布座標 ↔ stage 座標（含旋轉），不能再用 getBoundingClientRect 推算
const toStage = (x, y) => { const c = Math.cos(v.r), s = Math.sin(v.r); return [v.x + (x * c - y * s) * v.s, v.y + (x * s + y * c) * v.s]; };
const toCanvas = (cx, cy) => {
  const r = stageRect(), x = cx - r.left - v.x, y = cy - r.top - v.y, c = Math.cos(v.r), s = Math.sin(v.r);
  return [(x * c + y * s) / v.s, (-x * s + y * c) / v.s];
};
// stage 相對座標 (sx, sy) 換算為畫布座標
const stagePtToCanvas = (sx, sy) => {
  const x = sx - v.x, y = sy - v.y, c = Math.cos(v.r), s = Math.sin(v.r);
  return [(x * c + y * s) / v.s, (-x * s + y * c) / v.s];
};
function getFitScale() {
  const w = stage.clientWidth, h = stage.clientHeight;
  return Math.min((w - 40) / W, (h - 40) / H, 2);
}
function fit() {
  const w = stage.clientWidth, h = stage.clientHeight;
  v.s = getFitScale(); v.r = 0;
  v.x = (w - W * v.s) / 2; v.y = (h - H * v.s) / 2; apply();
}
// 縮放到指定比例，保持 clientX, clientY（預設可視區域中心）不動
function zoomTo(targetScale, clientX, clientY) {
  if (clientX == null || clientY == null) {
    const r = stageRect();
    clientX = r.left + stage.clientWidth / 2;
    clientY = r.top + stage.clientHeight / 2;
  }
  const s = Math.min(16, Math.max(0.02, targetScale));
  const k = s / v.s;
  zoomV(clientX, clientY, k);
  apply();
}
// 切換局部細節視角：預設 100%（像素 1:1），若已在 100% 則切換至 200%
function zoomDetail(targetScale = 1.0) {
  if (Math.abs(v.s - targetScale) < 0.05) targetScale = targetScale === 1.0 ? 2.0 : 1.0;
  v.r = 0;
  zoomTo(targetScale);
}
// 以螢幕點 (cx,cy) 為中心縮放。只改 v，不重畫：兩指手勢一次事件會依序縮放、旋轉、平移，
// 每次都 apply() 的話等於把最貴的輔助線重畫做三遍。呼叫端負責收尾 apply()。
function zoomV(cx, cy, k) {
  const r = stageRect(), x = cx - r.left, y = cy - r.top;
  const s = Math.min(16, Math.max(0.02, v.s * k)); k = s / v.s;
  v.x = x - (x - v.x) * k; v.y = y - (y - v.y) * k; v.s = s;
}
// 以螢幕點 (cx,cy) 為中心旋轉畫布（Procreate 式兩指旋轉）。同樣只改 v。
function rotateV(cx, cy, da) {
  const r = stageRect(), x = cx - r.left, y = cy - r.top, c = Math.cos(da), s = Math.sin(da), dx = v.x - x, dy = v.y - y;
  v.x = x + dx * c - dy * s; v.y = y + dx * s + dy * c; v.r += da;
}
// --- 透視輔助線：地平線與消失點可拖曳（座標用畫布像素），畫在 stage 上方的獨立覆蓋層 ---
const guide = { mode: 0, hy: 800, v1: 250, v2: 1000, v3x: 600, v3y: 3200 };
// 兩層覆蓋畫布：輔助線／變形外框一層，橡皮擦游標一層。
// 游標只是跟著筆移動，不該連同最多 144 條透視線一起重畫。
const overlay = () => {
  const c = document.createElement('canvas');
  c.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none';
  stage.append(c); return c;
};
const gcv = overlay(), ecv = overlay();
gcv.id = 'gcv'; ecv.id = 'ecv';
// 依 DPR 配置覆蓋層；尺寸沒變就只清空
function prep(cv) {
  const d = devicePixelRatio || 1, [w, h] = stageSize(), bw = Math.round(w * d), bh = Math.round(h * d), c = cv.getContext('2d');
  if (cv.width !== bw || cv.height !== bh) { cv.width = bw; cv.height = bh; }
  else { c.setTransform(1, 0, 0, 1, 0, 0); c.clearRect(0, 0, bw, bh); }
  return [c, d];
}
const gHandles = () => {
  const h = [{ id: 'hy', x: 40, y: guide.hy }, { id: 'v1', x: guide.v1, y: guide.hy }];
  if (guide.mode > 1) h.push({ id: 'v2', x: guide.v2, y: guide.hy });
  if (guide.mode > 2) h.push({ id: 'v3', x: guide.v3x, y: guide.v3y });
  return h;
};
// 從每個消失點放射 n 條線；ctx 的座標系已是畫布像素
function guideLines(ctx, lw) {
  const n = +$('gn').value, vps = [[guide.v1, guide.hy, '#e33'], [guide.v2, guide.hy, '#2a2'], [guide.v3x, guide.v3y, '#36f']].slice(0, guide.mode === 3 ? 3 : guide.mode === 2 ? 2 : 1);
  ctx.lineWidth = lw; ctx.globalAlpha = .6;
  vps.forEach(([x, y, col]) => {
    ctx.strokeStyle = col; ctx.beginPath();
    for (let k = 0; k < n; k++) { const a = k * Math.PI / n, dx = Math.cos(a) * 8000, dy = Math.sin(a) * 8000; ctx.moveTo(x - dx, y - dy); ctx.lineTo(x + dx, y + dy); }
    ctx.stroke();
  });
  ctx.globalAlpha = 1;
}
function drawGuide() {
  // 沒有輔助線也沒有變形外框時整層收起來：少一個全螢幕合成層，iPad 上每一帧都省
  const active = !!(guide.mode || tf);
  gcv.style.display = active ? '' : 'none';
  if (active) {
    const [c, d] = prep(gcv);
    const cs = Math.cos(v.r) * v.s * d, sn = Math.sin(v.r) * v.s * d, inCanvas = () => c.setTransform(cs, sn, -sn, cs, d * v.x, d * v.y);
    if (guide.mode) {
      c.save(); inCanvas();
      c.beginPath(); c.rect(0, 0, W, H); c.clip();
      guideLines(c, 1.2 / v.s);
      c.restore();
      inCanvas(); c.strokeStyle = '#fc0'; c.setLineDash([8 / v.s, 6 / v.s]); c.lineWidth = 1.5 / v.s;
      c.beginPath(); c.moveTo(-20000, guide.hy); c.lineTo(20000, guide.hy); c.stroke(); c.setLineDash([]);
      c.setTransform(d, 0, 0, d, 0, 0);
      gHandles().forEach(p => { c.beginPath(); c.arc(...toStage(p.x, p.y), 9, 0, 6.283); c.fillStyle = { hy: '#fc0', v1: '#e33', v2: '#2a2', v3: '#36f' }[p.id]; c.fill(); c.strokeStyle = '#fff'; c.lineWidth = 2; c.stroke(); });
    }
    if (tf) { // 變形中的外框
      const { m, src } = tf, hw = src.width / 2, hh = src.height / 2, cr = Math.cos(m.r), sr = Math.sin(m.r);
      const pts = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([a, b]) => toStage(W / 2 + m.x + (a * m.s * m.fx * cr - b * m.s * sr), H / 2 + m.y + (a * m.s * m.fx * sr + b * m.s * cr)));
      c.setTransform(d, 0, 0, d, 0, 0); c.strokeStyle = '#4a7cff'; c.lineWidth = 2; c.setLineDash([6, 4]);
      c.beginPath(); pts.forEach(p => c.lineTo(...p)); c.closePath(); c.stroke(); c.setLineDash([]);
    }
  }
  drawECur();
}
// 筆刷／橡皮擦範圍圈與 Apple Pencil 懸浮感應 (Hover) 預覽
let hoverCur = null; // [clientX, clientY, rad, tilt, az, isPen]
let pencilHoverOn = true;
try { pencilHoverOn = localStorage.getItem('pencil_hover') !== '0'; } catch {}

function drawECur() {
  const isE = eraser && eCur;
  const isH = !eraser && hoverCur && pencilHoverOn && !tf && !picking && !last;
  const active = !!((isE || isH) && !tf && !picking);
  ecv.style.display = active ? '' : 'none'; // 沒在用就不留一個全螢幕合成層
  if (!active) return;
  const [c, d] = prep(ecv);
  const r = stageRect();
  c.setTransform(d, 0, 0, d, 0, 0);

  if (isE) {
    const rad = Math.max(2, eCur[2] * v.s);
    const x = eCur[0] - r.left, y = eCur[1] - r.top;
    c.lineWidth = 1;
    c.beginPath(); c.arc(x, y, rad, 0, 6.283); c.strokeStyle = 'rgba(0,0,0,.65)'; c.stroke();
    c.beginPath(); c.arc(x, y, rad + 1, 0, 6.283); c.strokeStyle = 'rgba(255,255,255,.9)'; c.stroke();
  } else if (isH) {
    const rad = Math.max(2, hoverCur[2] * v.s);
    const x = hoverCur[0] - r.left, y = hoverCur[1] - r.top;
    const t = hoverCur[3] || 0;
    const az = hoverCur[4] || 0;
    const col = $('color').value;

    c.lineWidth = 1.2;
    if (t > 0.08) {
      c.save();
      c.translate(x, y);
      c.rotate(az);
      c.beginPath();
      c.ellipse(0, 0, rad * (1 + 2.2 * t), rad, 0, 0, 6.283);
      c.strokeStyle = 'rgba(0,0,0,.5)'; c.stroke();
      c.beginPath();
      c.ellipse(0, 0, rad * (1 + 2.2 * t) + 1, rad + 1, 0, 0, 6.283);
      c.strokeStyle = col; c.stroke();
      c.restore();
    } else {
      c.beginPath(); c.arc(x, y, rad, 0, 6.283); c.strokeStyle = 'rgba(0,0,0,.5)'; c.stroke();
      c.beginPath(); c.arc(x, y, rad + 1, 0, 6.283); c.strokeStyle = col; c.stroke();
    }
    c.beginPath(); c.arc(x, y, 1.5, 0, 6.283); c.fillStyle = col; c.fill();
  }
}
$('gmode').onchange = e => { guide.mode = +e.target.value; drawGuide(); };
$('gn').oninput = drawGuide;
$('gbake').onclick = () => {
  if (!guide.mode) return;
  addLayer(); cur.name = '透視輔助線'; cur.guide = true;
  guideLines(cur.ctx, 2); list(cur);
};
let gdrag = null;
let sw = 0, sh = 0;
// 視窗大小改變（iPad 旋轉、工具列伸縮）時只保持畫面中心，不重設使用者的縮放平移
addEventListener('resize', () => {
  const w = stage.clientWidth, h = stage.clientHeight;
  v.x += (w - sw) / 2;
  v.y += (h - sh) / 2;
  sw = w;
  sh = h;
  if (!isMobileScreen()) {
    document.body.classList.remove('dock-open');
    const dk = $('dock');
    if (dk) dk.classList.remove('mobile-open');
    const bd = $('dock-backdrop');
    if (bd) bd.classList.remove('active');
  }
  apply();
});

// 行動裝置/手機版抽屜面板 (Drawer) 判斷
const isMobileScreen = () => window.innerWidth <= 768 || (window.innerHeight <= 520 && window.innerWidth <= 950);

// 面板收合狀態要在第一次 fit() 之前套用，否則會先用面板展開的寬度算一次再重算
const UI_HIDE = 'hideui';
try { if (localStorage.getItem(UI_HIDE) === '1') document.body.classList.add(UI_HIDE); } catch {}
fit(); sw = stage.clientWidth; sh = stage.clientHeight;

const setMobileDock = (open) => {
  document.body.classList.toggle('dock-open', open);
  const dk = $('dock');
  if (dk) dk.classList.toggle('mobile-open', open);
  const bd = $('dock-backdrop');
  if (bd) bd.classList.toggle('active', open);
  const b = $('uitog');
  if (b && isMobileScreen()) {
    b.textContent = open ? '收合 ▶' : '◀ 開啟';
    b.title = b.ariaLabel = open ? '收合面板' : '開啟面板';
  }
};

const setUI = (hide, save) => {
  if (isMobileScreen()) {
    setMobileDock(!hide);
    return;
  }
  document.body.classList.toggle(UI_HIDE, hide);
  const b = $('uitog');
  if (b) {
    b.textContent = hide ? '◀ 開啟' : '收合 ▶';
    b.title = b.ariaLabel = hide ? '開啟面板' : '收合面板';
    b.setAttribute('aria-expanded', String(!hide));
  }
  if (save) { try { localStorage.setItem(UI_HIDE, hide ? '1' : '0'); } catch {} }
};

$('uitog').onclick = () => {
  if (isMobileScreen()) {
    const isOpen = document.body.classList.contains('dock-open') || $('dock')?.classList.contains('mobile-open');
    setMobileDock(!isOpen);
  } else {
    setUI(!document.body.classList.contains(UI_HIDE), true);
  }
};

const btnMob = $('btn-mobile-dock');
if (btnMob) {
  btnMob.addEventListener('pointerdown', e => e.stopPropagation());
  btnMob.onclick = e => { e.stopPropagation(); setMobileDock(true); };
}
const btnDkClose = $('btn-dock-close');
if (btnDkClose) {
  btnDkClose.addEventListener('pointerdown', e => e.stopPropagation());
  btnDkClose.onclick = e => { e.stopPropagation(); setMobileDock(false); };
}
const dkBackdrop = $('dock-backdrop');
if (dkBackdrop) {
  dkBackdrop.addEventListener('pointerdown', e => { e.stopPropagation(); setMobileDock(false); });
  dkBackdrop.onclick = e => { e.stopPropagation(); setMobileDock(false); };
}

if (isMobileScreen()) {
  setMobileDock(false);
} else {
  setUI(document.body.classList.contains(UI_HIDE), false);
}
stage.addEventListener('wheel', e => {
  e.preventDefault();
  if (e.ctrlKey || e.metaKey) { zoomV(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.01)); apply(); } // 觸控板捏合 / Ctrl+滾輪
  else {
    // Firefox 的滾輪是「行」為單位，不換算的話一次只平移幾 px
    const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? stageSize()[1] : 1;
    v.x -= e.deltaX * k; v.y -= e.deltaY * k; apply();
  }
}, { passive: false });

function addLayer(fill) {
  const c = Object.assign(document.createElement('canvas'), { width: W, height: H });
  const L = { c, ctx: c.getContext('2d'), name: '圖層 ' + (++n), visible: true, locked: false };
  if (fill) { L.ctx.fillStyle = '#fff'; L.ctx.fillRect(0, 0, W, H); L.name = '背景'; L.bg = true; }
  layers.splice(cur ? layers.indexOf(cur) + 1 : 0, 0, L);
  cur = L; sync();
}
function sync(...dirty) {
  layers.forEach(l => wrap.append(l.c));
  wrap.append(tmp, pred); // 暫存層與預測層永遠在最上面
  list(...dirty);
}
// 縮圖畫布依圖層快取重用：每次 list() 都重建的話，等於每一筆結束都把每層整張重縮一次。
// 傳入的圖層才會重畫縮圖，其餘沿用快取（呼叫端負責在像素變動時把自己傳進來）。
const thumbs = new Map();
// 匯入底圖的 ImageBitmap 佔用的是 GPU/CPU 記憶體，換掉時要明確釋放
const dropImg = L => { if (L && L.img) { L.img.close(); L.img = null; } if (L) L.raw = null; };
const forget = L => { thumbs.delete(L); dropImg(L); };
function list(...dirty) {
  const d = new Set(dirty);
  if ($('lalpha')) $('lalpha').value = (cur.c.style.opacity || 1) * 100;
  if ($('lalpha-val')) $('lalpha-val').textContent = Math.round((cur.c.style.opacity || 1) * 100) + '%';
  if ($('lblend')) $('lblend').value = cur.c.style.mixBlendMode || 'normal';
  if ($('layer-count-badge')) $('layer-count-badge').textContent = `${layers.length} 個圖層`;

  $('list').replaceChildren(...[...layers].reverse().map(l => {
    const row = document.createElement('div');
    row.className = 'layer' + (l === cur ? ' sel' : '') + (l.locked ? ' lock' : '');
    let th = thumbs.get(l);
    if (!th) { th = Object.assign(document.createElement('canvas'), { width: TW, height: TH }); thumbs.set(l, th); d.add(l); }
    if (d.has(l)) { const tc = th.getContext('2d'); tc.clearRect(0, 0, TW, TH); tc.drawImage(l.c, 0, 0, TW, TH); }
    th.style.width = TW + 'px'; th.style.height = TH + 'px';

    const eye = document.createElement('button');
    eye.className = 'lvis' + (l.visible ? '' : ' off');
    eye.textContent = l.visible ? '👁️' : '👁️‍🗨️';
    eye.setAttribute('aria-pressed', l.visible);
    eye.title = l.visible ? '隱藏這一層' : '顯示這一層';
    eye.disabled = !!stop3d;
    eye.onclick = e => { e.stopPropagation(); l.visible = !l.visible; l.c.style.display = l.visible ? '' : 'none'; list(); };

    // 鎖定：保護圖層不被畫到、擦到、清空、變形、合併、刪除
    const lk = document.createElement('button');
    lk.className = 'llock' + (l.locked ? ' on' : '');
    lk.textContent = l.locked ? '🔒' : '🔓';
    lk.title = l.locked ? '解除鎖定' : '鎖定（保護）這一層';
    lk.setAttribute('aria-pressed', !!l.locked);
    lk.onclick = e => { e.stopPropagation(); l.locked = !l.locked; list(); };

    const rm = document.createElement('button'); rm.textContent = '✕'; rm.title = '刪除這一層';
    rm.disabled = layers.length < 2 || !!stop3d;
    rm.onclick = e => { e.stopPropagation(); delLayer(l); };

    const nm = document.createElement('span'); nm.textContent = l.name; nm.title = '雙擊重新命名';
    nm.ondblclick = () => { const t = prompt('圖層名稱', l.name); if (t) { l.name = t; list(); } };

    row.append(eye, th, nm, lk, rm);
    row.onclick = () => { cur = l; list(); };
    return row;
  }));
  updateMinimapThumb?.();
}

// --- 繪圖 ---
let last = null, bb = null;
// 筆劃開始時把圖層複製到 snapC（GPU 端，不做 getImageData）；結束時只裁下筆劃範圍存進復原堆疊
const snapC = Object.assign(document.createElement('canvas'), { width: W, height: H }), snapX = snapC.getContext('2d');
const crop = (src, x, y, w, h) => { const c = Object.assign(document.createElement('canvas'), { width: w, height: h }); c.getContext('2d').drawImage(src, x, y, w, h, 0, 0, w, h); return c; };
// 讀像素一律經過這張 willReadFrequently 的暫存畫布，不要讀圖層自己的 canvas：
// 對圖層 canvas 做整張 getImageData 會讓它之後的每一次落筆慢 50～80 倍，而且不會回復。
const rdC = Object.assign(document.createElement('canvas'), { width: W, height: H });
const rdX = rdC.getContext('2d', { willReadFrequently: true });
const readPx = c => { rdX.clearRect(0, 0, W, H); rdX.drawImage(c, 0, 0); return rdX.getImageData(0, 0, W, H).data; };
// 有內容的實際範圍；整張空白回傳 null。用 Uint32 一次讀 4 byte 比逐 byte 快好幾倍
function alphaBox(c) {
  const u32 = new Uint32Array(readPx(c).buffer);
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++) {
    const row = y * W, end = row + W;
    for (let i = row; i < end; i++) if (u32[i] >>> 24) {
      const x = i - row;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}
const unionBox = (a, b) => {
  if (!a) return b;
  if (!b) return a;
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y), x2 = Math.max(a.x + a.w, b.x + b.w), y2 = Math.max(a.y + a.h, b.y + b.h);
  return { x, y, w: x2 - x, h: y2 - y };
};
const evs = e => { const l = e.getCoalescedEvents?.(); return l?.length ? l : [e]; };
const pos = e => toCanvas(e.clientX, e.clientY);
// --- 寫實筆刷與畫材系統 ---
const PENCIL_HARDNESS = {
  '9H': { flow: .05, po: .90, hard: 1, sp: .12, grainDense: .7,  desc: '極硬極淺' },
  '6H': { flow: .07, po: .88, hard: 1, sp: .12, grainDense: .75, desc: '極淡刻線' },
  '4H': { flow: .10, po: .85, hard: 1, sp: .13, grainDense: .8,  desc: '硬質透視' },
  '2H': { flow: .13, po: .82, hard: 1, sp: .14, grainDense: .85, desc: '淡灰打底' },
  'H':  { flow: .15, po: .80, hard: 1, sp: .14, grainDense: .9,  desc: '淺灰構圖' },
  'F':  { flow: .17, po: .80, hard: 1, sp: .15, grainDense: .95, desc: '堅實線條' },
  'HB': { flow: .20, po: .78, hard: 1, sp: .15, grainDense: 1.0, desc: '標準素描' },
  'B':  { flow: .24, po: .75, hard: 1, sp: .15, grainDense: 1.05, desc: '柔和深灰' },
  '2B': { flow: .30, po: .70, hard: 1, sp: .15, grainDense: 1.1,  desc: '深濃素描' },
  '3B': { flow: .36, po: .65, hard: 1, sp: .15, grainDense: 1.15, desc: '陰影鋪色' },
  '4B': { flow: .44, po: .60, hard: 1, sp: .15, grainDense: 1.2,  desc: '濃黑暗面' },
  '6B': { flow: .54, po: .52, hard: 1, sp: .15, grainDense: 1.3,  desc: '鬆軟炭感' },
  '8B': { flow: .65, po: .45, hard: 1, sp: .15, grainDense: 1.4,  desc: '極濃炭黑' },
  '9B': { flow: .75, po: .40, hard: 1, sp: .15, grainDense: 1.5,  desc: '油墨濃黑' }
};

const PEN_NIBS = {
  'EF':   { label: 'EF 極細',  scale: .4,  pr: .5,  flow: .98, sp: .08, stub: false, flex: false, desc: '0.3mm 極細勾線' },
  'F':    { label: 'F 細尖',   scale: .65, pr: .6,  flow: .98, sp: .08, stub: false, flex: false, desc: '0.5mm 筆記手帳' },
  'M':    { label: 'M 中字',   scale: 1.0, pr: .7,  flow: 1.0, sp: .08, stub: false, flex: false, desc: '0.7mm 流暢書寫' },
  'B':    { label: 'B 太字',   scale: 1.45, pr: .8, flow: 1.0, sp: .08, stub: false, flex: false, desc: '1.0mm 飽滿粗字' },
  'Flex': { label: 'Flex 彈性尖', scale: 1.0, pr: .92, flow: 1.0, sp: .06, stub: false, flex: true,  desc: '彈性壓感書法' },
  'Stub': { label: 'Stub 平尖',  scale: 1.2, pr: .2,  flow: .98, sp: .07, stub: true,  flex: false, desc: '1.5mm 藝術字扁平尖' }
};

// 水彩筆刷款式
const WC_BRUSHES = {
  'round':    { label: '圓頭筆',   scale: 1.0, flow: .12, sp: .10, cap: .75, desc: '紅貂毛經典圓頭筆，帶水痕沉積' },
  'flat':     { label: '平頭扁筆', scale: 1.5, flow: .14, sp: .08, cap: .70, flat: true, desc: '大面積排筆，漸層平塗' },
  'bleed':    { label: '濕畫暈染', scale: 1.3, flow: .07, sp: .08, cap: .60, bleed: true, desc: '高含水量擴散，羽化柔軟渲染' },
  'dry':      { label: '乾擦枯筆', scale: 1.0, flow: .35, sp: .16, cap: .90, dry: true, desc: '乾畫法飛白，粗糙紙紋斑駁肌理' },
  'mop':      { label: '拖把筆',   scale: 1.4, flow: .18, sp: .09, cap: .80, mop: true, desc: '古典蓄水拖把筆，寫意水感運筆' },
  'splatter': { label: '撒鹽噴濺', scale: 1.2, flow: .25, sp: .22, cap: .85, splatter: true, desc: '水彩撒點噴濺，隨機微粒水漬' }
};
let curWcType = 'round';
let wcWetness = 0.65;

const PALETTES = {
  pastel: {
    name: '粉蠟筆',
    tabs: [8, 12, 24, 36],
    colors: {
      8: [
        { c: '#FFFFFF', name: '鈦白' }, { c: '#FFE543', name: '檸檬黃' }, { c: '#E63926', name: '朱紅' },
        { c: '#2853A8', name: '鈷藍' }, { c: '#489E3B', name: '草綠' },   { c: '#6D4327', name: '熟褐' },
        { c: '#1A1A1A', name: '墨黑' }, { c: '#F8C8A0', name: '膚色' }
      ],
      12: [
        { c: '#FFFFFF', name: '鈦白' }, { c: '#FFE543', name: '檸檬黃' }, { c: '#FA7816', name: '鮮橙' },
        { c: '#E63926', name: '朱紅' }, { c: '#8B3A82', name: '玫紫' },   { c: '#56A3E8', name: '天藍' },
        { c: '#2853A8', name: '鈷藍' }, { c: '#489E3B', name: '草綠' },   { c: '#185829', name: '深綠' },
        { c: '#6D4327', name: '熟褐' }, { c: '#1A1A1A', name: '墨黑' },   { c: '#F8C8A0', name: '膚色' }
      ],
      24: [
        { c: '#FFFFFF', name: '鈦白' }, { c: '#FFE543', name: '檸檬黃' }, { c: '#D99B26', name: '土黃' },
        { c: '#FA7816', name: '鮮橙' }, { c: '#F05B48', name: '珊瑚紅' }, { c: '#E63926', name: '朱紅' },
        { c: '#F37299', name: '桃粉' }, { c: '#FDB5C8', name: '櫻花粉' }, { c: '#8B3A82', name: '玫紫' },
        { c: '#82708E', name: '灰紫' }, { c: '#A4D2F5', name: '淺天藍' }, { c: '#56A3E8', name: '天藍' },
        { c: '#2853A8', name: '鈷藍' }, { c: '#1B325F', name: '普魯士藍' }, { c: '#78D5B3', name: '薄荷綠' },
        { c: '#489E3B', name: '草綠' }, { c: '#6B7E2A', name: '橄欖綠' }, { c: '#8AA38B', name: '灰綠' },
        { c: '#185829', name: '深綠' }, { c: '#A34C1F', name: '赭石' },   { c: '#6D4327', name: '熟褐' },
        { c: '#452716', name: '焦茶' }, { c: '#9E9893', name: '暖灰' },   { c: '#1A1A1A', name: '墨黑' }
      ],
      36: [
        { c: '#FFFFFF', name: '鈦白' }, { c: '#FFF2A8', name: '奶黃' },   { c: '#FFE543', name: '檸檬黃' },
        { c: '#F5D6B4', name: '淺杏' }, { c: '#F8C8A0', name: '膚色' },   { c: '#D99B26', name: '土黃' },
        { c: '#FA7816', name: '鮮橙' }, { c: '#F05B48', name: '珊瑚紅' }, { c: '#E63926', name: '朱紅' },
        { c: '#9B111E', name: '絳紅' }, { c: '#F37299', name: '桃粉' },   { c: '#FDB5C8', name: '櫻花粉' },
        { c: '#8B3A82', name: '玫紫' }, { c: '#A898D7', name: '薰衣草' }, { c: '#82708E', name: '灰紫' },
        { c: '#A4D2F5', name: '淺天藍' }, { c: '#56A3E8', name: '天藍' }, { c: '#4D6FAC', name: '矢車菊藍' },
        { c: '#2853A8', name: '鈷藍' }, { c: '#1B325F', name: '普魯士藍' }, { c: '#167288', name: '孔雀青' },
        { c: '#20A39E', name: '湖水綠' }, { c: '#78D5B3', name: '薄荷綠' }, { c: '#489E3B', name: '草綠' },
        { c: '#A8B820', name: '芥末綠' }, { c: '#6B7E2A', name: '橄欖綠' }, { c: '#8AA38B', name: '灰綠' },
        { c: '#185829', name: '深綠' }, { c: '#0F4324', name: '森林綠' }, { c: '#A34C1F', name: '赭石' },
        { c: '#6D4327', name: '熟褐' }, { c: '#452716', name: '焦茶' },   { c: '#9E9893', name: '暖灰' },
        { c: '#6C757D', name: '冷灰' }, { c: '#1A1A1A', name: '墨黑' },   { c: '#0D0E11', name: '碳黑' }
      ]
    }
  },
  marker: {
    name: 'Marker',
    tabs: [8, 12, 24, 36],
    colors: {
      8: [
        { c: '#1A1A1C', name: '100 墨黑' }, { c: '#B2B8BC', name: 'C-3 冷灰3' }, { c: '#BAB2A8', name: 'W-3 暖灰3' },
        { c: '#FDE6D5', name: 'E00 白皙膚' }, { c: '#F98835', name: 'YR04 橙黃' }, { c: '#1C8FD4', name: 'B05 湛藍' },
        { c: '#54AC3E', name: 'G07 碧綠' }, { c: '#D62739', name: 'R29 胭脂' }
      ],
      12: [
        { c: '#1A1A1C', name: '100 墨黑' }, { c: '#B2B8BC', name: 'C-3 冷灰3' }, { c: '#53585D', name: 'C-7 深冷灰' },
        { c: '#BAB2A8', name: 'W-3 暖灰3' }, { c: '#FDE6D5', name: 'E00 白皙膚' }, { c: '#FEDE38', name: 'Y15 檸檬黃' },
        { c: '#F98835', name: 'YR04 橙黃' }, { c: '#D62739', name: 'R29 胭脂' }, { c: '#8D5EA3', name: 'V06 紫丁香' },
        { c: '#1C8FD4', name: 'B05 湛藍' }, { c: '#54AC3E', name: 'G07 碧綠' }, { c: '#5B321E', name: 'E29 焦茶' }
      ],
      24: [
        { c: '#1A1A1C', name: '100 墨黑' }, { c: '#B2B8BC', name: 'C-3 冷灰3' }, { c: '#53585D', name: 'C-7 深冷灰' },
        { c: '#BAB2A8', name: 'W-3 暖灰3' }, { c: '#5C544D', name: 'W-7 深暖灰' }, { c: '#FDE6D5', name: 'E00 白皙膚' },
        { c: '#FCD9BF', name: 'YR00 蜜桃' }, { c: '#FEDE38', name: 'Y15 檸檬黃' }, { c: '#FFCA00', name: 'Y08 太陽黃' },
        { c: '#F98835', name: 'YR04 橙黃' }, { c: '#D62739', name: 'R29 胭脂' }, { c: '#FBCBD9', name: 'RV10 淡粉' },
        { c: '#DC3B6E', name: 'RV29 桃紅' }, { c: '#8D5EA3', name: 'V06 紫丁香' }, { c: '#4A4384', name: 'BV08 藍紫' },
        { c: '#C6E7F8', name: 'B00 冰藍' }, { c: '#1C8FD4', name: 'B05 湛藍' }, { c: '#1B4F9B', name: 'B29 群青' },
        { c: '#009688', name: 'BG49 藍綠' }, { c: '#B7D95C', name: 'YG03 草黃綠' }, { c: '#54AC3E', name: 'G07 碧綠' },
        { c: '#995725', name: 'E37 赭黃' }, { c: '#5B321E', name: 'E29 焦茶' }, { c: '#F0F4F8', name: '0 渲染白' }
      ],
      36: [
        { c: '#1A1A1C', name: '100 墨黑' }, { c: '#E2E5E8', name: 'C-1 淡冷灰' }, { c: '#B2B8BC', name: 'C-3 冷灰3' },
        { c: '#53585D', name: 'C-7 深冷灰' }, { c: '#E8E4DF', name: 'W-1 淡暖灰' }, { c: '#BAB2A8', name: 'W-3 暖灰3' },
        { c: '#5C544D', name: 'W-7 深暖灰' }, { c: '#FDE6D5', name: 'E00 白皙膚' }, { c: '#FCD9BF', name: 'YR00 蜜桃' },
        { c: '#F8A89A', name: 'R02 肉粉' }, { c: '#FEDE38', name: 'Y15 檸檬黃' }, { c: '#FFCA00', name: 'Y08 太陽黃' },
        { c: '#F98835', name: 'YR04 橙黃' }, { c: '#EE6429', name: 'YR68 亮橙' }, { c: '#D62739', name: 'R29 胭脂' },
        { c: '#782136', name: 'R59 酒紅' }, { c: '#FBCBD9', name: 'RV10 淡粉' }, { c: '#DC3B6E', name: 'RV29 桃紅' },
        { c: '#B67B78', name: 'E04 玫瑰褐' }, { c: '#8D5EA3', name: 'V06 紫丁香' }, { c: '#5E2777', name: 'V09 皇家紫' },
        { c: '#4A4384', name: 'BV08 藍紫' }, { c: '#6A6678', name: 'BV25 灰紫' }, { c: '#C6E7F8', name: 'B00 冰藍' },
        { c: '#1C8FD4', name: 'B05 湛藍' }, { c: '#1B4F9B', name: 'B29 群青' }, { c: '#17345B', name: 'B39 普魯士藍' },
        { c: '#D1ECE5', name: 'BG10 薄荷' }, { c: '#009688', name: 'BG49 藍綠' }, { c: '#B7D95C', name: 'YG03 草黃綠' },
        { c: '#54AC3E', name: 'G07 碧綠' }, { c: '#4E7835', name: 'YG67 苔綠' }, { c: '#1C5E3A', name: 'G28 松針綠' },
        { c: '#995725', name: 'E37 赭黃' }, { c: '#5B321E', name: 'E29 焦茶' }, { c: '#F0F4F8', name: '0 渲染白' }
      ]
    }
  },
  acrylic: {
    name: '丙烯馬克筆',
    tabs: [8, 12, 24, 36],
    colors: {
      8: [
        { c: '#FFFFFF', name: '覆蓋白' }, { c: '#111111', name: '曜石黑' }, { c: '#FFEA00', name: '鮮檸黃' },
        { c: '#FF2211', name: '亮朱紅' }, { c: '#0066FF', name: '寶石藍' }, { c: '#00CC44', name: '翠亮綠' },
        { c: '#FF66B2', name: '櫻花粉' }, { c: '#D4AF37', name: '香檳金' }
      ],
      12: [
        { c: '#FFFFFF', name: '覆蓋白' }, { c: '#111111', name: '曜石黑' }, { c: '#FFEA00', name: '鮮檸黃' },
        { c: '#FF7700', name: '甜橙' },   { c: '#FF2211', name: '亮朱紅' }, { c: '#FF66B2', name: '櫻花粉' },
        { c: '#8822BB', name: '葡萄紫' }, { c: '#33B5E5', name: '晴空藍' }, { c: '#0066FF', name: '寶石藍' },
        { c: '#00CC44', name: '翠亮綠' }, { c: '#D4AF37', name: '香檳金' }, { c: '#C0C0C0', name: '白銀' }
      ],
      24: [
        { c: '#FFFFFF', name: '覆蓋白' }, { c: '#111111', name: '曜石黑' }, { c: '#FFEA00', name: '鮮檸黃' },
        { c: '#CCFF00', name: '檸檬青' }, { c: '#FF7700', name: '甜橙' },   { c: '#FF2211', name: '亮朱紅' },
        { c: '#FF726F', name: '珊瑚粉' }, { c: '#FF1493', name: '螢光粉' }, { c: '#FF66B2', name: '櫻花粉' },
        { c: '#B388FF', name: '丁香紫' }, { c: '#8822BB', name: '葡萄紫' }, { c: '#33B5E5', name: '晴空藍' },
        { c: '#0066FF', name: '寶石藍' }, { c: '#0099CC', name: '孔雀藍' }, { c: '#00E5A3', name: '薄荷綠' },
        { c: '#00CC44', name: '翠亮綠' }, { c: '#E1AD01', name: '芥末黃' }, { c: '#FFE4C4', name: '象牙膚' },
        { c: '#8B4513', name: '泥土赭' }, { c: '#5C3A21', name: '咖啡褐' }, { c: '#78909C', name: '冰灰' },
        { c: '#EAFF00', name: '螢光黃' }, { c: '#D4AF37', name: '香檳金' }, { c: '#C0C0C0', name: '白銀' }
      ],
      36: [
        { c: '#FFFFFF', name: '覆蓋白' }, { c: '#111111', name: '曜石黑' }, { c: '#37474F', name: '墨石灰' },
        { c: '#78909C', name: '冰灰' },   { c: '#FFE4C4', name: '象牙膚' }, { c: '#D7CCC8', name: '暖駝' },
        { c: '#FFEA00', name: '鮮檸黃' }, { c: '#EAFF00', name: '螢光黃' }, { c: '#CCFF00', name: '檸檬青' },
        { c: '#E1AD01', name: '芥末黃' }, { c: '#FF7700', name: '甜橙' },   { c: '#FF2211', name: '亮朱紅' },
        { c: '#FF726F', name: '珊瑚粉' }, { c: '#FF1493', name: '螢光粉' }, { c: '#FF66B2', name: '櫻花粉' },
        { c: '#C2185B', name: '玫紅' },   { c: '#8822BB', name: '葡萄紫' }, { c: '#B388FF', name: '丁香紫' },
        { c: '#5C6BC0', name: '矢車菊紫' }, { c: '#4A148C', name: '絳紫' }, { c: '#80D8FF', name: '亮天藍' },
        { c: '#33B5E5', name: '晴空藍' }, { c: '#0099CC', name: '孔雀藍' }, { c: '#0066FF', name: '寶石藍' },
        { c: '#0D47A1', name: '海軍深藍' }, { c: '#00BCD4', name: '綠松石' }, { c: '#00E5A3', name: '薄荷綠' },
        { c: '#00CC44', name: '翠亮綠' }, { c: '#7CB342', name: '蘋果綠' }, { c: '#1B5E20', name: '森林墨綠' },
        { c: '#8B4513', name: '泥土赭' }, { c: '#5C3A21', name: '咖啡褐' }, { c: '#D4AF37', name: '香檳金' },
        { c: '#AA7C11', name: '青銅金' }, { c: '#C0C0C0', name: '白銀' },   { c: '#B76E79', name: '金屬玫瑰' }
      ]
    }
  },
  wc: {
    name: '透明水彩',
    tabs: [12, 24, 36],
    colors: {
      12: [
        { c: '#FFE543', name: '檸檬黃' }, { c: '#FFB81C', name: '鎘黃' },   { c: '#E63926', name: '亮朱紅' },
        { c: '#B31B1B', name: '茜草深紅' }, { c: '#992266', name: '永固玫紫' }, { c: '#1D3C89', name: '群青藍' },
        { c: '#003153', name: '普魯士藍' }, { c: '#188351', name: '翡翠綠' }, { c: '#598527', name: '樹汁綠' },
        { c: '#A66526', name: '生赭' },   { c: '#6D4327', name: '熟褐' },   { c: '#37474F', name: '佩恩灰' }
      ],
      24: [
        { c: '#FAF9F6', name: '象牙白' }, { c: '#FFE543', name: '檸檬黃' }, { c: '#FFB81C', name: '鎘黃' },
        { c: '#F26522', name: '鎘橙' },   { c: '#E63926', name: '亮朱紅' }, { c: '#F05B48', name: '珊瑚紅' },
        { c: '#B31B1B', name: '茜草深紅' }, { c: '#992266', name: '永固玫紫' }, { c: '#5C2D91', name: '歌德紫' },
        { c: '#2853A8', name: '鈷藍' },   { c: '#1D3C89', name: '群青藍' }, { c: '#003153', name: '普魯士藍' },
        { c: '#56A3E8', name: '天藍' },   { c: '#00A896', name: '綠松石' }, { c: '#188351', name: '翡翠綠' },
        { c: '#598527', name: '樹汁綠' }, { c: '#606835', name: '橄欖綠' }, { c: '#2A5A35', name: '虎克綠' },
        { c: '#D99B26', name: '土黃' },   { c: '#A66526', name: '生赭' },   { c: '#8B2500', name: '威尼斯紅' },
        { c: '#6D4327', name: '熟褐' },   { c: '#37474F', name: '佩恩灰' }, { c: '#1A1A1A', name: '象牙黑' }
      ],
      36: [
        { c: '#FAF9F6', name: '象牙白' }, { c: '#FEE180', name: '拿坡里黃' }, { c: '#FFE543', name: '檸檬黃' },
        { c: '#FFB81C', name: '鎘黃' },   { c: '#F26522', name: '鎘橙' },   { c: '#D62828', name: '鎘紅' },
        { c: '#E63926', name: '亮朱紅' }, { c: '#F05B48', name: '珊瑚紅' }, { c: '#D84C74', name: '玫瑰茜紅' },
        { c: '#B31B1B', name: '茜草深紅' }, { c: '#992266', name: '永固玫紫' }, { c: '#6A287E', name: '紫羅蘭' },
        { c: '#5C2D91', name: '歌德紫' }, { c: '#2853A8', name: '鈷藍' },   { c: '#0077B6', name: '蔚藍' },
        { c: '#56A3E8', name: '天藍' },   { c: '#1D3C89', name: '群青藍' }, { c: '#003153', name: '普魯士藍' },
        { c: '#1E293B', name: '靛青' },   { c: '#78D5B3', name: '薄荷青' }, { c: '#00A896', name: '綠松石' },
        { c: '#188351', name: '翡翠綠' }, { c: '#598527', name: '樹汁綠' }, { c: '#606835', name: '橄欖綠' },
        { c: '#2A5A35', name: '虎克綠' }, { c: '#0E3A20', name: '墨綠' },   { c: '#D99B26', name: '土黃' },
        { c: '#A66526', name: '生赭' },   { c: '#82522C', name: '生褐' },   { c: '#8B2500', name: '威尼斯紅' },
        { c: '#6D4327', name: '熟褐' },   { c: '#4A150A', name: '焦赭' },   { c: '#8D877F', name: '暖中灰' },
        { c: '#5C6479', name: '冷灰' },   { c: '#37474F', name: '佩恩灰' }, { c: '#1A1A1A', name: '象牙黑' }
      ]
    }
  },
  cpencil: {
    name: '彩色鉛筆',
    tabs: [12, 24, 36],
    colors: {
      12: [
        { c: '#FAF9F6', name: '象牙白' }, { c: '#FEE135', name: '檸檬黃' }, { c: '#FFB81C', name: '鉻黃' },
        { c: '#E3242B', name: '猩紅' },   { c: '#B31B1B', name: '茜草紅' }, { c: '#6A287E', name: '紫羅蘭' },
        { c: '#68A9D9', name: '淺天藍' }, { c: '#1D3C89', name: '群青藍' }, { c: '#188351', name: '翡翠綠' },
        { c: '#598527', name: '樹汁綠' }, { c: '#7B3F00', name: '熟赭' },   { c: '#212121', name: '象牙黑' }
      ],
      24: [
        { c: '#FAF9F6', name: '象牙白' }, { c: '#F7CBB2', name: '膚粉' },   { c: '#FEE135', name: '檸檬黃' },
        { c: '#FFB81C', name: '鉻黃' },   { c: '#FDBE85', name: '杏黃' },   { c: '#F26522', name: '鎘橙' },
        { c: '#E3242B', name: '猩紅' },   { c: '#B31B1B', name: '茜草紅' }, { c: '#D84C74', name: '玫瑰茜紅' },
        { c: '#967BB6', name: '薰衣草' }, { c: '#6A287E', name: '紫羅蘭' }, { c: '#68A9D9', name: '淺天藍' },
        { c: '#30A39C', name: '綠松石' }, { c: '#1D3C89', name: '群青藍' }, { c: '#264368', name: '靛藍' },
        { c: '#88B04B', name: '蘋果綠' }, { c: '#188351', name: '翡翠綠' }, { c: '#598527', name: '樹汁綠' },
        { c: '#606835', name: '橄欖綠' }, { c: '#82522C', name: '生褐' },   { c: '#7B3F00', name: '熟赭' },
        { c: '#968E85', name: '暖灰III' }, { c: '#70757A', name: '冷灰IV' }, { c: '#212121', name: '象牙黑' }
      ],
      36: [
        { c: '#FAF9F6', name: '象牙白' }, { c: '#F4F0EA', name: '鉛白' },   { c: '#F7CBB2', name: '膚粉' },
        { c: '#FEE135', name: '檸檬黃' }, { c: '#FFDE59', name: '鎘黃' },   { c: '#FFB81C', name: '鉻黃' },
        { c: '#FDBE85', name: '杏黃' },   { c: '#F26522', name: '鎘橙' },   { c: '#F87666', name: '珊瑚紅' },
        { c: '#E3242B', name: '猩紅' },   { c: '#990033', name: '櫻桃紅' }, { c: '#B31B1B', name: '茜草紅' },
        { c: '#D84C74', name: '玫瑰茜紅' }, { c: '#967BB6', name: '薰衣草' }, { c: '#6A287E', name: '紫羅蘭' },
        { c: '#4B0082', name: '帝國紫' }, { c: '#A5D6A7', name: '冰藍' },   { c: '#68A9D9', name: '淺天藍' },
        { c: '#30A39C', name: '綠松石' }, { c: '#1D3C89', name: '群青藍' }, { c: '#003153', name: '普魯士藍' },
        { c: '#264368', name: '靛藍' },   { c: '#88B04B', name: '蘋果綠' }, { c: '#2E8B57', name: '鈷綠' },
        { c: '#188351', name: '翡翠綠' }, { c: '#598527', name: '樹汁綠' }, { c: '#044327', name: '墨玉綠' },
        { c: '#606835', name: '橄欖綠' }, { c: '#82522C', name: '生褐' },   { c: '#7B3F00', name: '熟赭' },
        { c: '#7E2922', name: '威尼斯紅' }, { c: '#652516', name: '焦赭' }, { c: '#968E85', name: '暖灰III' },
        { c: '#70757A', name: '冷灰IV' }, { c: '#404652', name: '佩恩灰' }, { c: '#212121', name: '象牙黑' }
      ]
    }
  }
};

const BRUSHES = {
  // ── 專業數位筆刷 (Digital Studio) ──
  '硬邊圓筆':       { id: 'hard_round', name: '硬邊圓筆', pr: 0, po: 0, hard: 1.0, flow: 1.0, sp: 0.15, cap: 1.0 },
  '柔邊圓筆':       { id: 'soft_round', name: '柔邊圓筆', pr: 0, po: 0, hard: 0.0, flow: 0.35, sp: 0.08, cap: 1.0 },
  '柔邊壓感筆':     { id: 'soft_pressure', name: '柔邊壓感筆', pr: 0.85, po: 0, hard: 0.0, flow: 0.45, sp: 0.06, cap: 1.0 },
  '硬邊壓感濃度筆': { id: 'hard_opacity', name: '硬邊壓感濃度筆', pr: 0.2, po: 0.85, hard: 0.9, flow: 0.8, sp: 0.08, cap: 1.0 },
  '柔邊噴槍':       { id: 'airbrush_soft', name: '柔邊噴槍', pr: 0.4, po: 0.6, hard: 0.0, flow: 0.15, sp: 0.05, cap: 1.0, buildUp: true },
  '扁平書法筆':     { id: 'calligraphic', name: '扁平書法筆', pr: 0.3, hard: 0.85, flow: 0.95, sp: 0.05, cap: 1.0, calligraphic: true, roundness: 0.15, angle: 35 * Math.PI / 180 },
  '粉筆':           { id: 'chalk', name: '粉筆', pr: 0.45, po: 0.5, hard: 0.5, flow: 0.4, sp: 0.1, cap: 0.95, chalk: true, roundness: 0.85 },
  '乾刷排線筆':     { id: 'dry_brush', name: '乾刷排線筆', pr: 0.4, hard: 0.35, flow: 0.45, sp: 0.08, cap: 0.9, dryBrush: true, roundness: 0.75 },
  '點陣噴濺筆':     { id: 'stipple', name: '點陣噴濺筆', pr: 0.5, hard: 0.7, flow: 0.6, sp: 0.45, cap: 1.0, scatter: true, count: 5 },
  '濕邊聚墨水彩':   { id: 'wet_edge', name: '濕邊聚墨水彩', pr: 0.6, hard: 0.2, flow: 0.4, sp: 0.1, cap: 0.85, wetEdge: true },

  // ── 經典手繪媒材 (Natural Media) ──
  '鉛筆':           { id: 'pencil', pr: .25, po: .78, hard: 1, flow: .20, sp: .15, cap: 1, grain: 1, tilt: 1 },
  '彩色鉛筆':       { id: 'cpencil', pr: .32, po: .72, hard: .9, flow: .22, sp: .14, cap: .92, cp: 1, tilt: 1 },
  '鋼筆':           { id: 'pen', pr: .7, hard: 1, flow: 1, sp: .08, cap: 1 },
  '粉蠟筆':         { id: 'pastel', pr: .4, po: .6, hard: .8, flow: .45, sp: .12, cap: .96, pastel: 1, tilt: 1 },
  'Marker':         { id: 'marker', pr: 0, hard: 1, flow: .3, sp: .1, cap: .65, marker: 1 },
  '丙烯馬克筆':     { id: 'acrylic', pr: 0, hard: 1, flow: 1, sp: .1, cap: 1, acrylic: 1 },
  '水彩':           { id: 'wc', pr: .6, flow: .1, sp: .1, cap: .72, wet: 1 },
  '噴槍':           { id: 'air', pr: .5, hard: 0, flow: .15, sp: .1, cap: 1 }
};
BRUSHES['Hard Round'] = BRUSHES['硬邊圓筆'];
BRUSHES['Soft Round'] = BRUSHES['柔邊圓筆'];
BRUSHES['Airbrush'] = BRUSHES['柔邊噴槍'];
BRUSHES['Flat Calligraphic'] = BRUSHES['扁平書法筆'];
BRUSHES['Chalk'] = BRUSHES['粉筆'];
BRUSHES['Dry Brush'] = BRUSHES['乾刷排線筆'];
BRUSHES['Stipple Spatter'] = BRUSHES['點陣噴濺筆'];
BRUSHES['Wet Edge Round'] = BRUSHES['濕邊聚墨水彩'];
BRUSHES['HB 鉛筆'] = BRUSHES['鉛筆'];
BRUSHES['6B 鉛筆'] = BRUSHES['鉛筆'];

let B = BRUSHES['鉛筆'];
let curHardness = 'HB';
let curNib = 'F';
let curPalCounts = { pastel: 24, marker: 24, acrylic: 24, cpencil: 24, wc: 24 };

let eraserSoft = false;
try { eraserSoft = localStorage.getItem('esoft') === '1'; $('esoft').checked = eraserSoft; } catch {}
$('esoft').onchange = e => { eraserSoft = e.target.checked; try { localStorage.setItem('esoft', eraserSoft ? '1' : '0'); } catch {} };
const isSoftErase = () => eraser && eraserSoft;

let eraserAutoRevertTimer = null;
let eraserAutoRevertRaf = null;
let eraserAutoRevertDelay = 2000; // 預設 2.0 秒（更充裕的修飾時間），可切換 1秒 / 2秒 / 3秒 / 5秒 / 關閉
try {
  const ed = localStorage.getItem('eraser_delay');
  if (ed !== null) {
    const val = +ed;
    // 若先前存的是舊版快速設定 (0.5秒 或 1.0秒)，升級至 2.0秒 更寬裕的節奏
    if (val > 0 && val <= 1000) {
      eraserAutoRevertDelay = 2000;
      localStorage.setItem('eraser_delay', '2000');
    } else {
      eraserAutoRevertDelay = val;
    }
  } else {
    localStorage.setItem('eraser_delay', '2000');
  }
} catch {}

const ERASER_DELAYS = [1000, 2000, 3000, 5000, 0];

function cycleEraserDelay() {
  const curIdx = ERASER_DELAYS.indexOf(eraserAutoRevertDelay);
  const nextIdx = (curIdx + 1) % ERASER_DELAYS.length;
  setEraserDelay(ERASER_DELAYS[nextIdx]);
  if (eraser && eraserAutoRevertDelay > 0) scheduleEraserAutoRevert();
}

function stepEraserDelay(dir) {
  const delays = [1000, 2000, 3000, 5000];
  if (eraserAutoRevertDelay === 0) {
    setEraserDelay(dir > 0 ? 1000 : 5000);
  } else {
    let idx = delays.indexOf(eraserAutoRevertDelay);
    if (idx === -1) idx = 1;
    let nextIdx = idx + dir;
    if (nextIdx >= delays.length) nextIdx = delays.length - 1;
    if (nextIdx < 0) nextIdx = 0;
    setEraserDelay(delays[nextIdx]);
  }
  if (eraser && eraserAutoRevertDelay > 0) scheduleEraserAutoRevert();
}

function setEraserDelay(ms) {
  eraserAutoRevertDelay = ms;
  try { localStorage.setItem('eraser_delay', String(ms)); } catch {}
  updateEraserDelayUi();
  cancelEraserAutoRevert();
}

function updateEraserDelayUi() {
  $('eraser-delay-seg')?.querySelectorAll('button').forEach(b => {
    b.classList.toggle('on', +b.dataset.delay === eraserAutoRevertDelay);
  });
  const badge = $('eraser-delay-badge');
  if (badge) {
    badge.textContent = eraserAutoRevertDelay === 0 ? '關閉' : `${eraserAutoRevertDelay / 1000}s`;
    badge.title = eraserAutoRevertDelay === 0 ? '自動切換已關閉（點擊啟用）' : `擦完 ${eraserAutoRevertDelay / 1000} 秒後切換回筆刷（點擊調整）`;
  }
}

function cancelEraserAutoRevert() {
  if (eraserAutoRevertTimer) {
    clearTimeout(eraserAutoRevertTimer);
    eraserAutoRevertTimer = null;
  }
  if (eraserAutoRevertRaf) {
    cancelAnimationFrame(eraserAutoRevertRaf);
    eraserAutoRevertRaf = null;
  }
  const toast = $('eraser-toast');
  if (toast) toast.style.display = 'none';
}

function scheduleEraserAutoRevert() {
  cancelEraserAutoRevert();
  if (!eraser || eraserAutoRevertDelay <= 0) return;

  const ms = eraserAutoRevertDelay;
  const toast = $('eraser-toast');
  const prog = $('et-progress');
  const txt = $('et-text');
  if (toast) {
    toast.style.display = 'block';
    if (txt) txt.textContent = (ms / 1000).toFixed(1) + ' 秒後切換回筆刷';
  }

  const start = performance.now();
  function tick(now) {
    const elapsed = now - start;
    const remain = Math.max(0, ms - elapsed);
    if (prog) prog.style.transform = `scaleX(${remain / ms})`;
    if (remain > 0) {
      eraserAutoRevertRaf = requestAnimationFrame(tick);
    }
  }
  eraserAutoRevertRaf = requestAnimationFrame(tick);

  eraserAutoRevertTimer = setTimeout(() => {
    eraserAutoRevertTimer = null;
    cancelEraserAutoRevert();
    setEraser(false);
  }, ms);
}

function setEraser(state) {
  cancelEraserAutoRevert();
  eraser = !!state;
  if (!eraser) eCur = null;
  toolUi();
  drawECur();
}
function ensureBrushMode() {
  cancelEraserAutoRevert();
  if (eraser) setEraser(false);
}

const BRUSH_CATEGORIES = [
  {
    group: '數位繪圖 (Digital Studio)',
    items: ['硬邊圓筆', '柔邊圓筆', '柔邊壓感筆', '硬邊壓感濃度筆', '柔邊噴槍', '扁平書法筆', '粉筆', '乾刷排線筆', '點陣噴濺筆', '濕邊聚墨水彩']
  },
  {
    group: '手繪媒材 (Natural Media)',
    items: ['鉛筆', '彩色鉛筆', '鋼筆', '粉蠟筆', 'Marker', '丙烯馬克筆', '水彩']
  }
];

function initBrushSelector() {
  const sel = $('bsel');
  if (!sel) return;
  sel.innerHTML = '';
  BRUSH_CATEGORIES.forEach(cat => {
    const grp = document.createElement('optgroup');
    grp.label = cat.group;
    cat.items.forEach(k => grp.appendChild(new Option(k, k)));
    sel.appendChild(grp);
  });
  sel.value = '鉛筆';
}
initBrushSelector();

$('bsel').onchange = e => {
  ensureBrushMode();
  B = BRUSHES[e.target.value] || BRUSHES['鉛筆'];
  updateBrushSubpanels();
};

let pressureCurve = 1.0; // 壓感曲線 (0.75: 輕柔, 1.0: 標準, 1.35: 紮實)
try {
  const pc = localStorage.getItem('pressure_curve');
  if (pc) pressureCurve = +pc;
} catch {}

const penPressure = e => {
  if (e.pointerType !== 'pen') return 0.5;
  const raw = e.pressure || 0.5;
  return Math.pow(raw, pressureCurve);
};

const width = e => {
  const z = +$('size').value;
  const pen = e.pointerType === 'pen';
  const prs = pen ? penPressure(e) : 0.5;
  if (B.id === 'pen') {
    const nib = PEN_NIBS[curNib] || PEN_NIBS['F'];
    if (nib.flex) {
      return z * nib.scale * (pen ? (0.2 + 2.2 * Math.pow(prs, 1.4)) : 1);
    }
    return z * nib.scale * (pen ? (1 - nib.pr + nib.pr * prs) : 1);
  }
  if (B.id === 'wc' || B.wet) {
    const wcb = WC_BRUSHES[curWcType] || WC_BRUSHES['round'];
    return z * wcb.scale * (pen ? (1 - B.pr + B.pr * prs) : 1);
  }
  return pen ? z * (1 - B.pr + B.pr * prs) : z;
};

const tiltOf = e => {
  let t;
  if (e.altitudeAngle != null) {
    t = 1 - e.altitudeAngle / (Math.PI / 2); // 0 (直立) ~ 1 (貼平)
  } else {
    t = Math.hypot(e.tiltX || 0, e.tiltY || 0) / 90;
  }
  // Apple Pencil 從 ~55度 (t > 0.35) 起平滑過渡到側鋒素描
  return Math.min(1, Math.max(0, (t - .35) / .55));
};

// 紋理生成
const pencilGrains = {};
function pencilGrain(col, hardKey = 'HB') {
  const hInfo = PENCIL_HARDNESS[hardKey] || PENCIL_HARDNESS['HB'];
  const key = col + '_' + hardKey;
  if (!pencilGrains[key]) {
    const c = Object.assign(document.createElement('canvas'), { width: 128, height: 128 });
    const x = c.getContext('2d'), d = x.createImageData(128, 128);
    const dense = hInfo.grainDense || 1.0;
    const thresh = Math.max(0.1, 1.45 - dense * 0.45);
    for (let i = 0; i < d.data.length; i += 4) {
      const n = Math.random() * 1.5;
      d.data[i + 3] = n > thresh ? Math.min(255, (n - thresh) * 255 * dense) : 0;
    }
    x.putImageData(d, 0, 0);
    const patC = Object.assign(document.createElement('canvas'), { width: 128, height: 128 });
    const px = patC.getContext('2d');
    px.fillStyle = col; px.fillRect(0, 0, 128, 128);
    px.globalCompositeOperation = 'destination-in';
    px.drawImage(c, 0, 0);
    pencilGrains[key] = px.createPattern(patC, 'repeat');
  }
  return pencilGrains[key];
}

const cpGrains = {};
function cpGrain(col) {
  if (!cpGrains[col]) {
    const c = Object.assign(document.createElement('canvas'), { width: 128, height: 128 });
    const x = c.getContext('2d'), d = x.createImageData(128, 128);
    for (let i = 0; i < d.data.length; i += 4) {
      const n = Math.random();
      d.data[i + 3] = n > 0.38 ? (n - 0.38) * 210 : 0;
    }
    x.putImageData(d, 0, 0);
    const patC = Object.assign(document.createElement('canvas'), { width: 128, height: 128 });
    const px = patC.getContext('2d');
    px.fillStyle = col; px.fillRect(0, 0, 128, 128);
    px.globalCompositeOperation = 'destination-in';
    px.drawImage(c, 0, 0);
    cpGrains[col] = px.createPattern(patC, 'repeat');
  }
  return cpGrains[col];
}

const pastelGrains = {};
function pastelGrain(col) {
  if (!pastelGrains[col]) {
    const c = Object.assign(document.createElement('canvas'), { width: 128, height: 128 });
    const x = c.getContext('2d'), d = x.createImageData(128, 128);
    for (let i = 0; i < d.data.length; i += 4) {
      const n = Math.random();
      d.data[i + 3] = n > 0.28 ? Math.min(255, (n - 0.15) * 240) : 0;
    }
    x.putImageData(d, 0, 0);
    const patC = Object.assign(document.createElement('canvas'), { width: 128, height: 128 });
    const px = patC.getContext('2d');
    px.fillStyle = col; px.fillRect(0, 0, 128, 128);
    px.globalCompositeOperation = 'destination-in';
    px.drawImage(c, 0, 0);
    pastelGrains[col] = px.createPattern(patC, 'repeat');
  }
  return pastelGrains[col];
}

const chalkGrains = {};
function chalkGrain(col) {
  if (!chalkGrains[col]) {
    const c = Object.assign(document.createElement('canvas'), { width: 128, height: 128 });
    const x = c.getContext('2d'), d = x.createImageData(128, 128);
    for (let py = 0; py < 128; py++) {
      for (let px = 0; px < 128; px++) {
        const i = (py * 128 + px) * 4;
        const weave = Math.sin(px * 0.45) * Math.cos(py * 0.45);
        const noise = Math.random();
        const val = 0.5 * noise + 0.5 * (weave * 0.5 + 0.5);
        d.data[i + 3] = val > 0.38 ? Math.min(255, (val - 0.25) * 320) : 0;
      }
    }
    x.putImageData(d, 0, 0);
    const patC = Object.assign(document.createElement('canvas'), { width: 128, height: 128 });
    const pctx = patC.getContext('2d');
    pctx.fillStyle = col; pctx.fillRect(0, 0, 128, 128);
    pctx.globalCompositeOperation = 'destination-in';
    pctx.drawImage(c, 0, 0);
    chalkGrains[col] = pctx.createPattern(patC, 'repeat');
  }
  return chalkGrains[col];
}

const dryHatchGrains = {};
function dryHatchGrain(col) {
  if (!dryHatchGrains[col]) {
    const c = Object.assign(document.createElement('canvas'), { width: 128, height: 128 });
    const x = c.getContext('2d');
    x.fillStyle = 'rgba(0,0,0,0)';
    x.fillRect(0, 0, 128, 128);
    x.strokeStyle = '#000';
    for (let i = -128; i < 256; i += 3 + Math.random() * 4) {
      x.lineWidth = 0.8 + Math.random() * 1.8;
      x.globalAlpha = 0.2 + Math.random() * 0.7;
      x.beginPath();
      x.moveTo(i, 0);
      x.lineTo(i + 128, 128);
      x.stroke();
    }
    const patC = Object.assign(document.createElement('canvas'), { width: 128, height: 128 });
    const pctx = patC.getContext('2d');
    pctx.fillStyle = col; pctx.fillRect(0, 0, 128, 128);
    pctx.globalCompositeOperation = 'destination-in';
    pctx.drawImage(c, 0, 0);
    dryHatchGrains[col] = pctx.createPattern(patC, 'repeat');
  }
  return dryHatchGrains[col];
}

function renderHardnessBar() {
  const bar = $('hardness-bar');
  if (!bar) return;
  bar.innerHTML = '';
  const list = ['9H', '6H', '4H', '2H', 'H', 'F', 'HB', 'B', '2B', '3B', '4B', '6B', '8B', '9B'];
  list.forEach(h => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'hardness-btn' + (h === curHardness ? ' on' : '');
    btn.textContent = h;
    btn.title = `${h} 鉛筆（${PENCIL_HARDNESS[h].desc}）`;
    btn.onclick = () => {
      ensureBrushMode();
      curHardness = h;
      bar.querySelectorAll('.hardness-btn').forEach(b => b.classList.toggle('on', b.textContent === h));
      if (B.id === 'pencil') {
        const info = PENCIL_HARDNESS[h];
        B.flow = info.flow;
        B.po = info.po;
      }
    };
    bar.append(btn);
  });
}

function renderNibBar() {
  const bar = $('nib-bar');
  if (!bar) return;
  bar.innerHTML = '';
  Object.entries(PEN_NIBS).forEach(([key, info]) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'nib-btn' + (key === curNib ? ' on' : '');
    btn.textContent = info.label;
    btn.title = `${info.label}：${info.desc}`;
    btn.onclick = () => {
      ensureBrushMode();
      curNib = key;
      bar.querySelectorAll('.nib-btn').forEach((b, i) => b.classList.toggle('on', Object.keys(PEN_NIBS)[i] === key));
    };
    bar.append(btn);
  });
}

function renderPalette(palKey) {
  const data = PALETTES[palKey];
  if (!data || !$('palette-grid')) return;
  $('palette-title').textContent = data.name + '色盒';

  const tabs = $('palette-tabs');
  tabs.innerHTML = '';
  const activeCount = curPalCounts[palKey] || data.tabs[1] || data.tabs[0];
  data.tabs.forEach(count => {
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = 'palette-tab' + (count === activeCount ? ' on' : '');
    tab.textContent = `${count}色`;
    tab.onclick = () => {
      ensureBrushMode();
      curPalCounts[palKey] = count;
      renderPalette(palKey);
    };
    tabs.append(tab);
  });

  const grid = $('palette-grid');
  grid.innerHTML = '';
  const colors = data.colors[activeCount] || data.colors[data.tabs[0]];
  const curCol = $('color').value.toLowerCase();
  colors.forEach(({ c, name }) => {
    const sw = document.createElement('div');
    sw.className = 'swatch' + (c.toLowerCase() === curCol ? ' on' : '');
    sw.style.backgroundColor = c;
    sw.title = `${name} (${c})`;
    if (c === '#FFFFFF' || c === '#FAF9F6' || c === '#FFF2A8' || c === '#F0F4F8') {
      sw.classList.add('light-border');
    }
    sw.onclick = () => {
      ensureBrushMode();
      $('color').value = c;
      grid.querySelectorAll('.swatch').forEach(s => s.classList.remove('on'));
      sw.classList.add('on');
    };
    grid.append(sw);
  });
}

function renderWcTypesBar() {
  const bar = $('wc-types-bar');
  if (!bar) return;
  bar.innerHTML = '';
  Object.entries(WC_BRUSHES).forEach(([key, info]) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'wc-btn' + (key === curWcType ? ' on' : '');
    btn.textContent = info.label;
    btn.title = `${info.label}：${info.desc}`;
    btn.onclick = () => {
      ensureBrushMode();
      curWcType = key;
      bar.querySelectorAll('.wc-btn').forEach((b, i) => b.classList.toggle('on', Object.keys(WC_BRUSHES)[i] === key));
      if (B.id === 'wc' || B.wet) {
        B.cap = info.cap;
      }
    };
    bar.append(btn);
  });

  if ($('wc-wet')) {
    $('wc-wet').value = Math.round(wcWetness * 100);
    if ($('wc-wet-val')) $('wc-wet-val').textContent = `${Math.round(wcWetness * 100)}%`;
    $('wc-wet').oninput = e => {
      wcWetness = e.target.value / 100;
      if ($('wc-wet-val')) $('wc-wet-val').textContent = `${e.target.value}%`;
    };
  }
}

function updateBrushSubpanels() {
  const bVal = $('bsel').value;
  const brush = BRUSHES[bVal] || BRUSHES['鉛筆'];
  B = brush;

  const isPencil = brush.id === 'pencil';
  if ($('sub-pencil')) $('sub-pencil').style.display = isPencil ? '' : 'none';

  const isPen = brush.id === 'pen';
  if ($('sub-pen')) $('sub-pen').style.display = isPen ? '' : 'none';

  const isWc = brush.id === 'wc' || !!brush.wet;
  if ($('sub-wc')) $('sub-wc').style.display = isWc ? '' : 'none';

  const palKey = brush.id === 'pastel' ? 'pastel'
               : brush.id === 'marker' ? 'marker'
               : brush.id === 'acrylic' ? 'acrylic'
               : brush.id === 'cpencil' ? 'cpencil'
               : isWc ? 'wc'
               : null;
  const isPal = !!palKey;
  if ($('sub-palette')) {
    $('sub-palette').style.display = isPal ? '' : 'none';
    if (isPal) renderPalette(palKey);
  }

  // 專業數位筆刷子面板
  const isStudio = ['hard_round', 'soft_round', 'soft_pressure', 'hard_opacity', 'airbrush_soft', 'calligraphic', 'chalk', 'dry_brush', 'stipple', 'wet_edge'].includes(brush.id);
  if ($('sub-studio')) {
    $('sub-studio').style.display = isStudio ? '' : 'none';
    if (isStudio) {
      if ($('studio-brush-label')) $('studio-brush-label').textContent = `${brush.name || bVal} 特性微調`;
      const hasHard = brush.hard != null && !brush.calligraphic && !brush.scatter;
      if ($('studio-ctrl-hardness')) {
        $('studio-ctrl-hardness').style.display = hasHard ? '' : 'none';
        if (hasHard) {
          $('studio-hard').value = Math.round(brush.hard * 100);
          $('studio-hard-val').textContent = Math.round(brush.hard * 100) + '%';
        }
      }
      const hasAngle = !!brush.calligraphic;
      if ($('studio-ctrl-angle')) {
        $('studio-ctrl-angle').style.display = hasAngle ? '' : 'none';
        if (hasAngle) {
          const deg = Math.round((brush.angle || 0) * 180 / Math.PI);
          $('studio-angle').value = deg;
          $('studio-angle-val').textContent = deg + '°';
        }
      }
      const hasScatter = !!brush.scatter;
      if ($('studio-ctrl-scatter')) {
        $('studio-ctrl-scatter').style.display = hasScatter ? '' : 'none';
        if (hasScatter) {
          $('studio-scatter').value = brush.count || 5;
          $('studio-scatter-val').textContent = (brush.count || 5) + '顆';
        }
      }
    }
  }
}

if ($('studio-hard')) {
  $('studio-hard').oninput = e => {
    B.hard = e.target.value / 100;
    if ($('studio-hard-val')) $('studio-hard-val').textContent = e.target.value + '%';
  };
}
if ($('studio-angle')) {
  $('studio-angle').oninput = e => {
    B.angle = e.target.value * Math.PI / 180;
    if ($('studio-angle-val')) $('studio-angle-val').textContent = e.target.value + '°';
  };
}
if ($('studio-scatter')) {
  $('studio-scatter').oninput = e => {
    B.count = +e.target.value;
    if ($('studio-scatter-val')) $('studio-scatter-val').textContent = e.target.value + '顆';
  };
}

$('color').oninput = e => {
  ensureBrushMode();
  const hex = e.target.value.toLowerCase();
  $('palette-grid')?.querySelectorAll('.swatch').forEach(s => {
    s.classList.toggle('on', s.title.toLowerCase().includes(hex));
  });
};
$('color').onclick = () => ensureBrushMode();

// --- 自訂筆尖：把一張圖當印章蓋（例如 remove-bg 切出來的素材 PNG）---
// 正規化到 TIP 見方（保持長寬比、置中），可選用目前顏色著色；依 (是否保留原色, 顏色) 快取
const TIP = 256;
let tipImg = null, tipCv = null, tipKey = null;
function tipOf(col) {
  const raw = $('tipraw').checked ? 'r' : 'c', key = raw + col;
  if (key === tipKey && tipCv) return tipCv;
  const c = Object.assign(document.createElement('canvas'), { width: TIP, height: TIP }), x = c.getContext('2d');
  const k = Math.min(TIP / tipImg.width, TIP / tipImg.height), w = tipImg.width * k, h = tipImg.height * k;
  x.drawImage(tipImg, (TIP - w) / 2, (TIP - h) / 2, w, h);
  if (raw === 'c') { x.globalCompositeOperation = 'source-in'; x.fillStyle = col; x.fillRect(0, 0, TIP, TIP); }
  tipCv = c; tipKey = key;
  return c;
}
function setTip(img, name) {
  if (tipImg?.close) tipImg.close();
  tipImg = img; tipCv = tipKey = null;
  $('tipimp').textContent = img ? '筆尖：' + name.slice(0, 12) : '匯入筆尖';
  $('tipimp').classList.toggle('on', !!img);
  $('tipclr').disabled = !img;
}
$('tipimp').onclick = () => { ensureBrushMode(); $('tipf').click(); };
$('tipclr').onclick = () => { ensureBrushMode(); setTip(null, ''); };
$('tipraw').onchange = () => { tipCv = tipKey = null; };
$('tipf').onchange = async e => {
  const f = e.target.files[0]; e.target.value = ''; if (!f) return;
  const img = await createImageBitmap(f).catch(() => null);
  if (!img) return alert('無法讀取這個圖片');
  setTip(img, f.name);
};

// 水彩：顏料積在紙紋凹陷處。紋理固定在「畫布座標」（跟鉛筆紙紋同一個原理），所以筆印再怎麼
// 重疊都不會被抹平——用「每顆筆印一張圖」的做法在密集筆劃下一定會糊成一片平的（實測過）。
// 真正的水彩流體模擬做不到，但顆粒＋低濃度堆疊＋濕邊是讓人一眼認出水彩的主要線索。
const WC_T = 128;
const wcNoise = (() => {
  const c = Object.assign(document.createElement('canvas'), { width: WC_T, height: WC_T }), x = c.getContext('2d');
  for (let i = 0; i < 240; i++) {
    const px = Math.random() * WC_T, py = Math.random() * WC_T, pr = 3 + Math.random() * 8, a = (.3 + Math.random() * .5).toFixed(2);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) { // 畫九宮格讓圖樣可以無縫並排
      const g = x.createRadialGradient(px + dx * WC_T, py + dy * WC_T, 0, px + dx * WC_T, py + dy * WC_T, pr);
      g.addColorStop(0, 'rgba(0,0,0,' + a + ')'); g.addColorStop(1, 'rgba(0,0,0,0)');
      x.fillStyle = g; x.beginPath(); x.arc(px + dx * WC_T, py + dy * WC_T, pr, 0, 6.283); x.fill();
    }
  }
  return c;
})();
let wcCol = null, wcPat = null;
function wcGrain(col) {
  if (col !== wcCol || !wcPat) {
    const c = Object.assign(document.createElement('canvas'), { width: WC_T, height: WC_T }), x = c.getContext('2d');
    x.fillStyle = col; x.fillRect(0, 0, WC_T, WC_T);
    x.globalCompositeOperation = 'destination-out'; x.drawImage(wcNoise, 0, 0); // 挖洞＝顏料沒沉積的地方
    wcPat = x.createPattern(c, 'repeat'); wcCol = col;
  }
  return wcPat;
}

const dryWcGrains = {};
function dryWcGrain(col) {
  if (!dryWcGrains[col]) {
    const c = Object.assign(document.createElement('canvas'), { width: 128, height: 128 });
    const x = c.getContext('2d'), d = x.createImageData(128, 128);
    for (let i = 0; i < d.data.length; i += 4) {
      const n = Math.random();
      d.data[i + 3] = n > 0.72 ? Math.min(255, (n - 0.72) * 850) : 0;
    }
    x.putImageData(d, 0, 0);
    const patC = Object.assign(document.createElement('canvas'), { width: 128, height: 128 });
    const px = patC.getContext('2d');
    px.fillStyle = col; px.fillRect(0, 0, 128, 128);
    px.globalCompositeOperation = 'destination-in';
    px.drawImage(c, 0, 0);
    dryWcGrains[col] = px.createPattern(patC, 'repeat');
  }
  return dryWcGrains[col];
}

let rest = 0;
// col 由 draw() 一次讀進來：input[type=color].value 每讀一次都要做值正規化，不該每顆筆印讀
function stamp(c, col, x, y, r, a, t = 0, az = 0) {
  c.globalAlpha = a;
  if (tipImg) { c.drawImage(tipOf(col), x - r, y - r, r * 2, r * 2); return; } // 筆尖圖自帶紋理
  if (eraser && !eraserSoft) {
    c.fillStyle = col;
    c.beginPath(); c.arc(x, y, r, 0, 6.283); c.fill();
    return;
  }
  // 鋼筆平尖（Stub）
  if (B.id === 'pen' && PEN_NIBS[curNib]?.stub) {
    c.fillStyle = col;
    c.beginPath();
    c.ellipse(x, y, r * 1.8, Math.max(1, r * 0.45), -0.75, 0, 6.283);
    c.fill();
    return;
  }
  // Marker 扁平斜筆頭
  if (B.marker) {
    c.fillStyle = col;
    c.beginPath();
    c.ellipse(x, y, r * 1.4, Math.max(1.5, r * 0.7), -0.6, 0, 6.283);
    c.fill();
    return;
  }
  // 丙烯馬克筆高遮蓋飽和啞光
  if (B.acrylic) {
    c.fillStyle = col;
    c.beginPath(); c.arc(x, y, r, 0, 6.283); c.fill();
    return;
  }
  // 水彩筆型處理
  if (B.wet || B.id === 'wc') {
    const wcb = WC_BRUSHES[curWcType] || WC_BRUSHES['round'];
    if (wcb.splatter) {
      c.fillStyle = wcGrain(col);
      const count = 3 + Math.floor(Math.random() * 5);
      for (let s = 0; s < count; s++) {
        const ang = Math.random() * 6.283;
        const dist = Math.random() * r * 1.4;
        const srad = Math.max(0.8, (0.08 + Math.random() * 0.32) * r);
        c.beginPath();
        c.arc(x + Math.cos(ang) * dist, y + Math.sin(ang) * dist, srad, 0, 6.283);
        c.fill();
      }
      return;
    }
    if (wcb.dry) {
      c.fillStyle = dryWcGrain(col);
      c.beginPath(); c.arc(x, y, r, 0, 6.283); c.fill();
      return;
    }
    if (wcb.flat) {
      c.fillStyle = wcGrain(col);
      c.beginPath();
      c.ellipse(x, y, r * 1.5, Math.max(1.2, r * 0.55), -0.6, 0, 6.283);
      c.fill();
      return;
    }
    if (wcb.bleed) {
      const bleedR = r * (1 + 0.5 * wcWetness);
      const g = c.createRadialGradient(x, y, r * 0.15, x, y, bleedR);
      g.addColorStop(0, col);
      g.addColorStop(0.55, col);
      g.addColorStop(1, col + '00');
      c.fillStyle = g;
      c.beginPath(); c.arc(x, y, bleedR, 0, 6.283); c.fill();
      return;
    }
    if (wcb.mop) {
      c.fillStyle = wcGrain(col);
      const ox = Math.sin(x * 0.08) * r * 0.18;
      const oy = Math.cos(y * 0.08) * r * 0.18;
      c.beginPath();
      c.arc(x + ox, y + oy, r * (0.95 + 0.15 * Math.sin((x + y) * 0.05)), 0, 6.283);
      c.fill();
      return;
    }
    c.fillStyle = wcGrain(col);
    if (t > 0.08) {
      c.save(); c.translate(x, y); c.rotate(az || 0);
      c.beginPath(); c.ellipse(0, 0, r * (1 + 2 * t), r, 0, 0, 6.283); c.fill();
      if (wcWetness > 0.35) {
        c.strokeStyle = col; c.globalAlpha = a * 0.35 * wcWetness;
        c.lineWidth = Math.max(1, r * 0.12); c.stroke();
      }
      c.restore();
    } else {
      c.beginPath(); c.arc(x, y, r, 0, 6.283); c.fill();
      if (wcWetness > 0.35) {
        c.strokeStyle = col;
        c.globalAlpha = a * 0.35 * wcWetness;
        c.lineWidth = Math.max(1, r * 0.12);
        c.stroke();
        c.globalAlpha = a;
      }
    }
    return;
  }
  // 扁平書法平尖 (Calligraphic Chisel)
  if (B.calligraphic) {
    c.fillStyle = col;
    c.save();
    c.translate(x, y);
    c.rotate(B.angle || (35 * Math.PI / 180));
    c.beginPath();
    c.ellipse(0, 0, r * 1.5, Math.max(1, r * (B.roundness || 0.15)), 0, 0, 6.283);
    c.fill();
    c.restore();
    return;
  }

  // 點陣噴濺筆 (Stipple Spatter)
  if (B.scatter) {
    c.fillStyle = col;
    const cnt = B.count || 5;
    for (let s = 0; s < cnt; s++) {
      const dist = (Math.random() * 0.8 + 0.2) * r * 2.2;
      const ang = Math.random() * 6.283;
      const srad = Math.max(0.6, r * (0.08 + Math.random() * 0.28));
      c.beginPath();
      c.arc(x + Math.cos(ang) * dist, y + Math.sin(ang) * dist, srad, 0, 6.283);
      c.fill();
    }
    return;
  }

  // 濕邊聚墨水彩 (Wet Edge Round)
  if (B.wetEdge) {
    const g = c.createRadialGradient(x, y, r * 0.1, x, y, r);
    g.addColorStop(0, col);
    g.addColorStop(0.65, col);
    g.addColorStop(0.9, col);
    g.addColorStop(1, col + '00');
    c.fillStyle = g;
    c.beginPath(); c.arc(x, y, r, 0, 6.283); c.fill();
    c.strokeStyle = col;
    c.lineWidth = Math.max(1, r * 0.18);
    c.globalAlpha = a * 0.55;
    c.stroke();
    c.globalAlpha = a;
    return;
  }

  if (B.chalk) c.fillStyle = chalkGrain(col);
  else if (B.dryBrush) c.fillStyle = dryHatchGrain(col);
  else if (B.pastel) c.fillStyle = pastelGrain(col);
  else if (B.cp) c.fillStyle = cpGrain(col);
  else if (B.grain) c.fillStyle = pencilGrain(col, curHardness);
  else if (B.hard < 1) {
    const g = c.createRadialGradient(x, y, r * B.hard, x, y, r);
    g.addColorStop(0, col); g.addColorStop(1, col + '00');
    c.fillStyle = g;
  } else c.fillStyle = col;

  if (t > 0.08) {
    c.save();
    c.translate(x, y);
    c.rotate(az || 0);
    c.beginPath();
    c.ellipse(0, 0, r * (1 + 2.2 * t), r, 0, 0, 6.283);
    c.fill();
    c.restore();
  } else {
    c.beginPath(); c.arc(x, y, r, 0, 6.283); c.fill();
  }
}
// 筆刷畫在暫存層；橡皮擦用同一支筆刷直接從圖層擦掉
function draw(a, b, e) {
  const soft = isSoftErase();
  const pen = e.pointerType === 'pen', t = (!eraser || soft) && B.tilt && pen ? tiltOf(e) : 0;
  const az = pen ? (e.azimuthAngle || 0) : 0;
  const w = width(e) * (1 + 3 * t), m = w / 2 + 2;
  const curFlow = B.id === 'pencil' ? (PENCIL_HARDNESS[curHardness]?.flow || B.flow)
                : (B.id === 'wc' || B.wet) ? ((WC_BRUSHES[curWcType]?.flow || B.flow) * (1.3 - 0.5 * wcWetness))
                : B.flow;
  const fl = (!eraser || soft) ? curFlow * (pen && B.po ? 1 - B.po + B.po * penPressure(e) : 1) * (1 - .6 * t) : 1;
  if (!bb) bb = [Infinity, Infinity, -Infinity, -Infinity];
  bb = [Math.min(bb[0], a[0] - m, b[0] - m), Math.min(bb[1], a[1] - m, b[1] - m), Math.max(bb[2], a[0] + m, b[0] + m), Math.max(bb[3], a[1] + m, b[1] + m)];
  const c = eraser ? cur.ctx : tctx, col = $('color').value;
  if (eraser) c.globalCompositeOperation = 'destination-out';
  const spVal = B.id === 'pen' ? (PEN_NIBS[curNib]?.sp || B.sp)
              : (B.id === 'wc' || B.wet) ? (WC_BRUSHES[curWcType]?.sp || B.sp)
              : B.sp;
  const d = Math.hypot(b[0] - a[0], b[1] - a[1]), step = Math.max(1, w * ((!eraser || soft) ? spVal : .1));
  let k = rest;
  for (; k <= d; k += step) { const f = d ? k / d : 0; stamp(c, col, a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, w / 2, fl, t, az); }
  rest = k - d; c.globalAlpha = 1; c.globalCompositeOperation = 'source-over';
}

// QuickShape：筆停住 0.5 秒就把這一筆拉直成直線，之後移動可調整終點
let st0 = null, snapped = false, qs = 0, qsAt = null, qsSm = null, lastEv = null;
// 記住 QuickShape 開關（localStorage 可能在私密瀏覽被擋，失敗就用預設值）
try { $('qson').checked = localStorage.getItem('qson') !== '0'; } catch {}
$('qson').onchange = e => { try { localStorage.setItem('qson', e.target.checked ? '1' : '0'); } catch {} };
const qsSnap = () => { if (!last) return; snapped = true; redrawLine(); refresh3d?.(cur); };
const qsRestart = () => { clearTimeout(qs); if ($('qson').checked) qs = setTimeout(qsSnap, 500); };
function qsArm(e) { qsAt = qsSm = [e.clientX, e.clientY]; qsRestart(); }
function redrawLine() {
  if (eraser) { cur.ctx.clearRect(0, 0, W, H); cur.ctx.drawImage(snapC, 0, 0); } else tctx.clearRect(0, 0, W, H);
  rest = 0; draw(st0, last, lastEv);
}
function strokeTo(p, ev) {
  const a = last; lastEv = ev; last = p;
  if (snapped) redrawLine(); else draw(a, p, ev);
}
// 「停筆」用指數平滑後的位置判斷：iPad 的筆尖即使按住不動也會持續送出帶抖動的取樣，直接比
// 瞬時位置的話，抖動一超過門檻就不斷重新計時，拉直永遠不會觸發（實測抖動 ±7px 就完全失效）。
const strokeMoved = e => {
  if (snapped) return;
  qsSm = [qsSm[0] + (e.clientX - qsSm[0]) * .2, qsSm[1] + (e.clientY - qsSm[1]) * .2];
  if (Math.hypot(qsSm[0] - qsAt[0], qsSm[1] - qsAt[1]) <= 6) return;
  qsAt = qsSm.slice(); qsRestart();
};

// --- 預測筆跡（Apple Pencil 延遲補償）---
// 畫在 tmp 之上的獨立圖層，每次事件整層重畫，所以不會累積；真實取樣點一到就重畫成新的預測，
// 放手時整層丟掉。它是純預覽：永遠不會被合成進圖層，所以就算預測歪了，存下來的圖也不會錯。
function drawPred(ev) {
  pctx.clearRect(0, 0, W, H);
  if (eraser || snapped || !last) return;             // 橡皮擦直接改圖層，拉直線時也不需要
  const q = ev.getPredictedEvents?.();
  if (!q || !q.length) return;
  const t = B.tilt && ev.pointerType === 'pen' ? tiltOf(ev) : 0;
  const spVal = B.id === 'pen' ? (PEN_NIBS[curNib]?.sp || B.sp)
              : (B.id === 'wc' || B.wet) ? (WC_BRUSHES[curWcType]?.sp || B.sp)
              : B.sp;
  const w = width(ev) * (1 + 3 * t), step = Math.max(1, w * spVal);
  const curFlow = B.id === 'pencil' ? (PENCIL_HARDNESS[curHardness]?.flow || B.flow)
                : (B.id === 'wc' || B.wet) ? ((WC_BRUSHES[curWcType]?.flow || B.flow) * (1.3 - 0.5 * wcWetness))
                : B.flow;
  const fl = curFlow * (ev.pointerType === 'pen' && B.po ? 1 - B.po + B.po * ev.pressure : 1) * (1 - .6 * t);
  const col = $('color').value;
  let from = last, k = step; // 從一個步距之後才落印，免得和真實筆跡在筆尖疊成兩倍濃度
  for (const pe of q) {
    const to = pos(pe), d = Math.hypot(to[0] - from[0], to[1] - from[1]);
    if (d <= 0) continue;
    for (; k <= d; k += step) { const f = k / d; stamp(pctx, col, from[0] + (to[0] - from[0]) * f, from[1] + (to[1] - from[1]) * f, w / 2, fl); }
    k -= d; from = to;
  }
}

let sid = null, pen = false, pan = null, space = false;
const touches = new Map();
const midOf = m => { const p = [...m.values()]; return [(p[0][0] + p[1][0]) / 2, (p[0][1] + p[1][1]) / 2, Math.hypot(p[0][0] - p[1][0], p[0][1] - p[1][1]), Math.atan2(p[1][1] - p[0][1], p[1][0] - p[0][0])]; };
const mid = () => midOf(touches);
let tap = null; // 兩指輕點＝復原、三指輕點＝重做

function startStroke(e, p = pos(e)) {
  if (!cur.visible || cur.locked) return;
  sid = e.pointerId; snapX.clearRect(0, 0, W, H); snapX.drawImage(cur.c, 0, 0); bb = [Infinity, Infinity, -Infinity, -Infinity];
  last = st0 = p; lastEv = e; snapped = false;
  rest = 0; tmp.style.opacity = eraser ? 0 : $('alpha').value / 100 * B.cap;
  pred.style.opacity = tmp.style.opacity; pred.style.display = ''; pctx.clearRect(0, 0, W, H);
  draw(p, p, e); qsArm(e);
}
function cancelStroke() {
  if (!last) return;
  clearTimeout(qs);
  cur.ctx.clearRect(0, 0, W, H); cur.ctx.drawImage(snapC, 0, 0); tctx.clearRect(0, 0, W, H); endPred(); last = null;
}
// 預測圖層用完就收起來，平常不佔一個合成層
const endPred = () => { pctx.clearRect(0, 0, W, H); pred.style.display = 'none'; };
stage.onpointerdown = e => {
  cancelEraserAutoRevert();
  sRect = null; // 版面可能在兩次互動之間變動，每次互動重新確認一次
  stage.setPointerCapture(e.pointerId);
  if (tf) { tfPts.set(e.pointerId, [e.clientX, e.clientY]); return; }
  if (picking && !touches.size) { pickColor(pos(e)); return; }
  if (guide.mode) { // 先檢查是否按在消失點／地平線把手上
    const r = stageRect(), px = e.clientX - r.left, py = e.clientY - r.top, R = e.pointerType === 'touch' ? 30 : 16;
    const h = gHandles().find(p => { const [hx, hy] = toStage(p.x, p.y); return Math.hypot(hx - px, hy - py) < R; });
    if (h) { gdrag = { id: h.id, pid: e.pointerId }; return; }
  }
  let palmReject = true; // Apple Pencil 專用防誤觸
  try { palmReject = localStorage.getItem('palm_reject') !== '0'; } catch {}

  if (e.pointerType === 'pen') {
    pen = true;
    hoverCur = null;
    drawECur();
    // 手掌先落在畫布上、筆才下來（iPad 很常見）：把那一筆手掌筆劃丟掉
    if (last && touches.has(sid)) cancelStroke();
  }
  if (e.pointerType === 'touch') {
    const isPalm = (e.width > 22 || e.height > 22) || (pen && palmReject);
    touches.set(e.pointerId, [e.clientX, e.clientY]);
    if (touches.size === 1 || !tap) tap = { t: performance.now(), n: 0, moved: false, start: new Map() };
    tap.n = Math.max(tap.n, touches.size); tap.start.set(e.pointerId, [e.clientX, e.clientY]);
    if (touches.size >= 2) cancelStroke();
    // 防誤觸：已偵測到 Apple Pencil 或大面積接觸時，單指觸控不繪圖
    if (touches.size >= 2 || (palmReject && pen) || (pen && isPalm)) return;
  } else if (e.button === 1 || space) { pan = [e.clientX, e.clientY]; return; }
  if (e.pointerType === 'mouse' && e.button !== 0) return; // 右鍵／其他鍵不該落筆
  startStroke(e);
};
// 滑鼠、Pencil 懸停或正在擦的時候顯示範圍；手指只在擦的過程中顯示
const showECur = e => {
  const pressed = e.pointerType === 'pen' && e.pressure > 0;
  eCur = [e.clientX, e.clientY, (pressed ? width(e) * (1 + 3 * (B.tilt ? tiltOf(e) : 0)) : +$('size').value) / 2];
  drawECur();
};
const showHoverCur = e => {
  if (!pencilHoverOn || last || eraser) {
    if (hoverCur) { hoverCur = null; drawECur(); }
    return;
  }
  const rad = (+width(e)) / 2;
  const t = B.tilt ? tiltOf(e) : 0;
  const az = e.azimuthAngle || 0;
  hoverCur = [e.clientX, e.clientY, rad, t, az, e.pointerType];
  drawECur();
};
stage.onpointerleave = () => {
  if (eCur) { eCur = null; drawECur(); }
  if (hoverCur) { hoverCur = null; drawECur(); }
};
stage.onpointermove = e => {
  if (eraser && (e.pointerType !== 'touch' || (last && e.pointerId === sid))) {
    showECur(e);
  } else if (!eraser && e.pointerType !== 'touch' && !last) {
    showHoverCur(e);
  }
  if (tf) return tfMove(e);
  if (gdrag) {
    if (e.pointerId === gdrag.pid) {
      const p = pos(e), id = gdrag.id;
      if (id === 'hy') guide.hy = p[1]; else if (id === 'v3') { guide.v3x = p[0]; guide.v3y = p[1]; } else guide[id] = p[0];
      drawGuide();
    }
    return;
  }
  if (tap?.start.has(e.pointerId)) { const p0 = tap.start.get(e.pointerId); if (Math.hypot(e.clientX - p0[0], e.clientY - p0[1]) > 10) tap.moved = true; }
  if (touches.has(e.pointerId)) {
    let palmReject = true;
    try { palmReject = localStorage.getItem('palm_reject') !== '0'; } catch {}
    const old = touches.size === 2 ? mid() : null, prev = touches.get(e.pointerId);
    touches.set(e.pointerId, [e.clientX, e.clientY]);
    if (old) {
      const n = mid(); zoomV(old[0], old[1], n[2] / old[2]); rotateV(old[0], old[1], n[3] - old[3]);
      v.x += n[0] - old[0]; v.y += n[1] - old[1]; apply();
    } else if (pen && touches.size === 1 && !palmReject) {
      v.x += e.clientX - prev[0]; v.y += e.clientY - prev[1]; apply();
    }
    if (touches.size > 1 || pen) return;
  }
  if (pan) { v.x += e.clientX - pan[0]; v.y += e.clientY - pan[1]; pan = [e.clientX, e.clientY]; apply(); return; }
  if (!last || e.pointerId !== sid) return;
  const list = evs(e);
  for (const ev of list) strokeTo(pos(ev), ev);
  strokeMoved(e);
  drawPred(list[list.length - 1]); // 只用品質最新的一個取樣點做預測
};
// pointerup 與 pointercancel 的收尾共用；只有「筆劃要不要留下」不同
const endPointer = (e, cancelled) => {
  if (e.pointerType === 'touch' && eCur) { eCur = null; drawECur(); }
  if (tf) { tfPts.delete(e.pointerId); return; }
  const wasTouch = touches.delete(e.pointerId); pan = null;
  if (wasTouch && !touches.size && tap) {
    if (!tap.moved && performance.now() - tap.t < 350 && tap.n >= 2) $(tap.n === 2 ? 'undo' : 'redo').click();
    tap = null;
  }
  if (gdrag && e.pointerId === gdrag.pid) { gdrag = null; return; }
  if (!last || e.pointerId !== sid) return;
  if (cancelled) cancelStroke(); else finishStroke();
};
stage.onpointerup = e => endPointer(e, false);
// pointercancel 是系統把手勢搶走（通知列、多指手勢、手掌誤觸），不該留下一截沒畫完的線
stage.onpointercancel = e => endPointer(e, true);
function finishStroke() {
  last = null; clearTimeout(qs); dropImg(cur); endPred(); // 畫過的底圖不再保留原始圖檔
  if (!eraser) {
    cur.ctx.globalAlpha = $('alpha').value / 100 * B.cap;
    cur.ctx.drawImage(tmp, 0, 0); cur.ctx.globalAlpha = 1;
    tctx.clearRect(0, 0, W, H);
  }
  const x = Math.max(0, Math.floor(bb[0])), y = Math.max(0, Math.floor(bb[1])), w = Math.min(W, Math.ceil(bb[2])) - x, h = Math.min(H, Math.ceil(bb[3])) - y;
  if (w > 0 && h > 0) pushUndo({ l: cur, c: crop(snapC, x, y, w, h), x, y });
  list(cur);

  // 橡皮擦擦完一筆後，依設定時間（0.5秒 / 1秒）自動切換回筆刷
  if (eraser && eraserAutoRevertDelay > 0) {
    scheduleEraserAutoRevert();
  }
}
// 空白鍵一律當作平移，不要求焦點在 body：否則左鍵點過工具列按鈕後，按空白鍵會「再按一次」
// 那顆按鈕（例如剛按過「刪除」就再刪一層）。preventDefault 同時擋掉按鈕的空白鍵啟動。
addEventListener('keydown', e => { if (e.code === 'Space') { space = true; e.preventDefault(); } });
addEventListener('keyup', e => { if (e.code === 'Space') space = false; });

// --- 復原 / 重做 ---
// 以「總位元組」而非筆數為上限：一張 1200×1600 的快照就是 7.68 MB，30 張會吃掉兩百多 MB。
// 變形用整張快照，所以位元組上限比筆數上限更貼近實際記憶體。
const UNDO_MAX_BYTES = 64 * 1024 * 1024;
const undoBytes = e => e.c.width * e.c.height * 4;
function pushUndo(e) {
  undos.push(e); redos = [];
  let total = undos.reduce((s, x) => s + undoBytes(x), 0);
  while (total > UNDO_MAX_BYTES && undos.length > 1) total -= undoBytes(undos.shift());
}
// 圖層被刪掉或合併後，堆疊裡屬於它的快照已經沒有意義，但每一張都還參考著那個 3.84 MB 的
// canvas；不清掉的話會一直被算在位元組上限裡，直到被新筆劃擠出去
function purge(L) { undos = undos.filter(u => u.l !== L); redos = redos.filter(u => u.l !== L); }
function swap(from, to) {
  let s;
  while ((s = from.pop())) if (layers.includes(s.l)) break; // 丟掉已刪除圖層的紀錄
  if (!s) return;
  const { x, y } = s, w = s.c.width, h = s.c.height;
  to.push({ l: s.l, c: crop(s.l.c, x, y, w, h), x, y });
  dropImg(s.l); s.l.ctx.clearRect(x, y, w, h); s.l.ctx.drawImage(s.c, x, y); list(s.l); refresh3d?.(s.l);
}
$('undo').onclick = () => swap(undos, redos);
$('redo').onclick = () => swap(redos, undos);
addEventListener('keydown', e => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? $('redo').click() : $('undo').click(); }
});

// --- 視角切換與顯示比例 ---
const ZOOM_PRESETS = [
  ['fit', '適合畫面'],
  ['0.25', '25%'],
  ['0.5', '50%'],
  ['0.75', '75%'],
  ['1', '100% (原寸)'],
  ['1.5', '150%'],
  ['2', '200%'],
  ['3', '300%'],
  ['4', '400%'],
  ['8', '800%']
];
zsel = $('zsel');
ZOOM_PRESETS.forEach(([val, label]) => zsel.append(new Option(label, val)));
curZoomOpt = new Option('', 'cur');

function updateZoomUi() {
  if (!zsel) return;
  const fitS = getFitScale();
  const isFit = Math.abs(v.s - fitS) < 0.04 && Math.abs(v.r % (Math.PI * 2)) < 0.02;
  const isDetail = v.s >= 0.95;
  $('vfit').classList.toggle('on', isFit);
  $('vdetail').classList.toggle('on', !isFit && isDetail);

  const pct = Math.round(v.s * 100) + '%';
  const opt = Array.from(zsel.options).find(o => o.value !== 'fit' && o.value !== 'cur' && Math.abs(+o.value - v.s) < 0.04);
  if (isFit) {
    curZoomOpt.remove();
    const fitOpt = zsel.querySelector('option[value="fit"]');
    if (fitOpt) fitOpt.textContent = `適合畫面 (${pct})`;
    zsel.value = 'fit';
  } else if (opt) {
    curZoomOpt.remove();
    zsel.value = opt.value;
  } else {
    curZoomOpt.textContent = pct;
    curZoomOpt.value = 'cur';
    if (!curZoomOpt.parentNode) zsel.insertBefore(curZoomOpt, zsel.firstChild);
    zsel.value = 'cur';
  }
  zsel.title = `目前顯示比例 ${pct}`;
  if ($('mmzoom')) $('mmzoom').textContent = pct;

  // 同步導航器面板 (Navigator) 控制項
  if ($('nav-zval')) $('nav-zval').textContent = pct;
  if ($('nav-zslider')) $('nav-zslider').value = Math.min(800, Math.max(10, Math.round(v.s * 100)));
  if ($('nav-fit')) $('nav-fit').classList.toggle('on', isFit);
  if ($('nav-100')) $('nav-100').classList.toggle('on', !isFit && Math.abs(v.s - 1.0) < 0.04);
  if ($('nav-150')) $('nav-150').classList.toggle('on', !isFit && Math.abs(v.s - 1.5) < 0.04);
  if ($('nav-200')) $('nav-200').classList.toggle('on', !isFit && Math.abs(v.s - 2.0) < 0.04);

  // 同步頂部標籤列快速縮放按鈕
  if ($('tab-vfit')) $('tab-vfit').classList.toggle('on', isFit);
  if ($('tab-v100')) $('tab-v100').classList.toggle('on', !isFit && Math.abs(v.s - 1.0) < 0.04);
}

zsel.onchange = e => {
  const val = e.target.value;
  if (val === 'fit') fit();
  else if (val !== 'cur') zoomTo(+val);
};

const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4, 8];
$('zin').onclick = () => {
  const next = ZOOM_STEPS.find(s => s > v.s + 0.04) || Math.min(16, v.s * 1.3);
  zoomTo(next);
};
$('zout').onclick = () => {
  const prev = ZOOM_STEPS.slice().reverse().find(s => s < v.s - 0.04) || Math.max(0.02, v.s * 0.75);
  zoomTo(prev);
};

$('vfit').onclick = fit;
$('vdetail').onclick = () => zoomDetail(1.0);

addEventListener('keydown', e => {
  const tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') {
    if (e.key === 'Escape') closeNewDocModal?.();
    return;
  }
  if (e.metaKey || e.ctrlKey) {
    if (e.key.toLowerCase() === 'n') { e.preventDefault(); openNewDocModal?.(); }
    else if (e.key.toLowerCase() === 'o') { e.preventDefault(); $('pfile').click(); }
    else if (e.key === '=' || e.key === '+') { e.preventDefault(); $('zin').click(); }
    else if (e.key === '-') { e.preventDefault(); $('zout').click(); }
    else if (e.key === '0') { e.preventDefault(); $('vfit').click(); }
    else if (e.key === '1') { e.preventDefault(); $('vdetail').click(); }
  } else if (!e.altKey) {
    if (e.key === 'Escape') {
      const nm = $('new-doc-modal');
      if (nm && nm.style.display !== 'none') {
        e.preventDefault();
        closeNewDocModal();
        return;
      }
      if (eraser) {
        e.preventDefault();
        cancelEraserAutoRevert();
        setEraser(false);
      }
    } else if (e.key === 'b' || e.key === 'B') {
      e.preventDefault();
      cancelEraserAutoRevert();
      setEraser(false);
    } else if (e.key === 'e' || e.key === 'E') {
      e.preventDefault();
      cancelEraserAutoRevert();
      setEraser(!eraser);
    } else if (e.key === 'v' || e.key === 'V') {
      e.preventDefault();
      $('tfm').click();
    } else if (e.key === 'i' || e.key === 'I') {
      e.preventDefault();
      $('pick').click();
    } else if (e.key === 'h' || e.key === 'H') {
      e.preventDefault();
      fit();
    } else if (e.key === 'z' || e.key === 'Z') {
      e.preventDefault();
      zoomDetail(1.0);
    } else if (e.key === 'x' || e.key === 'X') {
      e.preventDefault();
      swapColors();
    } else if (e.key === 'd' || e.key === 'D') {
      e.preventDefault();
      resetColors();
    }
  }
});

// --- 小地圖導航器（Minimap）---
let mmW = 120, mmH = 160;
mmcv = $('mmcv'); mmview = $('mmview'); mmbox = $('mmbox');
function resizeMinimap() {
  const MAX = 240;
  if (W >= H) {
    mmW = MAX;
    mmH = Math.max(20, Math.round(MAX * H / W));
  } else {
    mmH = MAX;
    mmW = Math.max(20, Math.round(MAX * W / H));
  }
  if (mmbox) {
    mmbox.style.width = mmW + 'px';
    mmbox.style.height = mmH + 'px';
  }
  if (mmcv) { mmcv.width = mmW; mmcv.height = mmH; }
  if (mmview) { mmview.width = mmW; mmview.height = mmH; }
  updateMinimapThumb();
  updateMinimapView();
}

function updateMinimapThumb() {
  if (!mmcv) return;
  const ctx = mmcv.getContext('2d');
  ctx.clearRect(0, 0, mmW, mmH);
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, mmW, mmH);
  layers.forEach(l => {
    if (l.visible) {
      ctx.globalAlpha = +(l.c.style.opacity || 1);
      ctx.drawImage(l.c, 0, 0, mmW, mmH);
    }
  });
  ctx.globalAlpha = 1;
}

function updateMinimapView() {
  if (!mmview || !mmbox || $('minimap')?.classList.contains('collapsed')) return;
  const ctx = mmview.getContext('2d');
  ctx.clearRect(0, 0, mmW, mmH);

  const vw = stage.clientWidth;
  const vh = stage.clientHeight;

  const p1 = stagePtToCanvas(0, 0);
  const p2 = stagePtToCanvas(vw, 0);
  const p3 = stagePtToCanvas(vw, vh);
  const p4 = stagePtToCanvas(0, vh);

  const toM = ([cx, cy]) => [cx / W * mmW, cy / H * mmH];
  const m1 = toM(p1), m2 = toM(p2), m3 = toM(p3), m4 = toM(p4);

  ctx.save();
  ctx.beginPath(); ctx.rect(0, 0, mmW, mmH); ctx.clip();

  // 1. 遮罩非可視區域
  ctx.fillStyle = 'rgba(15, 17, 21, 0.42)';
  ctx.fillRect(0, 0, mmW, mmH);

  // 2. 挖空當前可視區域
  ctx.globalCompositeOperation = 'destination-out';
  ctx.beginPath();
  ctx.moveTo(...m1); ctx.lineTo(...m2); ctx.lineTo(...m3); ctx.lineTo(...m4);
  ctx.closePath();
  ctx.fillStyle = '#000';
  ctx.fill();

  // 3. 繪製高亮取景框線與微藍色淡底
  ctx.globalCompositeOperation = 'source-over';
  ctx.beginPath();
  ctx.moveTo(...m1); ctx.lineTo(...m2); ctx.lineTo(...m3); ctx.lineTo(...m4);
  ctx.closePath();
  ctx.fillStyle = 'rgba(147, 211, 232, 0.1)';
  ctx.fill();
  ctx.strokeStyle = '#93d3e8';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  // 4. 畫面中心定位點
  const mc = toM(stagePtToCanvas(vw / 2, vh / 2));
  if (mc[0] >= 0 && mc[0] <= mmW && mc[1] >= 0 && mc[1] <= mmH) {
    ctx.fillStyle = '#93d3e8';
    ctx.beginPath();
    ctx.arc(mc[0], mc[1], 2.5, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

let mmDragging = false;
function mmNavigate(e) {
  const rect = mmbox.getBoundingClientRect();
  const mx = Math.max(0, Math.min(mmW, e.clientX - rect.left));
  const my = Math.max(0, Math.min(mmH, e.clientY - rect.top));
  const cx = (mx / mmW) * W;
  const cy = (my / mmH) * H;

  const vw = stage.clientWidth / 2;
  const vh = stage.clientHeight / 2;
  const c = Math.cos(v.r), s = Math.sin(v.r);
  v.x = vw - (cx * c - cy * s) * v.s;
  v.y = vh - (cx * s + cy * c) * v.s;
  apply();
}
mmbox.addEventListener('pointerdown', e => {
  mmDragging = true;
  mmbox.setPointerCapture(e.pointerId);
  mmNavigate(e);
});
mmbox.addEventListener('pointermove', e => { if (mmDragging) mmNavigate(e); });
mmbox.addEventListener('pointerup', e => { mmDragging = false; });
mmbox.addEventListener('pointercancel', e => { mmDragging = false; });

let mmCollapsed = false;
try { mmCollapsed = localStorage.getItem('mm_collapse') === '1'; } catch {}
if (mmCollapsed && $('minimap')) $('minimap').classList.add('collapsed');
if ($('mmtog')) {
  $('mmtog').textContent = mmCollapsed ? '▴' : '▾';
  $('mmtog').onclick = () => {
    mmCollapsed = $('minimap')?.classList.toggle('collapsed');
    $('mmtog').textContent = mmCollapsed ? '▴' : '▾';
    try { localStorage.setItem('mm_collapse', mmCollapsed ? '1' : '0'); } catch {}
    if (!mmCollapsed) { updateMinimapThumb(); updateMinimapView(); }
  };
}
if ($('mmfit')) $('mmfit').onclick = fit;

// 工具列一次只亮一個：變形或滴管進行中時，筆刷/橡皮擦先暗下來
function toolUi() {
  const busy = tf || picking;
  $('brush').classList.toggle('on', !busy && !eraser); $('eraser').classList.toggle('on', !busy && eraser);
  $('tfm').classList.toggle('on', !!tf); $('pick').classList.toggle('on', picking);
  wrap.style.cursor = eraser && !busy ? 'none' : ''; // 用範圍圈取代十字游標

  // 左側垂直工具列 (Left Toolbar) 同步
  if ($('lt-brush')) $('lt-brush').classList.toggle('on', !busy && !eraser);
  if ($('lt-eraser')) $('lt-eraser').classList.toggle('on', !busy && eraser);
  if ($('lt-tfm')) $('lt-tfm').classList.toggle('on', !!tf);
  if ($('lt-pick')) $('lt-pick').classList.toggle('on', picking);

  // 雙色票切換方塊同步
  if ($('lt-swatch-fg')) $('lt-swatch-fg').style.backgroundColor = $('color').value;
  if ($('lt-swatch-bg')) $('lt-swatch-bg').style.backgroundColor = (typeof ltBgColor !== 'undefined' ? ltBgColor : '#ffffff');
  if ($('lt-color-picker')) $('lt-color-picker').value = $('color').value;

  if ($('tool-title')) $('tool-title').textContent = eraser ? '橡皮擦設定' : '筆刷設定';
  if ($('tool-badge')) {
    $('tool-badge').textContent = eraser ? '橡皮擦' : '筆刷';
    $('tool-badge').classList.toggle('eraser-mode', eraser);
  }
  if ($('eraser-banner')) $('eraser-banner').style.display = eraser ? 'flex' : 'none';
  if ($('lbl-esoft')) $('lbl-esoft').classList.toggle('highlight', eraser);
  if ($('btn-esoft-done')) $('btn-esoft-done').style.display = eraser ? 'inline-flex' : 'none';
  updateQuickBar();
}
$('brush').onclick = () => { cancelEraserAutoRevert(); setEraser(false); };
$('eraser').onclick = () => { cancelEraserAutoRevert(); setEraser(!eraser); }; // 再次點擊橡皮擦可切換回筆刷
if ($('btn-to-brush')) $('btn-to-brush').onclick = () => { cancelEraserAutoRevert(); setEraser(false); };
if ($('btn-esoft-done')) $('btn-esoft-done').onclick = () => { cancelEraserAutoRevert(); setEraser(false); };
if ($('et-keep')) $('et-keep').onclick = () => cancelEraserAutoRevert();
if ($('et-now')) $('et-now').onclick = () => { cancelEraserAutoRevert(); setEraser(false); };
$('eraser-delay-seg')?.querySelectorAll('button').forEach(b => {
  b.onclick = () => setEraserDelay(+b.dataset.delay);
});

const edBadge = $('eraser-delay-badge');
if (edBadge) {
  edBadge.onclick = e => {
    e.stopPropagation();
    cycleEraserDelay();
  };
}
if ($('et-plus')) {
  $('et-plus').onclick = e => {
    e.stopPropagation();
    stepEraserDelay(1);
  };
}
if ($('et-minus')) {
  $('et-minus').onclick = e => {
    e.stopPropagation();
    stepEraserDelay(-1);
  };
}
if ($('et-text')) {
  $('et-text').onclick = e => {
    e.stopPropagation();
    cycleEraserDelay();
  };
}

updateEraserDelayUi();
$('sec-tool')?.addEventListener('mouseleave', () => {
  if (eraser && eraserAutoRevertDelay > 0 && !last) scheduleEraserAutoRevert();
});
$('sec-tool')?.addEventListener('mouseenter', () => cancelEraserAutoRevert());
$('add').onclick = () => addLayer();
// 刪除圖層：工具列的「刪除」與圖層列上的 ✕ 共用；鎖定的圖層不給刪
function delLayer(L) {
  if (layers.length < 2 || !L || L.locked) return;
  const i = layers.indexOf(L); if (i < 0) return;
  L.c.remove(); layers.splice(i, 1); forget(L); purge(L);
  if (cur === L) cur = layers[Math.max(0, i - 1)];
  sync();
}
$('del').onclick = () => delLayer(cur);
// 清空目前圖層（可復原）：只快照有內容的範圍，空圖層直接略過
$('clr').onclick = () => {
  if (cur.locked) return;
  const b = alphaBox(cur.c); if (!b) return;
  pushUndo({ l: cur, c: crop(cur.c, b.x, b.y, b.w, b.h), x: b.x, y: b.y });
  cur.ctx.clearRect(0, 0, W, H); dropImg(cur);
  list(cur); refresh3d?.(cur);
};
const move = d => { const i = layers.indexOf(cur), j = i + d; if (j < 0 || j >= layers.length) return; [layers[i], layers[j]] = [layers[j], layers[i]]; sync(); };
$('up').onclick = () => move(1);
$('down').onclick = () => move(-1);
$('lalpha').oninput = e => { cur.c.style.opacity = e.target.value / 100; refresh3d?.(cur); };
$('merge').onclick = () => {
  const i = layers.indexOf(cur); if (i < 1) return;
  const b = layers[i - 1];
  if (cur.locked || b.locked) return; // 鎖定中的圖層不動
  if (cur.visible) { b.ctx.globalAlpha = cur.c.style.opacity || 1; b.ctx.drawImage(cur.c, 0, 0); b.ctx.globalAlpha = 1; }
  const dead = cur; dead.c.remove(); layers.splice(i, 1); cur = b; forget(dead); dropImg(b);
  purge(dead); purge(b); sync(b);
};

// --- 變形：移動/縮放/旋轉/翻轉目前圖層。底圖保留原始圖檔，重複變形不會越來越糊 ---
const tfPts = new Map();
const fitTf = img => ({ x: 0, y: 0, s: Math.min(W / img.width, H / img.height), r: 0, fx: 1 });
function paintTf(ctx, src, m) {
  ctx.clearRect(0, 0, W, H); ctx.save();
  ctx.translate(W / 2 + m.x, H / 2 + m.y); ctx.rotate(m.r); ctx.scale(m.s * m.fx, m.s);
  ctx.drawImage(src, -src.width / 2, -src.height / 2); ctx.restore();
}
const tfUi = () => {
  $('tfbar').style.display = tf ? 'flex' : 'none'; toolUi();
  if (!tf) return;
  $('tfs').value = tf.m.s * 100; $('tfr').value = Math.round(((tf.m.r * 180 / Math.PI) % 360 + 540) % 360 - 180);
};
const tfRender = () => { paintTf(tf.L.ctx, tf.src, tf.m); drawGuide(); tfUi(); };
function startTf() {
  if (tf || cur.locked) return;
  const L = cur, before = crop(L.c, 0, 0, W, H);
  tf = { L, before, src: L.img || before, m: { x: 0, y: 0, s: 1, r: 0, fx: 1, ...L.tf } };
  tf.m0 = L.img ? fitTf(L.img) : { ...tf.m };
  tfPts.clear(); tfRender();
}
function endTf() {
  if (!tf) return;
  const { L, m, before } = tf;
  if (L.img) L.tf = m;
  // 只存「變形前後有差異的聯集」範圍：整張 1200×1600 是 7.68 MB，鉛筆稿通常只佔一角。
  // 兩張都是空的就不必進復原堆疊（等於沒改到東西）。
  const box = unionBox(alphaBox(before), alphaBox(L.c));
  if (box) pushUndo({ l: L, c: crop(before, box.x, box.y, box.w, box.h), x: box.x, y: box.y });
  tf = null; tfUi(); drawGuide(); list(L);
}
function tfMove(e) {
  if (!tfPts.has(e.pointerId)) return;
  const old = new Map(tfPts); tfPts.set(e.pointerId, [e.clientX, e.clientY]);
  const m = tf.m;
  if (tfPts.size === 1) {
    const a = toCanvas(...old.get(e.pointerId)), b = toCanvas(e.clientX, e.clientY);
    m.x += b[0] - a[0]; m.y += b[1] - a[1];
  } else if (tfPts.size === 2) {
    const o = midOf(old), n = midOf(tfPts), a = toCanvas(o[0], o[1]), b = toCanvas(n[0], n[1]);
    m.s = Math.max(.01, m.s * n[2] / o[2]); m.r += n[3] - o[3]; m.x += b[0] - a[0]; m.y += b[1] - a[1];
  }
  tfRender();
}
$('tfm').onclick = () => tf ? endTf() : startTf();
$('tfok').onclick = endTf;
$('tfs').oninput = e => { tf.m.s = e.target.value / 100; tfRender(); };
$('tfr').oninput = e => { tf.m.r = e.target.value * Math.PI / 180; tfRender(); };
$('tfflip').onclick = () => { tf.m.fx *= -1; tfRender(); };
$('tfreset').onclick = () => { tf.m = { ...tf.m0 }; tfRender(); };
// 按側邊欄／上方工具列其他按鈕或切換圖層前，先把變形套用完成
['aside', '#topbar'].forEach(s => document.querySelector(s).addEventListener('click', e => { if (tf && !e.target.closest('#tfbar,#tfm')) endTf(); }, true));
addEventListener('keydown', e => { if (tf && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') endTf(); }, true);

// --- 滴管：下一次點畫布取樣可見圖層的合成顏色 ---
$('pick').onclick = () => { picking = !picking; toolUi(); drawECur(); };
function pickColor([x, y]) {
  picking = false; setEraser(false); // 取完色直接切回筆刷，不用再按一次
  x = Math.floor(x); y = Math.floor(y); if (x < 0 || y < 0 || x >= W || y >= H) return;
  const c = Object.assign(document.createElement('canvas'), { width: 1, height: 1 }).getContext('2d', { willReadFrequently: true });
  c.fillStyle = '#fff'; c.fillRect(0, 0, 1, 1);
  layers.filter(l => l.visible).forEach(l => { c.globalAlpha = +(l.c.style.opacity || 1); c.drawImage(l.c, x, y, 1, 1, 0, 0, 1, 1); });
  const d = c.getImageData(0, 0, 1, 1).data;
  $('color').value = '#' + [d[0], d[1], d[2]].map(n => n.toString(16).padStart(2, '0')).join('');
}

// --- 3D 柱體：每個可見圖層取樣成一片方塊板，由下到上（後到前）依層距排開 ---
let stop3d = null, refresh3d = null, manPose = null;
// 預設姿勢：只列出要改的關節座標（未列者用站姿），套用後會依骨長自動校正
const POSES = {
  站: {},
  T字: { lEl: [-220, 240, 0], lWr: [-370, 240, 0], rEl: [220, 240, 0], rWr: [370, 240, 0] },
  坐: { lKn: [-40, -5, 190], lAn: [-40, -195, 190], lTo: [-40, -200, 260], rKn: [40, -5, 190], rAn: [40, -195, 190], rTo: [40, -200, 260],
        lEl: [-80, 110, 40], lWr: [-55, 10, 150], rEl: [80, 110, 40], rWr: [55, 10, 150] },
  跑: { chest: [0, 135, 25], neck: [0, 245, 60], head: [0, 330, 100],
        lKn: [-40, -80, 150], lAn: [-40, -200, 100], lTo: [-40, -210, 170], rKn: [40, -150, -100], rAn: [40, -60, -290], rTo: [40, -50, -220],
        lEl: [-80, 150, -100], lWr: [-70, 200, 0], rEl: [80, 160, 100], rWr: [75, 230, 200] },
  跳: { lEl: [-110, 380, 0], lWr: [-125, 520, 0], rEl: [110, 380, 0], rWr: [125, 520, 0],
        lKn: [-50, -100, 100], lAn: [-50, -230, -30], lTo: [-50, -240, 40], rKn: [50, -100, 100], rAn: [50, -230, -30], rTo: [50, -240, 40] },
  揮手: { rEl: [130, 300, 0], rWr: [150, 430, 20] },
};
// 人偶骨架：[名稱, 父節點, x, y, z, 半徑]；骨長固定，拖曳關節時其下的子節點整段跟著平移
const JOINTS = [
  ['pelvis', null, 0, 0, 0, 32], ['chest', 'pelvis', 0, 140, 0, 38], ['neck', 'chest', 0, 250, 0, 14], ['head', 'neck', 0, 335, 0, 45],
  ...[['l', -1], ['r', 1]].flatMap(([p, k]) => [
    [p + 'Sh', 'neck', 75 * k, 240, 0, 18], [p + 'El', p + 'Sh', 85 * k, 95, 0, 14], [p + 'Wr', p + 'El', 85 * k, -55, 0, 11],
    [p + 'Hip', 'pelvis', 40 * k, -5, 0, 20], [p + 'Kn', p + 'Hip', 40 * k, -200, 0, 16],
    [p + 'An', p + 'Kn', 40 * k, -390, 0, 12], [p + 'To', p + 'An', 40 * k, -400, 70, 9]]),
];
let opening = false;
async function open3d() {
  if (stop3d || opening) return; // 載入 three.js 期間重複點擊不要開第二個
  endTf();
  opening = true;
  let T, OC;
  try { T = await import('three'); OC = (await import('three/addons/controls/OrbitControls.js')).OrbitControls; }
  catch { return alert('需要網路連線來載入 three.js'); }
  finally { opening = false; }
  const box = $('m3c'), m3 = $('m3'); m3.style.display = 'flex'; $('minimap').style.display = 'none';
  const lock = on => ['add', 'del', 'up', 'down', 'merge', 'd3', 'save', 'imp', 'tfm'].forEach(i => $(i).disabled = on);
  lock(true);
  const mkLs = () => layers.filter(l => l.visible && !l.guide).map(l => ({ l, px: null, mesh: null }));
  let ls = mkLs();
  const renderer = new T.WebGLRenderer({ antialias: true });
  renderer.setClearColor(0x2b2d31); // 跟介面的石墨色一致
  const scene = new T.Scene(), cam = new T.PerspectiveCamera(40, 1, 10, 10000);
  cam.position.set(0, -300, 1600);
  scene.add(new T.AmbientLight(0xffffff, 1.2));
  const sun = new T.DirectionalLight(0xffffff, 2); sun.position.set(500, 800, 1000); scene.add(sun);
  box.append(renderer.domElement);
  const ctl = new OC(cam, renderer.domElement);
  // 只在有變動時才畫，靜止時不燒 GPU（iPad 省電）。OrbitControls 的 update() 只在相機
  // 真的移動時才丟 'change'，而 raf 要到 draw() 尾端才歸零，所以不會自己把自己叫醒。
  let raf = 0;
  const draw = () => { updateMan(); ctl.update(); renderer.render(scene, cam); raf = 0; };
  const invalidate = () => { if (!raf) raf = requestAnimationFrame(draw); };
  ctl.addEventListener('change', invalidate);

  // --- 固定視角（參考 Rubi-Cube）：自動回正、立即回正、垂直/水平鎖定 ---
  const camHome = new T.Spherical().setFromVector3(cam.position.clone());
  let spring = false, lockV = false, lockH = false, anim = 0;
  const setLocks = () => {
    const az = ctl.getAzimuthalAngle(), po = ctl.getPolarAngle();
    ctl.minAzimuthAngle = lockH ? az : -Infinity; ctl.maxAzimuthAngle = lockH ? az : Infinity;
    ctl.minPolarAngle = lockV ? po : 0; ctl.maxPolarAngle = lockV ? po : Math.PI;
  };
  // full=false（自動回正）只把角度轉回去，保留縮放與平移；full=true（回正按鈕）全部歸位
  const recenter = (full = true) => {
    cancelAnimationFrame(anim);
    const s0 = new T.Spherical().setFromVector3(cam.position.clone().sub(ctl.target)), t0 = ctl.target.clone(), zero = new T.Vector3();
    const th1 = lockH ? s0.theta : camHome.theta, ph1 = lockV ? s0.phi : camHome.phi, t1 = performance.now(), tTo = full ? zero : t0, rTo = full ? camHome.radius : s0.radius;
    let dth = th1 - s0.theta; dth = ((dth + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
    const step = now => {
      const k = Math.min(1, (now - t1) / 360), e = 1 - (1 - k) ** 3;
      ctl.target.lerpVectors(t0, tTo, e);
      cam.position.setFromSpherical(new T.Spherical(s0.radius + (rTo - s0.radius) * e, s0.phi + (ph1 - s0.phi) * e, s0.theta + dth * e)).add(ctl.target);
      ctl.update(); if (k < 1) anim = requestAnimationFrame(step);
    };
    anim = requestAnimationFrame(step);
  };
  ctl.addEventListener('start', () => cancelAnimationFrame(anim));
  ctl.addEventListener('end', () => { if (spring) recenter(false); });
  const tog = (id, on, a, b) => { $(id).textContent = on ? a : b; $(id).classList.toggle('on', on); };
  tog('m3spring', false, '', '自動回正'); tog('m3lv', false, '', '鎖定俯仰'); tog('m3lh', false, '', '鎖定水平');
  $('m3spring').onclick = () => { spring = !spring; tog('m3spring', spring, '自動回正', '自動回正'); if (spring) recenter(false); };
  $('m3home').onclick = () => recenter();
  $('m3lv').onclick = () => { lockV = !lockV; tog('m3lv', lockV, '鎖定俯仰', '鎖定俯仰'); setLocks(); };
  $('m3lh').onclick = () => { lockH = !lockH; tog('m3lh', lockH, '鎖定水平', '鎖定水平'); setLocks(); };
  const geo = new T.BoxGeometry(1, 1, 1), mat = new T.MeshStandardMaterial();
  // --- 人偶 ---
  const man = new T.Group(); man.visible = false; scene.add(man); // 預設不顯示，需要時按「人偶」
  const J = JOINTS.map(([name, par, x, y, z, r], i) => ({ name, par: JOINTS.findIndex(j => j[0] === par), r, i, kids: [], pos: new T.Vector3(x, y, z) }));
  if (manPose) J.forEach((j, i) => j.pos.fromArray(manPose[i]));
  const home = JOINTS.map(([, , x, y, z]) => [x, y, z]);
  const jmat = new T.MeshStandardMaterial({ color: 0xd8dbe3 }), hot = new T.MeshStandardMaterial({ color: 0xff9a3c });
  J.forEach(j => {
    if (j.par >= 0) { J[j.par].kids.push(j); j.len = j.pos.distanceTo(J[j.par].pos); }
    j.mesh = new T.Mesh(new T.SphereGeometry(1, 16, 12), jmat); j.mesh.scale.setScalar(j.r); j.mesh.userData.j = j; man.add(j.mesh);
    if (j.par >= 0) { j.bone = new T.Mesh(new T.CylinderGeometry(1, 1, 1, 12), jmat); man.add(j.bone); }
  });
  const sub = (j, f) => { f(j); j.kids.forEach(k => sub(k, f)); };
  const up_ = new T.Vector3(0, 1, 0), tmpV = new T.Vector3();
  const updateMan = () => J.forEach(j => {
    j.mesh.position.copy(j.pos);
    if (!j.bone) return;
    const a = J[j.par].pos, d = tmpV.subVectors(j.pos, a), len = d.length() || 1e-3;
    j.bone.position.copy(a).addScaledVector(d, .5);
    j.bone.quaternion.setFromUnitVectors(up_, d.normalize());
    j.bone.scale.set((j.r + J[j.par].r) * .45, len, (j.r + J[j.par].r) * .45);
  });
  const setSize = () => { man.scale.setScalar($('msize').value / 100); invalidate(); };
  $('msize').oninput = setSize; setSize();
  tog('m3man', false, '人偶', '人偶');
  $('m3man').onclick = () => { man.visible = !man.visible; $('m3man').classList.toggle('on', man.visible); invalidate(); };
  $('m3reset').onclick = () => { J.forEach((j, i) => j.pos.fromArray(home[i])); invalidate(); };
  let grab = null;

  // 把目前視角下的人偶與透視格線投影成 2D，存成兩個新圖層（輔助線圖層不會顯示在 3D 裡）
  $('m3save').onclick = () => {
    cam.updateMatrixWorld(true); man.updateMatrixWorld(true);
    const cw = box.clientWidth, ch = box.clientHeight, vh = ch / 2 * Math.min(W / cw, H / ch), f = cam.projectionMatrix.elements[5], NEAR = -10;
    const toC = v => v.clone().applyMatrix4(cam.matrixWorldInverse);
    const sp = p => [W / 2 + f * vh * p.x / -p.z, H / 2 - f * vh * p.y / -p.z];
    const prev = cur, sc = man.scale.x, made = [];
    const newLayer = name => { addLayer(); cur.name = name; cur.guide = true; made.push(cur); return cur.ctx; };

    const g = newLayer('透視輔助線'); g.lineWidth = 2; g.globalAlpha = .7;
    const line3 = (a, b, col) => {
      let p = toC(a), q = toC(b);
      if (p.z > NEAR && q.z > NEAR) return;
      if (p.z > NEAR) p = p.clone().lerp(q, (NEAR - p.z) / (q.z - p.z)); else if (q.z > NEAR) q = q.clone().lerp(p, (NEAR - q.z) / (p.z - q.z));
      g.strokeStyle = col; g.beginPath(); g.moveTo(...sp(p)); g.lineTo(...sp(q)); g.stroke();
    };
    const y0 = -400 * sc, V = (x, y, z) => new T.Vector3(x, y, z);
    for (let t = -1500; t <= 1500; t += 250) { line3(V(-3000, y0, t), V(3000, y0, t), '#e33'); line3(V(t, y0, -3000), V(t, y0, 3000), '#2a2'); }
    for (let x = -750; x <= 750; x += 375) for (let z = -750; z <= 750; z += 375) line3(V(x, y0, z), V(x, y0 + 2400, z), '#36f');

    const m = man.visible && newLayer('人偶'); // 人偶隱藏時只存透視格線
    if (m) { m.globalAlpha = .6; m.lineCap = 'round'; }
    const wp = j => toC(man.localToWorld(j.pos.clone())), items = [];
    J.forEach(j => {
      const b = wp(j); if (b.z > NEAR) return;
      items.push({ z: b.z, f: () => { const k = f * vh / -b.z, c = sp(b); m.beginPath(); m.arc(c[0], c[1], j.r * sc * k, 0, 6.283); m.fillStyle = '#ddd'; m.strokeStyle = '#555'; m.lineWidth = 2; m.fill(); m.stroke(); } });
      if (j.par < 0) return;
      const a = wp(J[j.par]); if (a.z > NEAR) return;
      items.push({ z: (a.z + b.z) / 2, f: () => {
        const k = f * vh / -((a.z + b.z) / 2), w = (j.r + J[j.par].r) * .9 * sc * k;
        m.beginPath(); m.moveTo(...sp(a)); m.lineTo(...sp(b));
        m.strokeStyle = '#555'; m.lineWidth = w + 4; m.stroke(); m.strokeStyle = '#ddd'; m.lineWidth = w; m.stroke();
      } });
    });
    if (m) items.sort((p, q) => p.z - q.z).forEach(i => i.f());

    cur = prev; list(prev, ...made);
    ls.forEach(e => { if (e.mesh) { scene.remove(e.mesh); e.mesh.dispose(); } }); ls = mkLs(); build();
  };
  const applyPose = name => {
    J.forEach((j, i) => j.pos.fromArray(POSES[name][j.name] || home[i]));
    J.forEach(j => { if (j.par >= 0) { const p = J[j.par].pos; j.pos.sub(p).setLength(j.len).add(p); } });
    invalidate();
  };
  $('poses').replaceChildren(...Object.keys(POSES).map(k => Object.assign(document.createElement('button'), { textContent: k, onclick: () => applyPose(k) })));
  const zOf = n => (n - (ls.length - 1) / 2) * (+$('depth').value + +$('gap').value);

  function buildLayer(n) {
    const e = ls[n]; if (e.mesh) { scene.remove(e.mesh); e.mesh.dispose(); }
    // 一定要透過 rdX（willReadFrequently）讀，不能讀圖層自己的 ctx（理由見 readPx）
    if (!e.px) { rdX.clearRect(0, 0, W, H); rdX.drawImage(e.l.c, 0, 0); e.px = rdX.getImageData(0, 0, W, H).data; }
    const st = +$('res').value, dp = +$('depth').value, z = zOf(n), a = +(e.l.c.style.opacity || 1), px = e.px, cells = [];
    for (let y = 0; y < H; y += st) for (let x = 0; x < W; x += st) {
      const i = (Math.min(H - 1, y + st / 2 | 0) * W + Math.min(W - 1, x + st / 2 | 0)) * 4;
      if (px[i + 3] * a > 40) cells.push([x, y, px[i], px[i + 1], px[i + 2]]);
    }
    const m = new T.Matrix4(), c = new T.Color(), mesh = new T.InstancedMesh(geo, mat, Math.max(1, cells.length));
    cells.forEach(([x, y, r, g, b], k) => {
      m.compose(new T.Vector3(x - W / 2 + st / 2, H / 2 - y - st / 2, z), new T.Quaternion(), new T.Vector3(st, st, dp));
      mesh.setMatrixAt(k, m); mesh.setColorAt(k, c.setRGB(r / 255, g / 255, b / 255, T.SRGBColorSpace));
    });
    mesh.count = cells.length; e.mesh = mesh; scene.add(mesh); invalidate();
  }
  const build = () => ls.forEach((_, n) => buildLayer(n));

  // 筆劃進行中（在暫存層）也要看得到：合成後重建該層方塊，每個畫面最多一次
  const pend = new Set();
  refresh3d = l => {
    if (!pend.size) requestAnimationFrame(() => {
      pend.forEach(l => {
        const n = ls.findIndex(e => e.l === l); if (n < 0) return;
        rdX.clearRect(0, 0, W, H); rdX.drawImage(l.c, 0, 0);
        if (l === cur && last) { rdX.globalAlpha = +tmp.style.opacity || 0; rdX.drawImage(tmp, 0, 0); rdX.drawImage(pred, 0, 0); rdX.globalAlpha = 1; }
        ls[n].px = rdX.getImageData(0, 0, W, H).data; buildLayer(n);
      });
      pend.clear();
    });
    pend.add(l);
  };

  // 把螢幕座標投到「目前圖層所在的平面」，換算成畫布座標
  const ray = new T.Raycaster(), plane = new T.Plane(new T.Vector3(0, 0, 1)), hit = new T.Vector3();
  let br = null; // renderer 畫布的 rect 也只隨版面變動，理由同 stageRect()
  const aim = ev => {
    const r = br || (br = renderer.domElement.getBoundingClientRect());
    ray.setFromCamera({ x: (ev.clientX - r.left) / r.width * 2 - 1, y: -((ev.clientY - r.top) / r.height * 2 - 1) }, cam);
  };
  const pick = ev => {
    const n = ls.findIndex(e => e.l === cur); if (n < 0) return null;
    aim(ev);
    plane.constant = -zOf(n);
    return ray.ray.intersectPlane(plane, hit) ? [hit.x + W / 2, H / 2 - hit.y] : null;
  };
  let mode = 0; // 0 畫圖 1 旋轉 2 擺姿勢
  tog('m3mode', true, '模式：畫圖', '');
  $('m3mode').onclick = () => {
    mode = (mode + 1) % 3;
    $('m3mode').textContent = ['模式：畫圖', '模式：旋轉', '模式：擺姿勢'][mode]; $('m3mode').classList.toggle('on', mode !== 1);
  };
  const dragPlane = new T.Plane(), P = new T.Vector3();
  const tp = new Set(); // 3D 視窗內按著的手指
  const down = e => {
    if (e.pointerType === 'touch') {
      tp.add(e.pointerId);
      if (tp.size > 1) { if (last) { cancelStroke(); refresh3d(cur); } return; } // 第二指是手勢，不另起一筆
    }
    if (mode === 2) {
      if (!man.visible) return;
      aim(e);
      const h = ray.intersectObjects(J.map(j => j.mesh))[0]; if (!h) return;
      grab = h.object.userData.j; grab.pid = e.pointerId;
      dragPlane.setFromNormalAndCoplanarPoint(cam.getWorldDirection(P).clone(), h.point);
      e.stopPropagation(); box.setPointerCapture(e.pointerId); grab.mesh.material = hot; invalidate(); return;
    }
    if (e.pointerType !== 'pen' && mode !== 0) return;
    const p = pick(e); if (!p) return;
    e.stopPropagation(); box.setPointerCapture(e.pointerId);
    startStroke(e, p); refresh3d(cur);
  };
  let rt = 0;
  const move = e => {
    if (grab) {
      if (e.pointerId !== grab.pid) return;
      e.stopPropagation(); aim(e);
      if (!ray.ray.intersectPlane(dragPlane, P)) return;
      man.worldToLocal(P);
      const par = grab.par >= 0 ? J[grab.par].pos : null;
      if (par) P.sub(par).setLength(grab.len).add(par); // 骨長固定
      const d = P.sub(grab.pos).clone();
      sub(grab, j => j.pos.add(d)); invalidate();
      return;
    }
    if (!last || e.pointerId !== sid) return;
    e.stopPropagation();
    for (const ev of evs(e)) { const p = pick(ev); if (p) strokeTo(p, ev); }
    strokeMoved(e);
    // ponytail: 節流整層重建（約 10fps）；要更即時再改成只重建筆劃範圍的方塊
    if (performance.now() - rt > 100) { rt = performance.now(); refresh3d(cur); }
  };
  const up = e => {
    tp.delete(e.pointerId);
    if (grab && e.pointerId === grab.pid) { grab.mesh.material = jmat; grab = null; invalidate(); return; }
    if (!last || e.pointerId !== sid) return; e.stopPropagation();
    if (e.type === 'pointercancel') cancelStroke(); else finishStroke();
    refresh3d(cur);
  };
  box.addEventListener('pointerdown', down, true);
  box.addEventListener('pointermove', move, true);
  box.addEventListener('pointerup', up, true);
  box.addEventListener('pointercancel', up, true);

  const resize = () => { br = null; const w = box.clientWidth, h = box.clientHeight; renderer.setSize(w, h); cam.aspect = w / h; cam.updateProjectionMatrix(); invalidate(); };
  $('depth').oninput = $('gap').oninput = $('res').onchange = build;
  addEventListener('resize', resize);
  stop3d = () => {
    manPose = J.map(j => j.pos.toArray());
    cancelAnimationFrame(raf); raf = 0; cancelAnimationFrame(anim); removeEventListener('resize', resize);
    ['pointerdown', 'pointermove', 'pointerup', 'pointercancel'].forEach((t, i) => box.removeEventListener(t, [down, move, up, up][i], true));
    scene.traverse(o => o.geometry?.dispose()); ls.forEach(e => e.mesh?.dispose()); [geo, mat, jmat, hot].forEach(x => x.dispose());
    ctl.dispose(); renderer.dispose(); renderer.forceContextLoss(); renderer.domElement.remove(); m3.style.display = 'none'; $('minimap').style.display = '';
    lock(false); stop3d = refresh3d = null; list();
  };
  resize(); build();
}
$('d3').onclick = open3d;
$('m3x').onclick = () => stop3d?.();

// 匯入圖片當底圖：放在最底層之上、等比縮放置中、預設半透明；不改變目前選取的圖層
$('imp').onclick = () => $('impf').click();
$('impf').onchange = async e => {
  const f = e.target.files[0]; e.target.value = ''; if (!f) return;
  const img = await createImageBitmap(f).catch(() => null);
  if (!img) return alert('無法讀取這個圖片');
  const prev = cur; cur = layers[0]; addLayer();
  const base = cur;
  base.img = img; base.raw = f; base.tf = fitTf(img); paintTf(base.ctx, img, base.tf);
  base.name = '底圖'; base.c.style.opacity = .5;
  cur = prev; list(base);
};

const download = (blob, name) => {
  const u = URL.createObjectURL(blob);
  Object.assign(document.createElement('a'), { href: u, download: name }).click();
  setTimeout(() => URL.revokeObjectURL(u), 10000);
};
$('save').onclick = () => {
  const o = Object.assign(document.createElement('canvas'), { width: W, height: H }), x = o.getContext('2d');
  layers.filter(l => l.visible).forEach(l => {
    x.globalAlpha = l.c.style.opacity || 1;
    x.globalCompositeOperation = l.blend || l.c.style.mixBlendMode || 'source-over';
    x.drawImage(l.c, 0, 0);
  });
  x.globalCompositeOperation = 'source-over';
  // toBlob 直接產生二進位，不必先組出數 MB 的 base64 字串
  o.toBlob(b => b && download(b, 'drawing.png'), 'image/png');
};

// --- 專案檔（.lpaint）：每個圖層存成一張 PNG，加一段 JSON 中介資料，下次可以接著編輯 ---
// 容器： "LPNT" | u8 版本 | u32 metaLen | meta(JSON) | u32 n | n × (u32 len + PNG bytes)
const P_VER = 1;
// 專案檔可能帶來不同尺寸的畫布，共用的畫布必須一起換掉
function setDocSize(w, h) {
  W = w; H = h; fitThumbSize();
  [snapC, rdC, tmp, pred].forEach(c => { c.width = w; c.height = h; });
  wrap.style.width = w + 'px'; wrap.style.height = h + 'px';
  resizeMinimap?.();
  if ($('doc-tab-title')) $('doc-tab-title').textContent = `未命名-1 · ${W}×${H}`;
}
async function saveProject() {
  // 原始底圖存「匯入時那個檔案本身的位元組」，不是重新編碼：一張照片轉 PNG 會膨脹好幾倍，
  // 而且原檔存下來才能真正無損地重複變形
  const withRaw = $('praw').checked;
  const meta = {
    w: W, h: H, cur: layers.indexOf(cur), guide: { ...guide },
    layers: layers.map(l => ({
      name: l.name, visible: !!l.visible, locked: !!l.locked, opacity: +(l.c.style.opacity || 1), guide: !!l.guide, bg: !!l.bg,
      raw: withRaw && l.raw ? (l.raw.type || 'image/png') : null,
      tf: l.tf ? { ...l.tf } : null, // 底圖目前的變形，還原後才能接著微調
    })),
  };
  const pngs = await Promise.all(layers.map(l => new Promise(r => l.c.toBlob(r, 'image/png'))));
  const mb = new TextEncoder().encode(JSON.stringify(meta));
  const u32 = v => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v, true); return b; };
  const head = new Uint8Array(5 + 4 + mb.length + 4);
  head.set([76, 80, 78, 84], 0);                       // "LPNT"
  head[4] = P_VER;
  head.set(u32(mb.length), 5); head.set(mb, 9);
  head.set(u32(layers.length), 9 + mb.length);
  const parts = [head];
  layers.forEach((l, i) => {
    parts.push(u32(pngs[i].size), pngs[i]);
    if (meta.layers[i].raw) parts.push(u32(l.raw.size), l.raw); // 有勾選才附上原始檔
  });
  download(new Blob(parts, { type: 'application/octet-stream' }), 'drawing.lpaint');
}
async function openProject(file) {
  const buf = await file.arrayBuffer(), u8 = new Uint8Array(buf), dv = new DataView(buf);
  if (u8[0] !== 76 || u8[1] !== 80 || u8[2] !== 78 || u8[3] !== 84) throw new Error('不是 .lpaint 專案檔');
  if (dv.getUint8(4) !== P_VER) throw new Error('專案檔版本不支援（' + dv.getUint8(4) + '）');
  let p = 5;
  const ml = dv.getUint32(p, true); p += 4;
  const meta = JSON.parse(new TextDecoder().decode(u8.subarray(p, p + ml))); p += ml;
  const cnt = dv.getUint32(p, true); p += 4;
  const read = () => { const len = dv.getUint32(p, true); p += 4;
    if (p + len > u8.length) throw new Error('專案檔損毀');
    const b = new Blob([u8.subarray(p, p + len)]); p += len; return b; };
  const parts = [], raws = [];
  for (let i = 0; i < cnt; i++) {
    parts.push(read());
    raws.push(meta.layers && meta.layers[i] && meta.layers[i].raw ? read() : null);
  }
  if (!cnt || !meta || !(meta.w > 0) || !(meta.h > 0)) throw new Error('專案檔沒有圖層');
  stop3d?.(); endTf();
  if (meta.w !== W || meta.h !== H) setDocSize(meta.w, meta.h);
  if (meta.guide) Object.assign(guide, meta.guide);
  const made = [];
  for (let i = 0; i < cnt; i++) {
    const m = (meta.layers && meta.layers[i]) || {};
    const c = Object.assign(document.createElement('canvas'), { width: W, height: H }), ctx = c.getContext('2d');
    const bm = await createImageBitmap(parts[i]).catch(() => null);
    if (bm) { ctx.drawImage(bm, 0, 0); bm.close(); }
    c.style.opacity = m.opacity != null && m.opacity < 1 ? m.opacity : '';
    // 有帶著原始檔就還原成可無損再變形的底圖（.tf 沿用預設，之後再變形會重新算）
    const L = { c, ctx, name: m.name || ('圖層 ' + (i + 1)), visible: m.visible !== false, locked: !!m.locked, guide: !!m.guide, raw: raws[i], tf: m.tf || undefined,
      bg: !!m.bg || (i === 0 && m.name === '背景') }; // 舊專案沒有 bg 旗標，用名稱推斷
    if (raws[i]) L.img = await createImageBitmap(raws[i]).catch(() => null);
    made.push(L);
  }
  layers.forEach(l => { l.c.remove(); dropImg(l); });
  thumbs.clear();
  layers = made; n = made.length;
  cur = layers[Math.min(Math.max(0, meta.cur | 0), layers.length - 1)];
  undos = []; redos = [];
  $('gmode').value = String(guide.mode || 0);
  sync(); fit(); sizeUi();
}
$('psave').onclick = () => saveProject();
$('popen').onclick = () => $('pfile').click();
$('pfile').onchange = async e => {
  const f = e.target.files[0]; e.target.value = ''; if (!f) return;
  try { await openProject(f); } catch (err) { alert('無法開啟這個檔案：' + err.message); }
};

// --- 紙張尺寸與版面規格系統 (Photon Studio 風格) ---
const PAPER_PRESETS = [
  { id: 'web', name: 'Web', w: 1920, h: 1080, desc: '1920 × 1080 px', natural: 'landscape', tag: '16:9' },
  { id: 'letter', name: 'Letter', w: 1275, h: 1650, desc: '8.5 × 11 in', natural: 'portrait', tag: '8.5 × 11 in' },
  { id: 'a4', name: 'A4', w: 1240, h: 1754, desc: '210 × 297 mm', natural: 'portrait', tag: '210 × 297 mm' },
  { id: 'photo', name: 'Photo', w: 1800, h: 1200, desc: '6 × 4 in', natural: 'landscape', tag: '6 × 4 in' },
  { id: 'insta', name: 'Instagram', w: 1080, h: 1350, desc: '1080 × 1350 px', natural: 'portrait', tag: '1080 × 1350 px' },
  { id: 'yt', name: 'YouTube', w: 1280, h: 720, desc: '1280 × 720 px', natural: 'landscape', tag: '1280 × 720 px' },
  { id: 'iphone', name: 'iPhone 16', w: 1179, h: 2556, desc: '1179 × 2556 px', natural: 'portrait', tag: '1179 × 2556 px' },
];

const MORE_PAPER_PRESETS = [
  { name: '插畫常用 3:4', w: 1200, h: 1600, desc: '1200 × 1600 px (經典畫布)' },
  { name: '方形 1:1', w: 1600, h: 1600, desc: '1600 × 1600 px (社群頭貼/方圖)' },
  { name: 'A3 原寸', w: 1754, h: 2480, desc: '297 × 420 mm (高畫質海報)' },
  { name: 'A5 便攜', w: 874, h: 1240, desc: '148 × 210 mm (隨身繪圖手帳)' },
  { name: 'B5 漫畫本', w: 1200, h: 1696, desc: '182 × 257 mm (同人誌)' },
  { name: '4K UHD', w: 3840, h: 2160, desc: '3840 × 2160 px 超高畫質' },
  { name: '2K QHD', w: 2560, h: 1440, desc: '2560 × 1440 px 繪圖螢幕' },
  { name: 'X / Twitter Banner', w: 1500, h: 500, desc: '1500 × 500 px (3:1 封面橫幅)' },
  { name: '手機 9:16', w: 1080, h: 1920, desc: '1080 × 1920 px (限時動態/Reels)' },
  { name: '漫畫原稿 B4', w: 1754, h: 2508, desc: '257 × 364 mm (專業印刷原稿)' },
];

const SIZES = [[1200, 1600, '3:4'], [1200, 1800, '2:3'], [1080, 1920, '9:16'], [1240, 1754, 'A4'], [1600, 1600, '1:1']];
$('vsize').append(
  ...SIZES.map(([w, h]) => new Option('', w + ',' + h)),
  new Option('自訂…', 'custom'));
const curOpt = new Option('', 'cur');

let ndIsLandscape = false;
let ndMode = 'new'; // 'new' (建立全新畫布) | 'resize' (裁切/調整現有畫布)

function sizeUi() {
  const a = Math.min(W, H), b = Math.max(W, H), s = $('vsize'), k = a + ',' + b;
  const preset = SIZES.some(([w, h]) => w + ',' + h === k);
  if (preset) curOpt.remove();
  else { curOpt.textContent = `${W}×${H}`; s.insertBefore(curOpt, s.querySelector('[value=custom]')); }
  s.value = preset ? k : 'cur';
  const land = W > H;
  SIZES.forEach(([w, h, t], i) => {
    const r = land && t.includes(':') ? t.split(':').reverse().join(':') : t;
    s.options[i].textContent = `${r}  ${land ? h : w}×${land ? w : h}`;
  });
  s.title = `目前 ${W}×${H}`;
  const o = $('vori');
  o.textContent = W === H ? '方形' : W > H ? '橫式' : '直式';
  o.disabled = W === H;

  // 更新 topbar 紙張尺寸按鈕與對話框狀態標籤
  const vl = $('vsize-label');
  if (vl) {
    const match = PAPER_PRESETS.find(p => Math.min(p.w, p.h) === a && Math.max(p.w, p.h) === b);
    vl.textContent = (match ? match.name + ' ' : '') + `${W}×${H}`;
  }
  const curSt = $('nd-cur-status');
  if (curSt) curSt.textContent = `目前畫布：${W} × ${H} px (${W === H ? '方形' : W > H ? '橫式' : '直式'})`;
  if ($('doc-tab-title')) {
    const match = PAPER_PRESETS.find(p => Math.min(p.w, p.h) === a && Math.max(p.w, p.h) === b);
    $('doc-tab-title').textContent = (match ? `${match.name} · ` : '未命名-1 · ') + `${W}×${H}`;
  }
}

function resizeDoc(w, h) {
  if (w === W && h === H) return sizeUi();
  if ((undos.length || w < W || h < H) &&
      !confirm(`版面改成 ${w}×${h}？\n內容以中心對齊不縮放，超出新版面的部分會被裁掉，復原紀錄也會清除。`)) return sizeUi();
  stop3d?.(); endTf();
  const dx = Math.round((w - W) / 2), dy = Math.round((h - H) / 2);
  layers.forEach(L => {
    const c = Object.assign(document.createElement('canvas'), { width: w, height: h }), x = c.getContext('2d');
    if (L.bg) { x.fillStyle = '#fff'; x.fillRect(0, 0, w, h); }
    x.drawImage(L.c, dx, dy);
    c.style.cssText = L.c.style.cssText;
    L.c.remove(); L.c = c; L.ctx = x;
  });
  guide.hy += dy; guide.v1 += dx; guide.v2 += dx; guide.v3x += dx; guide.v3y += dy;
  setDocSize(w, h); thumbs.clear(); undos = []; redos = [];
  sync(); fit(); sizeUi();
}

function createNewDoc(w, h, bgWhite = true) {
  stop3d?.(); endTf?.();
  layers.forEach(l => { l.c.remove(); dropImg(l); });
  thumbs.clear();
  layers = []; n = 0; undos = []; redos = [];
  setDocSize(w, h);
  addLayer(bgWhite); // 底層白色背景
  addLayer(false);   // 圖層 1
  cur = layers[1];
  sync(); fit(); sizeUi(); resizeMinimap?.();
}

async function openImageAsNewDoc(file) {
  const img = await createImageBitmap(file).catch(() => null);
  if (!img) return alert('無法讀取這張圖片');
  const w = Math.min(4096, Math.max(64, img.width));
  const h = Math.min(4096, Math.max(64, img.height));
  stop3d?.(); endTf?.();
  layers.forEach(l => { l.c.remove(); dropImg(l); });
  thumbs.clear();
  layers = []; n = 0; undos = []; redos = [];
  setDocSize(w, h);

  const c0 = Object.assign(document.createElement('canvas'), { width: w, height: h }), ctx0 = c0.getContext('2d');
  ctx0.drawImage(img, 0, 0, w, h);
  const L0 = { c: c0, ctx: ctx0, name: '底圖', visible: true, locked: false, bg: true, raw: file, img };
  layers.push(L0);

  n = 1;
  const c1 = Object.assign(document.createElement('canvas'), { width: w, height: h }), ctx1 = c1.getContext('2d');
  const L1 = { c: c1, ctx: ctx1, name: '圖層 1', visible: true, locked: false };
  layers.push(L1);

  cur = L1;
  sync(); fit(); sizeUi(); resizeMinimap?.();
}

function applyPaperPreset(targetW, targetH, presetName) {
  if (ndMode === 'new') {
    if (undos.length > 0 || layers.length > 2) {
      if (!confirm(`確定建立全新 ${presetName}（${targetW}×${targetH}）畫布？\n目前未存檔的筆觸將會清除。`)) return;
    }
    createNewDoc(targetW, targetH, true);
  } else {
    resizeDoc(targetW, targetH);
  }
  closeNewDocModal();
}

function renderPaperPresets(landscape) {
  const grid = $('nd-presets-grid');
  if (!grid) return;
  grid.innerHTML = '';

  PAPER_PRESETS.forEach(p => {
    let pw = p.w, ph = p.h;
    if (p.natural !== 'square') {
      pw = landscape ? Math.max(p.w, p.h) : Math.min(p.w, p.h);
      ph = landscape ? Math.min(p.w, p.h) : Math.max(p.w, p.h);
    }
    const isCur = pw === W && ph === H;

    const card = document.createElement('div');
    card.className = 'nd-card' + (isCur ? ' active' : '');
    card.title = `點擊套用：${p.name} ${pw}×${ph} px`;

    // 依長寬比精準計算縮圖矩形
    const maxW = 54, maxH = 44;
    let rw, rh;
    if (pw >= ph) {
      rw = maxW;
      rh = Math.max(14, Math.round(maxW * (ph / pw)));
    } else {
      rh = maxH;
      rw = Math.max(14, Math.round(maxH * (pw / ph)));
    }

    const dimLabel = landscape && p.natural === 'portrait' && p.tag.includes('×')
      ? p.tag.split('×').map(s => s.trim()).reverse().join(' × ')
      : p.tag;

    card.innerHTML = `
      <div class="nd-thumb-box">
        <div class="nd-thumb-rect" style="width:${rw}px;height:${rh}px"></div>
      </div>
      <div class="nd-card-name">${p.name}</div>
      <div class="nd-card-dim">${dimLabel}</div>
    `;
    card.onclick = () => applyPaperPreset(pw, ph, p.name);
    grid.appendChild(card);
  });

  // 自訂尺寸卡片
  const custCard = document.createElement('div');
  custCard.className = 'nd-card custom';
  custCard.title = '點擊自訂畫布長寬尺寸';
  custCard.innerHTML = `
    <div class="nd-thumb-box">
      <div class="nd-custom-icon">+</div>
    </div>
    <div class="nd-card-name">Custom Size</div>
    <div class="nd-card-dim">自訂尺寸</div>
  `;
  custCard.onclick = () => {
    const cp = $('nd-custom-panel');
    const mp = $('nd-more-panel');
    if (mp) mp.style.display = 'none';
    if (cp) {
      const open = cp.style.display !== 'none';
      cp.style.display = open ? 'none' : 'block';
      if (!open) { $('nd-cust-w').focus(); $('nd-cust-w').select(); }
    }
  };
  grid.appendChild(custCard);

  // 更多規格卡片
  const moreCard = document.createElement('div');
  moreCard.className = 'nd-card';
  moreCard.title = '更多紙張與螢幕規格';
  moreCard.innerHTML = `
    <div class="nd-thumb-box">
      <div class="nd-more-icon">
        <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.8">
          <rect x="7" y="7" width="13" height="13" rx="2" ry="2"/>
          <path d="M4 17V4a2 2 0 0 1 2-2h13"/>
        </svg>
      </div>
    </div>
    <div class="nd-card-name">More Presets</div>
    <div class="nd-card-dim">更多規格</div>
  `;
  moreCard.onclick = () => {
    const cp = $('nd-custom-panel');
    const mp = $('nd-more-panel');
    if (cp) cp.style.display = 'none';
    if (mp) {
      const open = mp.style.display !== 'none';
      mp.style.display = open ? 'none' : 'block';
      if (!open) renderMorePaperPresets();
    }
  };
  grid.appendChild(moreCard);
}

function renderMorePaperPresets() {
  const mgrid = $('nd-more-grid');
  if (!mgrid) return;
  mgrid.innerHTML = '';
  MORE_PAPER_PRESETS.forEach(p => {
    let pw = ndIsLandscape ? Math.max(p.w, p.h) : Math.min(p.w, p.h);
    let ph = ndIsLandscape ? Math.min(p.w, p.h) : Math.max(p.w, p.h);
    const item = document.createElement('div');
    item.className = 'nd-more-item';
    item.innerHTML = `
      <div class="nd-more-item-name">${p.name}</div>
      <div class="nd-more-item-dim">${pw} × ${ph} (${p.desc})</div>
    `;
    item.onclick = () => applyPaperPreset(pw, ph, p.name);
    mgrid.appendChild(item);
  });
}

function openNewDocModal() {
  const m = $('new-doc-modal');
  if (!m) return;
  ndIsLandscape = W > H;
  $('nd-ori-portrait').classList.toggle('active', !ndIsLandscape);
  $('nd-ori-landscape').classList.toggle('active', ndIsLandscape);
  $('nd-cust-w').value = W;
  $('nd-cust-h').value = H;
  const cp = $('nd-custom-panel'); if (cp) cp.style.display = 'none';
  const mp = $('nd-more-panel'); if (mp) mp.style.display = 'none';
  renderPaperPresets(ndIsLandscape);
  sizeUi();
  m.style.display = 'flex';
}

function closeNewDocModal() {
  const m = $('new-doc-modal');
  if (m) m.style.display = 'none';
}

// 綁定新畫布對話框操作
$('btn-new-doc').onclick = openNewDocModal;
$('btn-paper-select').onclick = openNewDocModal;
$('nd-backdrop').onclick = closeNewDocModal;
$('nd-btn-close').onclick = closeNewDocModal;
$('nd-dot-close').onclick = closeNewDocModal;
$('nd-dot-min').onclick = closeNewDocModal;

$('nd-tab-new').onclick = () => {
  $('nd-tab-new').classList.add('active');
  $('nd-tab-open').classList.remove('active');
  $('nd-tab-imp').classList.remove('active');
};
$('nd-tab-open').onclick = () => { closeNewDocModal(); $('pfile').click(); };
$('nd-tab-imp').onclick = () => { closeNewDocModal(); $('impf').click(); };

$('nd-ori-portrait').onclick = () => {
  ndIsLandscape = false;
  $('nd-ori-portrait').classList.add('active');
  $('nd-ori-landscape').classList.remove('active');
  renderPaperPresets(false);
  if ($('nd-more-panel').style.display !== 'none') renderMorePaperPresets();
};
$('nd-ori-landscape').onclick = () => {
  ndIsLandscape = true;
  $('nd-ori-portrait').classList.remove('active');
  $('nd-ori-landscape').classList.add('active');
  renderPaperPresets(true);
  if ($('nd-more-panel').style.display !== 'none') renderMorePaperPresets();
};

$('nd-mode-new').onclick = () => {
  ndMode = 'new';
  $('nd-mode-new').classList.add('active');
  $('nd-mode-resize').classList.remove('active');
};
$('nd-mode-resize').onclick = () => {
  ndMode = 'resize';
  $('nd-mode-resize').classList.add('active');
  $('nd-mode-new').classList.remove('active');
};

$('nd-cust-apply').onclick = () => {
  const w = Math.min(4096, Math.max(64, parseInt($('nd-cust-w').value, 10) || 1200));
  const h = Math.min(4096, Math.max(64, parseInt($('nd-cust-h').value, 10) || 1600));
  applyPaperPreset(w, h, '自訂尺寸');
};
$('nd-cust-cancel').onclick = () => {
  $('nd-custom-panel').style.display = 'none';
};

// 拖曳上傳與檔案選擇
const dz = $('nd-dropzone');
$('nd-dz-browse').onclick = e => {
  e.stopPropagation();
  $('impf').click();
  closeNewDocModal();
};
dz.onclick = () => {
  $('impf').click();
  closeNewDocModal();
};
dz.ondragover = e => {
  e.preventDefault();
  dz.classList.add('dragover');
};
dz.ondragleave = () => dz.classList.remove('dragover');
dz.ondrop = async e => {
  e.preventDefault();
  dz.classList.remove('dragover');
  const file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
  if (!file) return;
  if (file.name.endsWith('.lpaint')) {
    try {
      await openProject(file);
      closeNewDocModal();
    } catch (err) {
      alert('無法開啟專案：' + err.message);
    }
  } else if (file.type.startsWith('image/')) {
    try {
      await openImageAsNewDoc(file);
      closeNewDocModal();
    } catch (err) {
      alert('無法讀取圖片：' + err.message);
    }
  } else {
    alert('請拖曳圖片檔 (PNG/JPEG/WebP) 或 .lpaint 專案檔');
  }
};

$('vsize').onchange = e => {
  const val = e.target.value;
  if (val === 'cur') return;
  if (val === 'custom') {
    openNewDocModal();
    $('nd-custom-panel').style.display = 'block';
    return;
  }
  const [a, b] = val.split(',').map(Number);
  W > H ? resizeDoc(b, a) : resizeDoc(a, b);
};
$('vori').onclick = () => resizeDoc(H, W);

addLayer(true); addLayer(); sizeUi(); resizeMinimap();
renderHardnessBar(); renderNibBar(); renderWcTypesBar(); updateBrushSubpanels();

// --- iPad 側邊 Procreate 風格快速滑桿與長按臨時橡皮擦 ---
let quickBarOn = true;
try { quickBarOn = localStorage.getItem('quick_bar_on') !== '0'; } catch {}

function updateQuickBar() {
  const bar = $('ipad-quick-bar');
  if (bar) bar.style.display = quickBarOn ? 'flex' : 'none';
  if (!quickBarOn) return;

  const sz = +$('size').value;
  const szPct = (sz - 1) / (100 - 1);
  const sizeFill = $('iq-size-fill'), sizeThumb = $('iq-size-thumb'), sizeBadge = $('iq-size-badge');
  if (sizeFill) sizeFill.style.height = `${szPct * 100}%`;
  if (sizeThumb) sizeThumb.style.bottom = `${szPct * 100}%`;
  if (sizeBadge) sizeBadge.textContent = String(sz);

  const al = +$('alpha').value;
  const alPct = (al - 5) / (100 - 5);
  const alFill = $('iq-alpha-fill'), alThumb = $('iq-alpha-thumb'), alBadge = $('iq-alpha-badge');
  if (alFill) alFill.style.height = `${alPct * 100}%`;
  if (alThumb) alThumb.style.bottom = `${alPct * 100}%`;
  if (alBadge) alBadge.textContent = `${al}%`;

  const btn = $('iq-btn-tool');
  if (btn) {
    btn.textContent = eraser ? '⌫' : '✎';
    btn.classList.toggle('eraser-active', eraser);
    btn.title = eraser ? '目前為橡皮擦（點擊回筆刷）' : '目前為筆刷（點擊換橡皮擦，長按可臨時擦拭）';
  }
}

function initQuickSlider(wrapId, onValChange) {
  const wrap = $(wrapId);
  if (!wrap) return;
  const track = wrap.querySelector('.iq-track');
  let dragging = false;

  const updateFromY = clientY => {
    const rect = track.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, 1 - (clientY - rect.top) / rect.height));
    onValChange(ratio);
    updateQuickBar();
  };

  wrap.addEventListener('pointerdown', e => {
    dragging = true;
    try { wrap.setPointerCapture(e.pointerId); } catch {}
    updateFromY(e.clientY);
  });
  window.addEventListener('pointermove', e => {
    if (dragging) updateFromY(e.clientY);
  });
  const stop = () => { dragging = false; };
  window.addEventListener('pointerup', stop);
  window.addEventListener('pointercancel', stop);
}

function initIpadQuickBar() {
  initQuickSlider('iq-size-wrap', ratio => {
    const v = Math.round(1 + ratio * (100 - 1));
    $('size').value = v;
    $('size').dispatchEvent(new Event('input'));
  });
  initQuickSlider('iq-alpha-wrap', ratio => {
    const v = Math.round(5 + ratio * (100 - 5));
    $('alpha').value = v;
    $('alpha').dispatchEvent(new Event('input'));
  });

  const btn = $('iq-btn-tool');
  if (btn) {
    let pressTimer = null, isLongPress = false, prevToolWasBrush = false;

    btn.addEventListener('pointerdown', e => {
      btn.setPointerCapture(e.pointerId);
      isLongPress = false;
      prevToolWasBrush = !eraser;
      pressTimer = setTimeout(() => {
        isLongPress = true;
        if (prevToolWasBrush) {
          setEraser(true);
        }
      }, 220); // 長按 220ms 啟動臨時橡皮擦
    });

    btn.addEventListener('pointerup', () => {
      clearTimeout(pressTimer);
      if (isLongPress) {
        if (prevToolWasBrush) setEraser(false);
      } else {
        setEraser(!eraser);
      }
      isLongPress = false;
    });

    btn.addEventListener('pointercancel', () => {
      clearTimeout(pressTimer);
      if (isLongPress && prevToolWasBrush) setEraser(false);
      isLongPress = false;
    });
  }

  $('size').addEventListener('input', updateQuickBar);
  $('alpha').addEventListener('input', updateQuickBar);
  updateQuickBar();
}

function initIpadSettings() {
  if ($('palm-reject')) {
    let palm = true;
    try { palm = localStorage.getItem('palm_reject') !== '0'; } catch {}
    $('palm-reject').checked = palm;
    $('palm-reject').onchange = e => {
      try { localStorage.setItem('palm_reject', e.target.checked ? '1' : '0'); } catch {}
    };
  }

  if ($('pencil-hover')) {
    $('pencil-hover').checked = pencilHoverOn;
    $('pencil-hover').onchange = e => {
      pencilHoverOn = e.target.checked;
      try { localStorage.setItem('pencil_hover', pencilHoverOn ? '1' : '0'); } catch {}
      if (!pencilHoverOn && hoverCur) { hoverCur = null; drawECur(); }
    };
  }

  if ($('quick-bar-on')) {
    $('quick-bar-on').checked = quickBarOn;
    $('quick-bar-on').onchange = e => {
      quickBarOn = e.target.checked;
      try { localStorage.setItem('quick_bar_on', quickBarOn ? '1' : '0'); } catch {}
      updateQuickBar();
    };
  }

  $('pressure-seg')?.querySelectorAll('button').forEach(b => {
    b.classList.toggle('on', +b.dataset.curve === pressureCurve);
    b.onclick = () => {
      pressureCurve = +b.dataset.curve;
      try { localStorage.setItem('pressure_curve', String(pressureCurve)); } catch {}
      $('pressure-seg').querySelectorAll('button').forEach(btn => {
        btn.classList.toggle('on', +btn.dataset.curve === pressureCurve);
      });
    };
  });
}

initIpadQuickBar();
initIpadSettings();

// --- Photon Studio 專業三欄工作區互動綁定 ---
let ltBgColor = '#ffffff';

function swapColors() {
  const fg = $('color').value;
  $('color').value = ltBgColor;
  ltBgColor = fg;
  toolUi();
  updateStudioSwatchesActive();
}

function resetColors() {
  $('color').value = '#1a1a1a';
  ltBgColor = '#ffffff';
  toolUi();
  updateStudioSwatchesActive();
}

const STUDIO_SWATCHES = [
  '#ffffff', '#e5e7eb', '#d1d5db', '#9ca3af', '#6b7280', '#4b5563', '#1f2937', '#000000',
  '#ef4444', '#f97316', '#f59e0b', '#10b981', '#06b6d4', '#3b82f6', '#6366f1', '#ec4899',
  '#fca5a5', '#fdba74', '#fde047', '#a7f3d0', '#bae6fd', '#c7d2fe', '#78350f', '#831843'
];

function initStudioSwatches() {
  const container = $('studio-swatches');
  if (!container) return;
  container.innerHTML = '';
  STUDIO_SWATCHES.forEach(hex => {
    const sw = document.createElement('div');
    sw.className = 'studio-swatch';
    sw.style.backgroundColor = hex;
    sw.dataset.hex = hex.toLowerCase();
    sw.title = hex;
    sw.onclick = () => {
      $('color').value = hex;
      if (eraser) {
        cancelEraserAutoRevert();
        setEraser(false);
      }
      toolUi();
      updateStudioSwatchesActive();
    };
    container.appendChild(sw);
  });
  updateStudioSwatchesActive();
}

function updateStudioSwatchesActive() {
  const cur = ($('color').value || '').toLowerCase();
  document.querySelectorAll('.studio-swatch').forEach(sw => {
    sw.classList.toggle('active', sw.dataset.hex === cur);
  });
}

function initStudioWorkspace() {
  // 1. 左側垂直工具列
  if ($('lt-tfm')) $('lt-tfm').onclick = () => $('tfm').click();
  if ($('lt-brush')) $('lt-brush').onclick = () => { cancelEraserAutoRevert(); setEraser(false); };
  if ($('lt-eraser')) $('lt-eraser').onclick = () => { cancelEraserAutoRevert(); setEraser(!eraser); };
  if ($('lt-pick')) $('lt-pick').onclick = () => $('pick').click();
  if ($('lt-pan')) $('lt-pan').onclick = () => fit();
  if ($('lt-zoom')) $('lt-zoom').onclick = () => zoomDetail(1.0);
  if ($('lt-swatch-swap')) $('lt-swatch-swap').onclick = swapColors;
  if ($('lt-swatch-reset')) $('lt-swatch-reset').onclick = resetColors;
  if ($('lt-color-picker')) {
    $('lt-color-picker').oninput = e => {
      $('color').value = e.target.value;
      toolUi();
      updateStudioSwatchesActive();
    };
  }

  // 2. 畫布標籤列
  if ($('doc-active-tab')) {
    $('doc-active-tab').onclick = e => {
      if (e.target.id === 'doc-tab-new-btn') return;
      openNewDocModal?.();
    };
  }
  if ($('doc-tab-new-btn')) {
    $('doc-tab-new-btn').onclick = e => {
      e.stopPropagation();
      openNewDocModal?.();
    };
  }
  if ($('tab-vfit')) $('tab-vfit').onclick = fit;
  if ($('tab-v100')) $('tab-v100').onclick = () => zoomDetail(1.0);

  // 3. 導航器 (Navigator)
  if ($('nav-zout')) $('nav-zout').onclick = () => $('zout').click();
  if ($('nav-zin')) $('nav-zin').onclick = () => $('zin').click();
  if ($('nav-zslider')) {
    $('nav-zslider').oninput = e => zoomTo(+e.target.value / 100);
  }
  if ($('nav-fit')) $('nav-fit').onclick = fit;
  if ($('nav-100')) $('nav-100').onclick = () => zoomDetail(1.0);
  if ($('nav-150')) $('nav-150').onclick = () => zoomTo(1.5);
  if ($('nav-200')) $('nav-200').onclick = () => zoomTo(2.0);

  // 4. 圖層混合模式
  if ($('lblend')) {
    $('lblend').onchange = e => {
      if (!cur) return;
      cur.blend = e.target.value;
      cur.c.style.mixBlendMode = e.target.value;
    };
  }

  // 5. 色票矩陣
  initStudioSwatches();
  $('color').addEventListener('input', () => {
    toolUi();
    updateStudioSwatchesActive();
  });

  toolUi();
  resizeMinimap();
}

initStudioWorkspace();

