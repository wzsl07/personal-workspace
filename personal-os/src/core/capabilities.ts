/**
 * 能力门面：统一回答「这个功能现在能用吗？不能用是为什么？去哪修？」
 *
 * 为什么要有这一层：
 *   自用版里，按钮灰掉就灰掉了，反正作者知道自己没配 Key。
 *   分发版里不行 —— 朋友看到灰按钮只会觉得「这软件坏了」。
 *   所以规定：**任何不可用能力都必须带一句人话原因 + 一个修复入口**，
 *   不允许再出现"灰掉但没解释"的按钮。
 *
 * 这一层只读不写，纯查询，可以随便调用。
 */

import { cloudBlockReason, cloudReady, loadConfig } from './adapters/ai';
import { checkModelDetailed, modelReady } from './adapters/embed';
import { loadOcrConfig, ocrRoute } from './adapters/extract';
import { langReady } from './adapters/ocr';
import { loadSyncConfig, loadSyncSecret } from './adapters/sync';
import { db, getMeta } from './repo/db';
import { dataDir, isTauri, shellVersion } from './adapters/desktop';
import { APP_VERSION, BUILD_ID } from './version';

export type CapabilityId = 'ai' | 'semantic' | 'ask' | 'feed' | 'ocr' | 'sync' | 'backup';

export interface CapState {
  id: CapabilityId;
  label: string;
  /** 现在能不能用 */
  ok: boolean;
  /** 能用的话，一句话说明当前状态；不能用的话，一句人话说明缺什么 */
  detail: string;
  /** 不能用时，跳到设置页哪个卡片去修 */
  fixTo?: string;
  /** 「去修复」按钮上的字 */
  fixLabel?: string;
  /** 这一项是不是可选的（false = 核心功能，坏了必须修） */
  optional: boolean;
}

export const CAP_LABELS: Record<CapabilityId, string> = {
  ai: 'AI 解析',
  semantic: '语义搜索',
  ask: '智能问答',
  feed: '信息流搜索',
  ocr: '图片 OCR',
  sync: '多设备同步',
  backup: '数据备份',
};

