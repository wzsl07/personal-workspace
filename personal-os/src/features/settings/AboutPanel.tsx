/**
 * 关于：版本号、运行环境、许可与隐私、诊断包。
 *
 * 版本号为什么重要：用户报 bug 时第一句必须是"你用的是哪个版本"。
 * 如果软件里看不到版本，就只能靠猜，改了半天发现对方跑的是三个月前的包。
 */

import { useEffect, useState } from 'react';
import { Icon } from '../../ui/Icon';
import { useUI } from '../../app/store';
import { APP_VERSION, BUILD_ID } from '../../core/version';
import { buildDiagnostics } from '../../core/capabilities';
import { downloadMessage } from '../../core/io/backup';
import { desktopInfo, shellVersion } from '../../core/adapters/desktop';
import { download } from '../../core/io/backup';

export function AboutPanel() {
  const toast = useUI((s) => s.toast);
  const [env, setEnv] = useState('');
  const [shell, setShell] = useState('');

  useEffect(() => {
    void (async () => {
      setEnv(await desktopInfo());
      setShell((await shellVersion()) ?? '');
    })();
  }, []);

  return (
    <div className="space-y-4 text-xs">
      <div className="flex items-center gap-3">
        <span className="w-8 h-8 rounded-lg bg-bg-elev flex items-center justify-center">
          <Icon name="Boxes" size={16} />
        </span>
        <div>
          <div className="text-sm font-medium">个人工作台</div>
          <div className="text-fg-dim">
            版本 {APP_VERSION}
            {shell && shell !== APP_VERSION ? ` · 桌面壳 ${shell}` : ''}
          </div>
          <div className="text-fg-dim">构建号 {BUILD_ID}</div>
        </div>
      </div>

      <div className="text-fg-dim">{env}</div>

      <div className="p-3 rounded-md bg-bg-elev leading-6 text-fg-muted">
        <b>隐私：</b>这个软件没有服务器。你的日程、笔记、附件全部存在本机，
        AI 和同步（如果你开了）直连你自己填的服务和仓库。作者看不到你的任何数据，
        也没有任何统计上报。
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          className="btn text-xs"
          onClick={() => {
            void (async () => {
              const text = await buildDiagnostics();
              const name = `个人工作台-诊断-${APP_VERSION}-${BUILD_ID}.txt`;
              const r = await download(name, text, 'text/plain;charset=utf-8');
              toast(
                downloadMessage(r, '诊断包已导出（不含任何日程内容与密钥）'),
                r.status === 'cancelled' ? 'warn' : 'ok',
              );
            })();
          }}
        >
          <Icon name="Stethoscope" size={13} /> 导出诊断包
        </button>
        <button
          className="btn text-xs"
          onClick={() => {
            void navigator.clipboard
              .writeText(`个人工作台 ${APP_VERSION} (build ${BUILD_ID})\n${env}`)
              .then(() => toast('版本信息已复制'))
              .catch(() => toast('复制失败，请手动抄写上面的版本号', 'warn'));
          }}
        >
          <Icon name="Copy" size={13} /> 复制版本信息
        </button>
      </div>

      <div className="text-[11px] text-fg-dim leading-5 pt-2 border-t border-line">
        许可：MIT。本软件使用了 React、Dexie、MiniSearch、pdf.js、tesseract.js、
        transformers.js、Tauri 等开源项目（许可声明见分发包内的 THIRD-PARTY-NOTICES）。
        <br />
        软件按「原样」提供，作者对数据丢失不承担责任 ——
        <b>请定期用「数据 → 一键备份」导出 JSON。</b>
      </div>
    </div>
  );
}
