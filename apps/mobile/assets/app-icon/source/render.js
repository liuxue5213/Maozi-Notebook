// 由 source/icon.svg 与 source/foreground.svg 渲染各平台图标尺寸。
// 用法：NODE_PATH=<workspace>/node_modules node render.js
const fs = require('fs');
const path = require('path');
const { Resvg } = require('@resvg/resvg-js');

const here = __dirname;
const out = path.join(here, '..');

const iconSvg = fs.readFileSync(path.join(here, 'icon.svg'), 'utf8');
const fgSvg = fs.readFileSync(path.join(here, 'foreground.svg'), 'utf8');

const IOS_SIZES = [1024, 180, 167, 152, 120, 87, 80, 58, 40, 29];
const ANDROID_SIZES = [
  ['play-store', 512],
  ['mipmap-xxxhdpi', 192],
  ['mipmap-xxhdpi', 144],
  ['mipmap-xhdpi', 96],
  ['mipmap-hdpi', 72],
  ['mipmap-mdpi', 48],
];

function render(svg, size) {
  const r = new Resvg(svg, { fitTo: { mode: 'width', value: size } });
  return r.render().asPng();
}

function write(file, buf) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buf);
  console.log(`${path.relative(out, file)}  ${buf.length} bytes`);
}

// 主图标（含品牌蓝底，不透明）—— iOS / 通用
for (const size of IOS_SIZES) {
  write(path.join(out, 'ios', `icon-${size}.png`), render(iconSvg, size));
}

// Android 桌面图标（方形满幅，不透明）
for (const [dir, size] of ANDROID_SIZES) {
  write(path.join(out, 'android', dir, 'ic_launcher.png'), render(iconSvg, size));
}

// Android 自适应图标前景（透明底，内容收在 66dp 安全区内）
const fg432 = render(fgSvg, 432);
write(path.join(out, 'android', 'adaptive-icon-foreground.png'), fg432);

// Expo 直接引用的三张
write(path.join(out, '..', 'icon.png'), render(iconSvg, 1024));
write(path.join(out, '..', 'adaptive-icon.png'), fg432);
write(path.join(out, '..', 'splash-icon.png'), fg432);

console.log('done');
