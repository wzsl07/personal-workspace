import { useEffect, useState } from 'react';
import {
  defaultLead,
  notifyEnabled,
  pendingCount,
  requestNotifyPermission,
  scanAndFire,
  setDefaultLead,
  setNotifyEnabled,
  notifyPermission,
} from '../../core/notify/scheduler';
import { isTauri, notify, desktopInfo } from '../../core/adapters/desktop';
import { useUI } from '../../app/store';
import { Icon } from '../../ui/Icon';

/** 权限被拒后的恢复步骤（浏览器不提供自动重置，只能手动） */
function HowToReallow() {
  return (
    <div className="card p-3 border-[#f0a13c]/50">
      <div className="text-xs text-[#f0a13c] mb-2">通知被浏览器拒绝过，需要手动恢复</div>
      <ol className="text-[11px] text-fg-muted leading-6 list-decimal pl-4 space-y-1">
        <li>
          点浏览器地址栏<b className="text-fg">最左边那个图标</b>
          （锁形 / 圆圈 i / 齿轮，取决于浏览器）
        </li>
        <li>
          找到「网站设置」→「通知」，把这项从「阻止」改成<b className="text-fg">「允许」</b>
        </li>
        <li>
          改完后<b className="text-fg">刷新本页面</b>（F5），再回来点「申请通知权限」
        </li>
      </ol>
      <div className="text-[11px] text-fg-dim mt-2">
        另一种方式：浏览器设置 → 隐私和安全 → 网站设置 → 通知 →
        找到 <code>127.0.0.1:5173</code> → 改为允许。
        <br />
        如果整站开关是「不允许任何网站发送通知」，要先把它打开。
        <br />
        Chrome 也可直接访问 <code>chrome://settings/content/notifications</code>
        （这个地址需要你自己复制进地址栏，页面不能替你跳转）。
      </div>
    </div>
  );
}

const PERM_TEXT: Record<string, string> = {
  granted: '已授权',
  denied: '被浏览器拒绝（需在地址栏左侧重新允许）',
  default: '还没授权',
  unsupported: '当前浏览器不支持通知',
};

export function NotifySettings() {
  const toast = useUI((s) => s.toast);
  const [enabled, setEnabled] = useState(true);
  const [lead, setLead] = useState(30);
  const [perm, setPerm] = useState<string>('default');
  const [pending, setPending] = useState(0);
  const [env, setEnv] = useState('');

  useEffect(() => {
    void notifyEnabled().then(setEnabled);
    void defaultLead().then(setLead);
    void pendingCount().then(setPending);
    setPerm(notifyPermission());
    void desktopInfo().then(setEnv);
  }, []);

  async function grant() {
    const p = await requestNotifyPermission();
    setPerm(p);
    toast(p === 'granted' ? '通知已授权' : `未能授权：${PERM_TEXT[p] ?? p}`, p === 'granted' ? 'ok' : 'warn');
  }

  return (
    <div className="space-y-3">
      <div className="text-[11px] text-fg-dim">{env}</div>

      <label className="text-xs text-fg-muted flex items-center gap-2">
        <input
          type="checkbox"
          checked={enabled}
          onChange={async (e) => {
            setEnabled(e.target.checked);
            await setNotifyEnabled(e.target.checked);
          }}
        />
        启用到期提醒
      </label>

      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs text-fg-muted">默认提前</span>
        <select
          className="field w-auto py-1 text-xs"
          value={String(lead)}
          onChange={async (e) => {
            const v = Number(e.target.value);
            setLead(v);
            await setDefaultLead(v);
          }}
        >
          <option value="0">准点</option>
          <option value="10">10 分钟</option>
          <option value="30">30 分钟</option>
          <option value="60">1 小时</option>
          <option value="1440">1 天</option>
        </select>
        <span className="text-[11px] text-fg-dim">待触发 {pending} 条</span>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <button className="btn" onClick={() => void grant()} disabled={perm === 'granted'}>
          {perm === 'granted' ? '通知已授权' : '申请通知权限'}
        </button>
        <button
          className="btn"
          onClick={async () => {
            const n = await scanAndFire();
            toast(n > 0 ? `已发出 ${n} 条提醒` : '当前没有到期提醒');
          }}
        >
          立即检查到期
        </button>
        <button
          className="btn"
          onClick={async () => {
            const ok = await notify('测试提醒', '如果你看到这条，说明通知通道正常');
            toast(ok ? '测试通知已发出' : '没发出去，先点「申请通知权限」', ok ? 'ok' : 'warn');
          }}
        >
          发一条测试
        </button>
      </div>

      {perm === 'denied' && <HowToReallow />}

      <div className="text-[11px] text-fg-dim leading-5">
        权限状态：{PERM_TEXT[perm] ?? perm}
        <br />
        <b>限制：</b>
        {isTauri()
          ? '当前是桌面壳，提醒由系统常驻进程发出，关掉窗口也能弹。'
          : '浏览器没有后台常驻能力，提醒只在应用打开时轮询触发（每 30 秒一次）。想要准点提醒，需要编译桌面壳（见下方"桌面壳"一节）。'}
      </div>

      <div className="flex items-center gap-1.5 text-[11px] text-fg-dim">
        <Icon name="CalendarClock" size={12} />
        在条目编辑里可以单独设置每条的提醒时间
      </div>
    </div>
  );
}
