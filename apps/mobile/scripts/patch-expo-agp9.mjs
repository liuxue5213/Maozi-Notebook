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
 * 补丁清单:
 *   1. 内置 gradle 插件 Kotlin 统一 2.3.0 + kotlinOptions → compilerOptions
 *   2. 移除旧式 kotlin-android 应用(AGP 9 内置 Kotlin,重复注册会报错)
 *   3. expo-module-gradle-plugin 编译依赖 AGP 8.5.0 → 9.2.1
 *   4. 迁移 AGP 9 移除/变动的 API(LibraryExtension 包路径、lintOptions、
 *      targetSdk、publishing singleVariant、versionName)
 *   5. canBePublished 默认 true → false(第 4 步移除了 'release' 组件注册,
 *      而 9 个未显式关闭发布的模块会去读它 → SoftwareComponent not found)
 *   6. 为"声明了 buildConfigField 却未开启 buildConfig"的模块补开关
 *      (AGP 9 下 library 的 buildConfig 默认关闭;@expo/log-box 漏开)
 *   7. 在生成工程的 gradle.properties 里设 android.sourceset.disallowProvider=false
 *      (expo-autolinking 仍向 sourceSets 传 Provider,AGP 9 默认禁止)
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

// ---- 5) 默认关闭 maven 发布 ----
// applyPublishing() 在 canBePublished=true 时会构造 PublicationInfo,而后者依赖
// applyPublishingVariant() 注册的 'release' 软件组件 —— 该注册已在第 4 步被移除。
// 实测有 9 个 expo 模块没显式写 `canBePublished false`,会走到这条路径并抛
// "SoftwareComponent with name 'release' not found"。
// APK 构建不需要 maven 发布,故把默认值改为 false,统一走空任务分支
// (createEmptyExpoPublishTask,即 :expo / :expo-log-box 已经在用的正常路径)。
for (const f of expoPluginKt) {
  if (path.basename(f) !== 'ExpoModuleExtension.kt') continue;
  const s = fs.readFileSync(f, 'utf8');
  const s2 = s.replace(
    'var canBePublished: Boolean = true',
    'var canBePublished: Boolean = false // AGP9 patch: APK 构建不需要 maven 发布',
  );
  if (s2 !== s) save(f, s2);
}

// ---- 6) 为"声明了 buildConfigField 却未开启 buildConfig"的模块补上开关 ----
// AGP 9 下 library 模块的 buildConfig 默认关闭;@expo/log-box 在 defaultConfig 里
// 声明了 buildConfigField 却没开该特性,configure 阶段直接报
// "defaultConfig contains custom BuildConfig fields, but the feature is disabled"。
// 按 AGP 报错提示的做法,逐个模块补 `buildFeatures { buildConfig true }`。
const RE_BUILD_CONFIG_ON = /buildFeatures\s*\{[\s\S]{0,300}?buildConfig\s*(?:=\s*)?true/;

function enableBuildConfig(file) {
  const s = fs.readFileSync(file, 'utf8');
  if (!/buildConfigField/.test(s)) return;
  if (RE_BUILD_CONFIG_ON.test(s)) return;
  // 插到 android 块的 namespace 行之后(AGP 强制要求 namespace,必定存在);
  // 兜底插到 `android {` 之后。
  const m = s.match(/^([ \t]*)namespace\b[^\n]*$/m) || s.match(/^([ \t]*)android\s*\{[ \t]*$/m);
  if (!m) return;
  const indent = m[1];
  const block = `\n${indent}buildFeatures {\n${indent}  buildConfig true\n${indent}}`;
  const at = m.index + m[0].length;
  save(file, s.slice(0, at) + block + s.slice(at));
}

for (const f of androidBuildGradle) enableBuildConfig(f);
const appModuleGradle = path.join(root, 'apps/mobile/android/app/build.gradle');
if (fs.existsSync(appModuleGradle)) enableBuildConfig(appModuleGradle);

// ---- 7) 放行"Provider 形式的 sourceSets"(AGP 9 默认禁止) ----
// expo-autolinking 仍这么写:
//   ext.sourceSets.getByName("main").java
//      .srcDirs(getPackageListDir(project), getInlineModulesDir(project))
// 两个参数都是 Provider<Directory>(expo-autolinking-plugin/ExpoAutolinkingPlugin.kt:95),
// AGP 9 直接抛 "You cannot add Provider instances to the Android SourceSet API"。
// AGP 在报错正文里给出的官方开关就是下面这一项。
// 之所以敢关:同一个插件在上游已经显式声明了任务依赖
//   project.tasks.named("preBuild", Task::class.java).dependsOn(generatePackagesList)
// 因此不依赖 Provider 携带的隐式依赖,不会丢失"先生成再编译"的顺序保证。
const gradleProps = path.join(root, 'apps/mobile/android/gradle.properties');
if (fs.existsSync(gradleProps)) {
  const s = fs.readFileSync(gradleProps, 'utf8');
  if (!/^[ \t]*android\.sourceset\.disallowProvider\s*=/m.test(s)) {
    const note = [
      '',
      '# AGP 9:expo-autolinking 仍把 Provider 传给 Android SourceSet API',
      '# (expo-autolinking-plugin ExpoAutolinkingPlugin.kt:95),AGP 9 默认禁止并直接报错。',
      '# 此处启用 AGP 给出的官方开关放行;expo 已用',
      '# preBuild.dependsOn(generatePackagesList) 显式声明任务依赖,',
      '# 故不会丢失生成顺序保证。',
      'android.sourceset.disallowProvider=false',
      '',
    ].join('\n');
    save(gradleProps, s + (s.endsWith('\n') ? '' : '\n') + note);
  }
}

// ---- 7) 自检:确保补丁真的生效,且没有把源码改成语法非法的样子 ----
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

// 发布默认值必须为 false,否则会重新触发 "SoftwareComponent 'release' not found"
const extKt = expoPluginKt.find((f) => path.basename(f) === 'ExpoModuleExtension.kt');
if (!extKt) {
  problems.push('未找到 ExpoModuleExtension.kt,发布开关补丁可能未命中');
} else if (!fs.readFileSync(extKt, 'utf8').includes('var canBePublished: Boolean = false')) {
  problems.push("canBePublished 默认值未改为 false,会触发 SoftwareComponent 'release' not found");
}

// 任何声明 buildConfigField 的模块都必须已开启 buildConfig
const moduleGradles = [...androidBuildGradle];
if (fs.existsSync(appModuleGradle)) moduleGradles.push(appModuleGradle);
for (const f of moduleGradles) {
  const s = fs.readFileSync(f, 'utf8');
  if (/buildConfigField/.test(s) && !RE_BUILD_CONFIG_ON.test(s)) {
    problems.push(`模块声明了 buildConfigField 但未开启 buildConfig:${path.relative(root, f)}`);
  }
}

// 必须放行 Provider 形式的 sourceSets,否则 expo-autolinking 直接报错
if (!fs.existsSync(gradleProps)) {
  problems.push('未找到 apps/mobile/android/gradle.properties');
} else if (
  !/^[ \t]*android\.sourceset\.disallowProvider\s*=\s*false\s*$/m.test(
    fs.readFileSync(gradleProps, 'utf8'),
  )
) {
  problems.push('gradle.properties 未设置 android.sourceset.disallowProvider=false');
}

if (problems.length > 0) {
  console.error('\n[自检失败]');
  for (const p of problems) console.error('  - ' + p);
  process.exit(1);
}

console.log(`done, ${changed} file(s) patched, self-check passed`);
