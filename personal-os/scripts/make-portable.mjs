/**
 * 生成便携版（绿色版）ZIP。
 *
 * 为什么需要它：
 *   安装包会被 Windows 智能应用控制（SAC）或 SmartScreen 拦下来，
 *   有些人的机器就是过不去。便携版是兜底方案 —— 解压双击即用，不写注册表。
 *
 * 便携版的内容：
 *   Tauri 会把前端资源（含语义模型、OCR、WASM 运行时）全部**嵌入 exe**，
 *   所以便携版就是「一个自包含的 exe + 一份说明」。不需要拷贝任何周边文件。
 *
 * ⚠️ 来源必须是**刚构建出来的** exe（src-tauri/target/release/personal-os.exe），
 *    不能拿上次的安装目录 —— 那个可能是几个月前的旧版本。
 *
 * 用法：node scripts/make-portable.mjs
 */

import { existsSync, mkdirSync, readFileSync, copyFileSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const version = pkg.version;

/** 候选来源，按优先级：刚构建的 > 环境变量指定 > 已安装目录 */
const builtExe = join(root, 'src-tauri', 'target', 'release', 'personal-os.exe');
const localAppData = process.env.LOCALAPPDATA ?? process.env.APPDATA ?? '';

let src = null;
let srcNote = '';
if (existsSync(builtExe)) {
  src = builtExe;
  srcNote = '刚构建的产物（推荐）';
} else if (process.env.DIST_INSTALLED_DIR && existsSync(join(process.env.DIST_INSTALLED_DIR, '个人工作台.exe'))) {
  src = join(process.env.DIST_INSTALLED_DIR, '个人工作台.exe');
  srcNote = '环境变量 DIST_INSTALLED_DIR 指定的安装目录';
} else {
  for (const c of [join(localAppData, '个人工作台'), join(localAppData, 'Programs', '个人工作台')]) {
    if (c && existsSync(join(c, '个人工作台.exe'))) {
      src = join(c, '个人工作台.exe');
      srcNote = '已安装目录（注意：可能不是最新构建）';
      break;
    }
  }
}

if (!src) {
  console.error('[便携版] 找不到 exe。请先跑 `npm run tauri:build`，');
  console.error('        或用环境变量 DIST_INSTALLED_DIR 指定一个装好的目录。');
  process.exit(1);
}

src = resolve(src);
const mtime = statSync(src).mtime;
const ageDays = Math.floor((Date.now() - mtime.getTime()) / 86_400_000);
console.log(`[便携版] 来源：${src}`);
console.log(`[便携版]     （${srcNote}，最后修改 ${mtime.toISOString().slice(0, 10)}，${ageDays} 天前）`);
if (ageDays > 1 && src === builtExe) {
  console.warn('[便携版] ⚠ 这个 exe 不是今天构建的，确认一下是不是忘了重新 build。');
}

const outName = `个人工作台-${version}-win-x64-便携版`;
const staging = join(root, 'dist-portable', outName);

/**
 * 清空上一次的产物。
 *
 * 注意：某些环境（如 WorkBuddy 的 safe-delete 垫片）会把删除重定向到回收站，
 * 回收站操作失败时直接抛错，导致脚本中断。但产物目录存不存在都不影响结果 ——
 * 下面的 cpSync 会覆盖同名文件。所以这里失败就跳过，不当作致命错误。
 */
try {
  rmSync(staging, { recursive: true, force: true });
} catch {
  console.log('[便携版] 旧目录删不掉（可能是安全删除策略），改为直接覆盖');
}
mkdirSync(staging, { recursive: true });
copyFileSync(src, join(staging, '个人工作台.exe'));

writeFileSync(
  join(staging, '怎么用.txt'),
  `个人工作台 ${version} · 便携版
================================

【怎么用】
双击「个人工作台.exe」。不用安装，不用管理员权限，不写注册表。

【我的数据在哪】
数据保存在（复制粘贴到资源管理器地址栏即可打开）：
  %LOCALAPPDATA%\\com.github.wzsl07.personal-os\\

或者在软件里：设置 → 数据 → 打开这个文件夹。

注意：便携版的 exe 可以随便挪，但**数据不跟着这个文件夹走**，
它固定存在上面那个系统目录里。
要带走数据，请用「设置 → 数据 → 一键备份（JSON）」。

【和安装包版的区别】
- 不用安装、不写注册表、不留卸载项
- 删掉整个文件夹就"卸载"了（数据还在上面的目录里）
- 没有开始菜单快捷方式 —— 想放桌面就右键 exe 发送到桌面快捷方式

【卸载】
删掉整个文件夹。想连数据一起删，再手动删上面那个数据目录。

【被 Windows 拦下来】
这个软件没有代码签名证书，Windows 可能报警告，不是病毒：
- 蓝框「Windows 已保护你的电脑」→ 点「更多信息」→「仍要运行」
- 「智能应用控制阻止」→ 见同目录的《安装指南》
- 杀软报毒 → 是误报，加白名单

【出问题】
设置 → 一键体检（会告诉你哪项没配好）
设置 → 关于 → 导出诊断包（生成的 txt 不含任何日程内容和密钥）
`,
  'utf8',
);

const zipPath = join(root, 'dist-portable', `${outName}.zip`);
try {
  rmSync(zipPath, { force: true });
} catch {
  /* 同上：删不掉就让 Compress-Archive 用 -Force 覆盖 */
}

// Windows 自带 PowerShell 的 Compress-Archive，不依赖任何第三方压缩工具
try {
  execFileSync(
    'powershell',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Compress-Archive -Path '${join(staging, '*')}' -DestinationPath '${zipPath}' -CompressionLevel Optimal -Force`,
    ],
    { stdio: 'pipe' },
  );
} catch (e) {
  console.error('[便携版] 压缩失败：', e instanceof Error ? e.message : e);
  console.error('        文件夹已经生成在：', staging);
  console.error('        你可以手动右键压缩成 zip。');
  process.exit(1);
}

const mb = (statSync(zipPath).size / 1024 / 1024).toFixed(1);
console.log(`[便携版] ✅ ${zipPath}（${mb} MB）`);
console.log(`[便携版] 未压缩的文件夹保留在：${staging}`);