/** 逐项检查。并发安全，慢的检查（模型探测）走短超时。 */
export async function checkCapabilities(): Promise<CapState[]> {
  const [aiCfg, ocrCfg, syncCfg, syncSecret, lastBackup] = await Promise.all([
    loadConfig().catch(() => null),
    loadOcrConfig().catch(() => null),
    loadSyncConfig().catch(() => null),
    loadSyncSecret().catch(() => ''),
    getMeta<string>('backup:lastAt', ''),
  ]);

  const out: CapState[] = [];

  /* ---- AI 解析 ---- */
  {
    const cfg = aiCfg;
    if (!cfg) {
      out.push({
        id: 'ai',
        label: CAP_LABELS.ai,
        ok: false,
        detail: 'AI 配置读取失败，将使用本地规则解析（不影响基本使用）。',
        fixTo: '#ai',
        fixLabel: '去设置',
        optional: true,
      });
    } else if (!cfg.allowCloud) {
      out.push({
        id: 'ai',
        label: CAP_LABELS.ai,
        ok: false,
        detail: '你手动关掉了云端 AI，现在用本地规则解析（够用，但不理解复杂句子）。',
        fixTo: '#ai',
        fixLabel: '去开启',
        optional: true,
      });
    } else if (cloudReady(cfg)) {
      out.push({
        id: 'ai',
        label: CAP_LABELS.ai,
        ok: true,
        detail: '已配置，收集箱里的文本可以一键解析成日程草稿。',
        optional: true,
      });
    } else {
      out.push({
        id: 'ai',
        label: CAP_LABELS.ai,
        ok: false,
        detail: cloudBlockReason(cfg),
        fixTo: '#ai',
        fixLabel: '去填 Key',
        optional: true,
      });
    }
  }

  /* ---- 语义搜索 ---- */
  {
    if (modelReady()) {
      out.push({
        id: 'semantic',
        label: CAP_LABELS.semantic,
        ok: true,
        detail: '本地向量模型已加载，可以按意思搜（不联网）。',
        optional: true,
      });
    } else {
      const r = await checkModelDetailed().catch(() => ({
        ok: false,
        reason: '模型状态探测失败',
      }));
      out.push({
        id: 'semantic',
        label: CAP_LABELS.semantic,
        ok: r.ok,
        detail: r.ok ? '本地向量模型已就绪。' : r.reason,
        fixTo: r.ok ? undefined : '#about',
        fixLabel: r.ok ? undefined : '看怎么修',
        optional: true,
      });
    }
  }

  /* ---- 智能问答 / 查询改写（必须靠云端大模型） ---- */
  {
    const cfg = aiCfg;
    if (cfg && cloudReady(cfg)) {
      out.push({
        id: 'ask',
        label: CAP_LABELS.ask,
        ok: true,
        detail: '可用。会改写你的问题再检索，并用大模型回答。',
        optional: true,
      });
    } else {
      out.push({
        id: 'ask',
        label: CAP_LABELS.ask,
        ok: false,
        detail: cfg
          ? cloudBlockReason(cfg)
          : '需要配置云端大模型才能用（本地模型做不了问答）。',
        fixTo: '#ai',
        fixLabel: '去填 Key',
        optional: true,
      });
    }
  }

  /* ---- 信息流搜索（数据来自本机的聚合服务，只有桌面版访问得到）---- */
  {
    if (!isTauri()) {
      out.push({
        id: 'feed',
        label: CAP_LABELS.feed,
        ok: false,
        detail: '只有桌面版能访问本机的聚合服务（127.0.0.1），网页版/手机版用不了这一项。',
        optional: true,
      });
    } else {
      let n = 0;
      let at = '';
      try {
        n = await db.feedItems.count();
        at = await getMeta<string>('feed:cachedAt', '');
      } catch {
        n = 0;
      }
      if (n === 0) {
        out.push({
          id: 'feed',
          label: CAP_LABELS.feed,
          ok: false,
          detail: '还没有信息流快照。打开「搜索」页会自动拉一次（需要聚合服务在跑）。',
          fixTo: '#about',
          fixLabel: '看怎么开服务',
          optional: true,
        });
      } else {
        const days = at ? Math.floor((Date.now() - new Date(at).getTime()) / 86400000) : -1;
        out.push({
          id: 'feed',
          label: CAP_LABELS.feed,
          ok: true,
          detail: `已镜像 ${n} 条（${days < 0 ? '未知时间' : days === 0 ? '今天更新' : `${days} 天前更新`}）。搜索页勾选「信息流」即可参与检索。`,
          optional: true,
        });
      }
    }
  }

  /* ---- OCR ---- */
  {
    const cfg = ocrCfg;
    if (!cfg || !cfg.enabled) {
      out.push({
        id: 'ocr',
        label: CAP_LABELS.ocr,
        ok: false,
        detail: '默认关闭。图片类附件暂时只能搜文件名；PDF 和 Word 不受影响。',
        fixTo: '#ocr',
        fixLabel: '去开启',
        optional: true,
      });
    } else {
      const mode = cfg.mode ?? 'auto';
      const route = await ocrRoute().catch(() => null);
      const ready = route?.route === 'cloud' || (await langReady(cfg).catch(() => false));
      let detail: string;
      if (route?.route === 'cloud') {
        detail = `已开启：走云端视觉模型（${route.detail}），失败会自动退回本机。`;
      } else if (route?.route === 'local') {
        detail = `已开启：走本机识别${mode === 'local' ? '（你指定了只用本机）' : `（${route.detail}）`}。`;
      } else if (mode === 'cloud') {
        detail = `已开启，但云端不可用：${route?.detail ?? '未知原因'}。检查「AI 解析」里的地址与 Key。`;
      } else {
        detail = `已开启（${mode}），但没找到语言包（${cfg.lang}），两条路都走不通。检查语言包路径或云端配置。`;
      }
      out.push({
        id: 'ocr',
        label: CAP_LABELS.ocr,
        ok: ready,
        detail,
        fixTo: ready ? undefined : '#ocr',
        fixLabel: ready ? undefined : '去设置',
        optional: true,
      });
    }
  }

  /* ---- 同步 ---- */
  {
    const cfg = syncCfg;
    if (!cfg || cfg.adapter === 'none') {
      out.push({
        id: 'sync',
        label: CAP_LABELS.sync,
        ok: false,
        detail:
          '没开启。数据只在这台电脑上——硬盘坏了就没了，建议至少开「本地自动备份」。',
        fixTo: '#sync',
        fixLabel: '去开启',
        optional: true,
      });
    } else if (cfg.adapter === 'localFolder') {
      out.push({
        id: 'sync',
        label: CAP_LABELS.sync,
        ok: true,
        detail: '已选择本地文件夹作为备份目标。',
        optional: true,
      });
    } else {
      const hasSecret = Boolean(syncSecret);
      const hasTarget = cfg.adapter === 'github' ? Boolean(cfg.repo) : Boolean(cfg.url);
      if (hasSecret && hasTarget) {
        out.push({
          id: 'sync',
          label: CAP_LABELS.sync,
          ok: true,
          detail: cfg.autoMinutes > 0 ? `已开启，每 ${cfg.autoMinutes} 分钟自动同步。` : '已开启（手动同步）。',
          optional: true,
        });
      } else {
        out.push({
          id: 'sync',
          label: CAP_LABELS.sync,
          ok: false,
          detail: !hasTarget
            ? '选了同步方式，但还没填仓库/地址。'
            : '还差访问凭据（Token / 密码），填完记得点「测试连接」。',
          fixTo: '#sync',
          fixLabel: '去补全',
          optional: true,
        });
      }
    }
  }

  /* ---- 备份（这是唯一一个"坏了必须修"的） ---- */
  {
    const days = lastBackup ? Math.floor((Date.now() - new Date(lastBackup).getTime()) / 86400000) : -1;
    if (days < 0) {
      out.push({
        id: 'backup',
        label: CAP_LABELS.backup,
        ok: false,
        detail: '还从来没备份过。现在花 3 秒导一份，以后能省很多事。',
        fixTo: '#data',
        fixLabel: '去备份',
        optional: false,
      });
    } else if (days > 14) {
      out.push({
        id: 'backup',
        label: CAP_LABELS.backup,
        ok: false,
        detail: `上次备份是 ${days} 天前，有点久了。`,
        fixTo: '#data',
        fixLabel: '去备份',
        optional: false,
      });
    } else {
      out.push({
        id: 'backup',
        label: CAP_LABELS.backup,
        ok: true,
        detail: days === 0 ? '今天已备份。' : `上次备份 ${days} 天前。`,
        optional: false,
      });
    }
  }

  return out;
}

