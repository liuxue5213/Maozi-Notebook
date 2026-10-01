#!/usr/bin/env node
/**
 * 将 expo 57.0 prebuild 产物对齐到 AGP 9.2.1 / Gradle 9.4.1 / Kotlin 2.3.0。
 *
 * 为什么必须打这个补丁:
 *   React Native 0.87.1 的 gradle 插件在其版本目录里钉死了 agp = "9.2.1"、
 *   kotlin = "2.2.0",并且**故意用 implementation(而非 compileOnly)把它们带进
 *   构建类路径**(见 @react-native/gradle-plugin/gradle/libs.versions.toml 与其
 *   build.gradle.kts 注释)。于是整个构建被强制升到 AGP 9;
 *   而 expo-modules-core 57.0.19 的 expo-module-gradle-plugin 是按 AGP 8.5 写的,
 *   在 AGP 9 下源码编译不过、运行时类也不匹配。
 *   本脚本做的是"把 expo 插件源码迁移到 AGP 9 API",属于上游版本冲突的临时兜底,
 *   等 expo 官方发布适配 AGP 9 的 expo-modules-core 后即可整体删除。
 *
 * 用 Node 而非 Python 的原因:本项目是 Node/TS 技术栈,CI runner 已装 Node,
 * 不额外引入 Python 解释器依赖。
 *
 * 幂等:重复运行无副作用(第二次运行 patched 数为 0)。
 * 用法: node scripts/patch-expo-agp9.mjs [仓库根路径]
 *       缺省取 $GITHUB_WORKSPACE,再缺省取 cwd。
 */

import fs from 'node:fs';
import path from 'node:path';

const root = process.argv[2] || process.env.GITHUB_WORKSPACE || process.cwd();
const ws = path.join(root, 'node_modules');
if (!fs.existsSync(ws)) {
  console.error(`node_modules not found under ${root}`);
  process.exit(1);
}

let changed = 0;

function save(file, next) {
  fs.writeFileSync(file, next);
  changed += 1;
  console.log('patched:', path.relative(root, file));
}

/** 递归收集 node_modules 下需要检查的文件 */
function collect(dir, out = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      collect(full, out);
    } else if (e.isFile()) {
      out.push(full);
    }
  }
  return out;
}

const allFiles = collect(ws);
const norm = (p) => p.split(path.sep).join('/');

const ktsFiles = allFiles.filter((f) => f.endsWith('.gradle.kts'));
const androidBuildGradle = allFiles.filter(
  (f) => path.basename(f) === 'build.gradle' && path.basename(path.dirname(f)) === 'android',
);
const expoPluginKt = allFiles.filter(
  (f) => f.endsWith('.kt') && norm(f).includes('expo-module-gradle-plugin/src/'),
);
const expoPluginBuildKts = ktsFiles.filter((f) => norm(f).includes('expo-module-gradle-plugin/'));

// ---- 1) 内置 gradle 插件:Kotlin 统一 2.3.0 + 迁移废弃 DSL ----
// Gradle 9.4.1 自带 Kotlin 2.3.0,插件里钉死的旧版本元数据与之不兼容。
const RE_KOTLIN_JVM = /kotlin\("jvm"\) version "[^"]+"/g;
const RE_KOTLIN_SER = /kotlin\("plugin\.serialization"\) version "[^"]+"/g;
const RE_JVM_TARGET =
  /kotlinOptions \{(\s*)jvmTarget = JavaVersion\.VERSION_11\.toString\(\)(\s*)\}/g;

for (const f of ktsFiles) {
  const s = fs.readFileSync(f, 'utf8');
  let s2 = s.replace(RE_KOTLIN_JVM, 'kotlin("jvm") version "2.3.0"');
  s2 = s2.replace(RE_KOTLIN_SER, 'kotlin("plugin.serialization") version "2.3.0"');
  s2 = s2.replace(
    RE_JVM_TARGET,
    (_m, a, b) =>
      `compilerOptions {${a}jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_11)${b}}`,
  );
  if (s2 !== s) save(f, s2);
}

// ---- 2) AGP 9 内置 Kotlin:移除旧式 kotlin-android 应用(会重复注册 'kotlin' 扩展) ----
for (const f of androidBuildGradle) {
  const s = fs.readFileSync(f, 'utf8');
  let s2 = s
    .replace(/apply plugin: "kotlin-android"/g, '// AGP9 built-in kotlin')
    .replace(/apply plugin: 'kotlin-android'/g, '// AGP9 built-in kotlin');
  if (s2 !== s) save(f, s2);
}
for (const f of expoPluginKt) {
  const s = fs.readFileSync(f, 'utf8');
  const s2 = s.replace(/plugins\.apply\("kotlin-android"\)/g, '// AGP9 built-in kotlin');
  if (s2 !== s) save(f, s2);
}

