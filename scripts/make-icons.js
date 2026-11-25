'use strict';

/**
 * PWA 圖示產生器
 * 執行：node scripts/make-icons.js
 *
 * 產出 public/icons/ 下：
 *   icon-192.png            一般用途
 *   icon-512.png            一般用途（安裝提示、啟動畫面）
 *   icon-maskable-512.png   Android 自適應圖示（內容縮至安全區內）
 *   apple-touch-icon.png    iOS 加入主畫面（180x180，不透明全出血）
 *   favicon-32.png          瀏覽器分頁
 *   icon.svg                向量原始檔
 */

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const OUT = path.join(__dirname, '..', 'public', 'icons');
const BRAND = '#1d4ed8';
const BRAND_DARK = '#0c2f8f';

/**
 * 產生圖示 SVG。
 * @param {number} inner 內容佔比（1 = 全出血；maskable 需縮小以避開圓形裁切）
 */
function iconSVG(inner = 1) {
  const S = 512;
  // 內容以中心為基準縮放
  const k = inner;
  const cx = S / 2;
  const cy = S / 2;
  // 以 transform 縮放整個內容群組
  const scale = `translate(${cx} ${cy}) scale(${k}) translate(${-cx} ${-cy})`;

  // 上升的 K 線：四根，價位遞增
  const candles = [
    { x: 118, top: 300, bodyH: 58, wickTop: 278, wickBottom: 372 },
    { x: 196, top: 252, bodyH: 64, wickTop: 228, wickBottom: 330 },
    { x: 274, top: 206, bodyH: 62, wickTop: 182, wickBottom: 282 },
    { x: 352, top: 152, bodyH: 70, wickTop: 128, wickBottom: 236 },
  ];

  const bars = candles.map((c) => `
    <rect x="${c.x - 4}" y="${c.wickTop}" width="8" height="${c.wickBottom - c.wickTop}" rx="4" fill="#ffffff" opacity="0.72"/>
    <rect x="${c.x - 26}" y="${c.top}" width="52" height="${c.bodyH}" rx="10" fill="#ffffff"/>`).join('');

  // 上升箭頭（由左下到右上）
  const arrow = `
    <path d="M132 388 L300 236" stroke="#ffffff" stroke-width="20" stroke-linecap="round" fill="none" opacity="0.95"/>
    <path d="M262 224 L314 218 L308 270" stroke="#ffffff" stroke-width="20" stroke-linecap="round" stroke-linejoin="round" fill="none" opacity="0.95"/>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${S} ${S}" width="${S}" height="${S}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${BRAND}"/>
      <stop offset="100%" stop-color="${BRAND_DARK}"/>
    </linearGradient>
  </defs>
  <rect width="${S}" height="${S}" fill="url(#bg)"/>
  <g transform="${scale}">
    ${bars}
    ${arrow}
  </g>
</svg>`;
}

/** maskable 版本：內容縮至 68%，確保落在 Android 安全區（圓形直徑 80%）內 */
function iconSVGMaskable() {
  const S = 512;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${S} ${S}" width="${S}" height="${S}">
  <defs>
    <linearGradient id="bgm" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${BRAND}"/>
      <stop offset="100%" stop-color="${BRAND_DARK}"/>
    </linearGradient>
  </defs>
  <rect width="${S}" height="${S}" fill="url(#bgm)"/>
  <g transform="translate(256 256) scale(0.66) translate(-256 -256)">
    <rect x="92" y="274" width="8" height="94" rx="4" fill="#ffffff" opacity="0.72"/>
    <rect x="66" y="300" width="52" height="58" rx="10" fill="#ffffff"/>
    <rect x="170" y="226" width="8" height="102" rx="4" fill="#ffffff" opacity="0.72"/>
    <rect x="144" y="252" width="52" height="64" rx="10" fill="#ffffff"/>
    <rect x="248" y="180" width="8" height="100" rx="4" fill="#ffffff" opacity="0.72"/>
    <rect x="222" y="206" width="52" height="62" rx="10" fill="#ffffff"/>
    <rect x="326" y="126" width="8" height="108" rx="4" fill="#ffffff" opacity="0.72"/>
    <rect x="300" y="152" width="52" height="70" rx="10" fill="#ffffff"/>
    <path d="M132 388 L300 236" stroke="#ffffff" stroke-width="20" stroke-linecap="round" fill="none" opacity="0.95"/>
    <path d="M262 224 L314 218 L308 270" stroke="#ffffff" stroke-width="20" stroke-linecap="round" stroke-linejoin="round" fill="none" opacity="0.95"/>
  </g>
</svg>`;
}

/** apple-touch-icon：iOS 會自行加上圓角遮罩，故採全出血不透明、無圓角 */
function iconSVGApple() {
  return iconSVG(0.82);
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });

  const render = async (svg, size, file, opts = {}) => {
    let img = sharp(Buffer.from(svg)).resize(size, size, { fit: 'cover' });
    if (!opts.alpha) img = img.flatten({ background: BRAND });
    await img.png({ compressionLevel: 9 }).toFile(path.join(OUT, file));
    const st = fs.statSync(path.join(OUT, file));
    console.log(`  ✓ ${file.padEnd(26)} ${size}×${size}  ${(st.size / 1024).toFixed(1)} KB`);
  };

  console.log('\n產生 PWA 圖示 →  public/icons/\n');

  // 一般圖示：圓角由 CSS / 平台處理，PNG 本身保留圓角外觀需透明
  const rounded = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${BRAND}"/>
        <stop offset="100%" stop-color="${BRAND_DARK}"/>
      </linearGradient>
      <clipPath id="rc"><rect width="512" height="512" rx="112" ry="112"/></clipPath>
    </defs>
    <g clip-path="url(#rc)">
      <rect width="512" height="512" fill="url(#bg)"/>
    </g>
    ${iconSVG(1).replace(/^[\s\S]*?<g transform="translate\(256 256\)[^"]*">/, '<g transform="translate(256 256) scale(0.92) translate(-256 -256)">').replace(/<\/svg>\s*$/, '')}
  </svg>`;

  // 逐一產生（rounded 用於一般；maskable 用全出血；apple 用全出血）
  const tasks = [
    [rounded, 192, 'icon-192.png', { alpha: true }],
    [rounded, 512, 'icon-512.png', { alpha: true }],
    [iconSVGMaskable(), 512, 'icon-maskable-512.png', { alpha: false }],
    [iconSVGApple(), 180, 'apple-touch-icon.png', { alpha: false }],
    [rounded, 32, 'favicon-32.png', { alpha: true }],
  ];

  for (const [svg, size, file, opts] of tasks) {
    await render(svg, size, file, opts);
  }

  // 向量原始檔
  fs.writeFileSync(path.join(OUT, 'icon.svg'), rounded, 'utf8');
  console.log(`  ✓ icon.svg                  向量原始檔`);

  console.log('\n完成。\n');
}

main().catch((e) => {
  console.error('圖示產生失敗：', e.message);
  process.exit(1);
});
