import { useEffect, useState } from 'react';
import {
  encryptTextEnabled,
  setEncryptTextEnabled,
} from '../../core/security/sensitive';
import { hasPassphrase, setPassphrase } from '../../core/adapters/crypto';
import { lastBackupAt } from '../../core/io/backup';
import { useUI } from '../../app/store';
import { Icon } from '../../ui/Icon';

export function SecuritySettings() {
  const toast = useUI((s) => s.toast);
  const [encText, setEncText] = useState(false);
  const [usePass, setUsePass] = useState(false);
  const [lastBackup, setLastBackup] = useState('');

  useEffect(() => {
    void encryptTextEnabled().then(setEncText);
    setUsePass(hasPassphrase());
    void lastBackupAt().then(setLastBackup);
  }, []);

  const days = lastBackup
    ? Math.floor((Date.now() - new Date(lastBackup).getTime()) / 86400000)
    : -1;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-xs">
        <span className="text-fg-muted">上次备份：</span>
        {lastBackup ? (
          <span className={days > 7 ? 'text-[#f0a13c]' : 'text-[#3fb984]'}>
            {days === 0 ? '今天' : `${days} 天前`}
            {days > 7 && ' · 建议现在备份一次'}
          </span>
        ) : (
          <span className="text-[#f0a13c]">从未备份</span>
        )}
      </div>

      <label className="text-xs text-fg-muted flex items-start gap-2">
        <input
          type="checkbox"
          checked={encText}
          onChange={async (e) => {
            const v = e.target.checked;
            setEncText(v);
            await setEncryptTextEnabled(v);
            toast(
              v
                ? '已开启：新的收集箱原文与附件正文会加密存储（这些正文将无法被搜索）'
                : '已关闭：新内容以明文存储，可被搜索',
              v ? 'warn' : 'ok',
            );
          }}
        />
        <span>
          加密收集箱原文与附件正文
          <span className="block text-[11px] text-fg-dim">
            代价：加密后的正文不进索引，搜不到。只影响开启之后新增的内容。
          </span>
        </span>
      </label>

      <label className="text-xs text-fg-muted flex items-start gap-2">
        <input
          type="checkbox"
          checked={usePass}
          onChange={(e) => {
            if (e.target.checked) {
              const p = window.prompt('设置一个加密口令（重启后需重新输入，务必记住）：');
              if (p) {
                setPassphrase(p);
                setUsePass(true);
                toast('已启用口令加密（本次会话有效）');
              }
            } else {
              setPassphrase(null);
              setUsePass(false);
              toast('已切回设备密钥');
            }
          }}
        />
        <span>
          用口令加密 API Key
          <span className="block text-[11px] text-fg-dim">
            默认用本机随机设备密钥（防备份文件泄露，防不住本机程序）；
            口令模式更安全，但重启后要重新输入。
          </span>
        </span>
      </label>

      <div className="text-[11px] text-fg-dim leading-5 flex gap-1.5">
        <Icon name="Settings" size={12} />
        <span>
          说明：浏览器环境下无法做到真正的整库静态加密（数据在 IndexedDB 里，
          全量加密就没法查询）。有效的整库加密要等桌面壳（Tauri）版本。
        </span>
      </div>
    </div>
  );
}