// ---- 3) expo-module-gradle-plugin:编译依赖从 AGP 8.5 升到 9.2.1(与 RN 强制值一致) ----
for (const f of expoPluginBuildKts) {
  const s = fs.readFileSync(f, 'utf8');
  const s2 = s.replace(
    'compileOnly("com.android.tools.build:gradle:8.5.0")',
    'compileOnly("com.android.tools.build:gradle:9.2.1")',
  );
  if (s2 !== s) save(f, s2);
}

// ---- 4) 迁移 AGP 9 中移除/变动的 API ----
const OLD_PUB = [
  'internal fun LibraryExtension.applyPublishingVariant() {',
  '  publishing { publishing ->',
  '    publishing.singleVariant("release") {',
  '      withSourcesJar()',
  '    }',
  '  }',
  '}',
].join('\n');
const NEW_PUB = [
  'internal fun LibraryExtension.applyPublishingVariant() {',
  '  // AGP 9 迁移:publishing DSL 已变更;maven 发布路径不在 APK 构建中使用',
  '}',
].join('\n');

for (const f of expoPluginKt) {
  const s = fs.readFileSync(f, 'utf8');
  let s2 = s.replace(
    'import com.android.build.gradle.LibraryExtension',
    'import com.android.build.api.dsl.LibraryExtension',
  );
  s2 = s2.replace('lintOptions.isAbortOnError = false', 'lint { abortOnError = false }');
  s2 = s2.replace(
    'this@defaultConfig.targetSdk = targetSdk',
    '// AGP 9: library DSL 不再有 targetSdk',
  );
  s2 = s2.replace(OLD_PUB, NEW_PUB);
  // AGP 9 的 LibraryDefaultConfig 没有 versionName;该值只用于 maven 发布坐标,
  // APK 构建走 canBePublished=false 短路,置空即可。
  // 注意:替换串必须成对闭合引号,否则整个文件解析崩溃(曾因此在 CI 上炸出级联假错误)。
  s2 = s2.replace(
    'project.androidLibraryExtension().defaultConfig.versionName',
    '"" /* AGP 9: LibraryDefaultConfig 无 versionName,仅 maven 发布路径 */',
  );
  if (s2 !== s) save(f, s2);
}

// ---- 5) 自检:确保补丁真的生效,且没有把源码改成语法非法的样子 ----
const problems = [];

const pubFile = expoPluginKt.find((f) => path.basename(f) === 'MavenPublicationExtension.kt');
if (!pubFile) {
  problems.push('未找到 MavenPublicationExtension.kt,补丁可能未命中');
} else {
  const lines = fs.readFileSync(pubFile, 'utf8').split('\n');
  const verLine = lines.find((l) => l.includes('version = requireNotNull('));
  if (!verLine) {
    problems.push('MavenPublicationExtension.kt 未找到 version = requireNotNull(...) 行');
  } else {
    const quotes = (verLine.match(/"/g) || []).length;
    if (quotes % 2 !== 0) {
      problems.push(`version 行双引号数为奇数(${quotes}),字符串未闭合:${verLine.trim()}`);
    }
    if (verLine.includes('defaultConfig.versionName')) {
      problems.push('versionName 未被替换,AGP 9 下会编译失败');
    }
  }
}

const extFile = expoPluginKt.find((f) => path.basename(f) === 'AndroidLibraryExtension.kt');
if (extFile && fs.readFileSync(extFile, 'utf8').includes('publishing { publishing ->')) {
  problems.push('AndroidLibraryExtension.kt 的 publishing 块未置空');
}

const pluginBuild = expoPluginBuildKts[0];
if (pluginBuild && !fs.readFileSync(pluginBuild, 'utf8').includes(':gradle:9.2.1')) {
  problems.push('expo-module-gradle-plugin 的 AGP 编译依赖未升到 9.2.1');
}

if (problems.length > 0) {
  console.error('\n[自检失败]');
  for (const p of problems) console.error('  - ' + p);
  process.exit(1);
}

console.log(`done, ${changed} file(s) patched, self-check passed`);