/** 有多少项不可用（用于设置页角标、首启向导提示） */
export function countProblems(caps: CapState[]): number {
  return caps.filter((c) => !c.ok).length;
}

/* ------------------------------------------------------------------ */
/* 诊断包                                                              */
/* ------------------------------------------------------------------ */

/**
 * 生成诊断信息（纯文本）。
 *
 * 刻意**不包含**任何数据内容：不导出日程、笔记、正文、Key、Token、仓库名。
 * 只包含"环境长什么样 + 哪些能力可用"，用户发过来我们就能定位问题，
 * 同时又不必让用户担心隐私。
 */
export async function buildDiagnostics(): Promise<string> {
  const caps = await checkCapabilities();
  const shell = await shellVersion().catch(() => null);
  const dir = await dataDir().catch(() => null);

  const lines: string[] = [];
  lines.push('=== 个人工作台 · 诊断信息 ===');
  lines.push(`生成时间：${new Date().toISOString()}`);
  lines.push(`版本：${APP_VERSION}（build ${BUILD_ID}）`);
  lines.push(`桌面壳版本：${shell ?? '（浏览器环境）'}`);
  lines.push(`运行环境：${isTauri() ? '桌面应用' : '浏览器 / PWA'}`);
  lines.push(`User Agent：${navigator.userAgent}`);
  lines.push(`屏幕：${window.screen.width}x${window.screen.height}  窗口：${window.innerWidth}x${window.innerHeight}`);
  lines.push(`语言：${navigator.language}  时区：${Intl.DateTimeFormat().resolvedOptions().timeZone}`);
  lines.push(`数据目录：${dir ?? '（浏览器环境，数据在浏览器 profile 内）'}`);
  lines.push('');
  lines.push('=== 能力状态 ===');
  for (const c of caps) {
    lines.push(`[${c.ok ? '可用' : '不可用'}] ${c.label}：${c.detail}`);
  }
  lines.push('');
  lines.push('=== 说明 ===');
  lines.push('本文件只含环境与能力状态，不含任何日程、笔记、附件正文、API Key 或 Token。');
  lines.push('如需连同数据一起排查，请另外导出 JSON 备份并自行确认其中内容后再发送。');
  return lines.join('\n');
}
