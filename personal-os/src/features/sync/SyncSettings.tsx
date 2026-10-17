import { useEffect, useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  SUPABASE_SQL,
  SYNC_LIST,
  adapterOf,
  clearHandle,
  loadSyncConfig,
  loadSyncSecret,
  pickFolder,
  saveSyncConfig,
  saveSyncSecret,
  type SyncAdapterId,
  type SyncConfig,
} from '../../core/adapters/sync';
import {
  lastSyncInfo,
  resolveConflict,
  runSync,
  unresolvedConflicts,
} from '../../core/sync/engine';
import { db } from '../../core/repo/db';
import { fmtDateTime } from '../../core/domain/time';
import type { Conflict } from '../../core/domain/types';
import { useUI } from '../../app/store';
import { Icon } from '../../ui/Icon';

const FIELD_LABEL: Record<string, string> = {
  url: '地址 / Project URL',
  username: '用户名',
  password: '密码 / Token / Key（加密保存）',
  repo: '仓库（owner/repo）',
  branch: '分支',
  table: '表名',
  path: '文件名或路径',
};

export function SyncSettings() {
  const bump = useUI((s) => s.bump);
  const toast = useUI((s) => s.toast);
  const [cfg, setCfg] = useState<SyncConfig | null>(null);
  const [secret, setSecret] = useState('');
  const [secretSaved, setSecretSaved] = useState(false);
  const [testing, setTesting] = useState('');
  const [running, setRunning] = useState(false);
  const [info, setInfo] = useState<{ status: string; at?: string }>({ status: 'never' });
  const [folderName, setFolderName] = useState('');

  const logs = useLiveQuery(async () => {
    const rows = await db.syncLogs.toArray();
    return rows.sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 8);
  }, [useUI.getState().revision]);

  const conflicts = useLiveQuery(() => unresolvedConflicts(), [useUI.getState().revision]);
  const revision = useUI((s) => s.revision);
  void revision;

  useEffect(() => {
    void loadSyncConfig().then(setCfg);
    void loadSyncSecret().then((s) => {
      setSecretSaved(Boolean(s));
    });
    void lastSyncInfo().then(setInfo);
  }, []);

  const adapter = useMemo(() => (cfg ? adapterOf(cfg.adapter) : null), [cfg]);

  if (!cfg || !adapter) return <div className="text-xs text-fg-dim">加载中…</div>;

  const patch = (p: Partial<SyncConfig>) => setCfg({ ...cfg, ...p });

  async function persist(): Promise<void> {
    const c = cfg;
    if (!c) return;
    await saveSyncConfig(c);
    if (secret) await saveSyncSecret(secret);
    setSecretSaved(Boolean(secret) || secretSaved);
    toast('同步配置已保存（凭据加密存本机）');
  }

  async function test(): Promise<void> {
    const c = cfg;
    if (!c) return;
    setTesting('测试中…');
    const r = await adapterOf(c.adapter).test(c, secret || (await loadSyncSecret()));
    setTesting(r.message);
  }

  async function syncNow(): Promise<void> {
    setRunning(true);
    try {
      const r = await runSync();
      toast(r.message, r.status === 'success' ? 'ok' : r.status === 'conflict' ? 'warn' : 'err');
      setInfo(await lastSyncInfo());
      bump();
    } catch (e) {
      toast(`同步失败：${e instanceof Error ? e.message : e}`, 'err');
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="space-y-3">
      <div>
        <label className="label">同步方式</label>
        <select
          className="field"
          value={cfg.adapter}
          onChange={(e) => patch({ adapter: e.target.value as SyncAdapterId })}
        >
          {SYNC_LIST.map((a) => (
            <option key={a.id} value={a.id}>
              {a.label}
            </option>
          ))}
        </select>
        <p className="text-[11px] text-fg-dim mt-1">{adapter.hint}</p>
      </div>

      {cfg.adapter === 'localFolder' && (
        <div className="flex items-center gap-2">
          <button
            className="btn"
            onClick={async () => {
              try {
                const h = await pickFolder();
                setFolderName(h?.name ?? '');
                toast(h ? `已选择文件夹：${h.name}` : '未选择');
              } catch (e) {
                toast(e instanceof Error ? e.message : String(e), 'err');
              }
            }}
          >
            选择同步文件夹
          </button>
          {folderName && <span className="text-xs text-fg-muted">{folderName}</span>}
          <button
            className="btn btn-ghost text-xs"
            onClick={async () => {
              await clearHandle();
              setFolderName('');
              toast('已清除文件夹授权');
            }}
          >
            清除
          </button>
        </div>
      )}

      {adapter.fields.map((f) =>
        f === 'password' ? (
          <div key={f}>
            <label className="label">{FIELD_LABEL[f]}</label>
            <input
              type="password"
              className="field"
              value={secret}
              placeholder={secretSaved ? '已保存，留空表示不修改' : ''}
              onChange={(e) => setSecret(e.target.value)}
            />
          </div>
        ) : (
          <div key={f}>
            <label className="label">{FIELD_LABEL[f]}</label>
            <input
              className="field"
              value={(cfg[f as keyof SyncConfig] as string) ?? ''}
              onChange={(e) => patch({ [f]: e.target.value } as Partial<SyncConfig>)}
            />
          </div>
        ),
      )}

      {cfg.adapter === 'supabase' && (
        <details className="text-[11px] text-fg-dim">
          <summary className="cursor-pointer">建表 SQL（第一次用需要执行）</summary>
          <pre className="mt-1 p-2 bg-bg-elev rounded overflow-x-auto">{SUPABASE_SQL}</pre>
        </details>
      )}

      <label className="text-xs text-fg-muted flex items-center gap-2">
        <input
          type="checkbox"
          checked={cfg.autoMinutes > 0}
          onChange={(e) => patch({ autoMinutes: e.target.checked ? 15 : 0 })}
        />
        每 15 分钟自动同步一次（页面打开时才会执行，浏览器没有后台常驻能力）
      </label>

      <div className="flex items-center gap-2 flex-wrap">
        <button className="btn btn-primary" onClick={() => void persist()}>
          <Icon name="Download" size={14} /> 保存配置
        </button>
        <button className="btn" onClick={() => void test()} disabled={cfg.adapter === 'none'}>
          测试连接
        </button>
        <button
          className="btn"
          onClick={() => void syncNow()}
          disabled={running || cfg.adapter === 'none'}
        >
          {running ? '同步中…' : '立即同步'}
        </button>
        {testing && <span className="text-[11px] text-fg-muted max-w-md">{testing}</span>}
      </div>

      <div className="text-[11px] text-fg-dim">
        上次同步：
        {info.status === 'never'
          ? '从未同步'
          : `${info.status === 'success' ? '成功' : info.status === 'conflict' ? '有冲突' : '失败'}${info.at ? ` · ${fmtDateTime(info.at)}` : ''}`}
      </div>

      {conflicts && conflicts.length > 0 && (
        <ConflictList
          conflicts={conflicts}
          onResolve={async (id, how) => {
            const msg = await resolveConflict(id, how);
            toast(msg);
            bump();
          }}
        />
      )}

      {logs && logs.length > 0 && (
        <div>
          <div className="sec-title mb-1">同步日志</div>
          <div className="card divide-y divide-line text-[11px]">
            {logs.map((l) => (
              <div key={l.id} className="flex items-center gap-2 px-2 py-1.5">
                <span
                  className="chip"
                  style={{
                    borderColor:
                      l.status === 'success' ? '#3fb984' : l.status === 'conflict' ? '#f0a13c' : '#e5484d',
                    color:
                      l.status === 'success' ? '#3fb984' : l.status === 'conflict' ? '#f0a13c' : '#e5484d',
                  }}
                >
                  {l.status === 'success' ? '成功' : l.status === 'conflict' ? '冲突' : '失败'}
                </span>
                <span className="text-fg-muted">{l.adapter}</span>
                <span className="text-fg-dim">
                  ↑{l.pushed} ↓{l.pulled} · {fmtDateTime(l.startedAt)}
                </span>
                {l.message && <span className="truncate text-fg-dim">{l.message}</span>}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ConflictList({
  conflicts,
  onResolve,
}: {
  conflicts: Conflict[];
  onResolve: (id: string, how: 'local' | 'remote' | 'both' | 'manual') => void;
}) {
  return (
    <div className="border border-[#f0a13c]/50 rounded-md p-2">
      <div className="text-xs text-[#f0a13c] mb-2">
        {conflicts.length} 处冲突：两台设备都改过同一条，需要你决定保留哪一份
      </div>
      <div className="space-y-2">
        {conflicts.map((c) => {
          const l = c.localSnapshot as Record<string, unknown>;
          const r = c.remoteSnapshot as Record<string, unknown>;
          return (
            <div key={c.id} className="card p-2">
              <div className="text-xs mb-1.5">
                {String(l._title ?? c.entityId)}
                <span className="text-fg-dim ml-1">（{c.entityType}）</span>
              </div>
              <div className="grid md:grid-cols-2 gap-2 text-[11px]">
                <div className="bg-bg-elev rounded p-1.5">
                  <div className="text-fg-dim mb-0.5">本地 rev{c.localRev}</div>
                  <div>标题：{String(l.title ?? l.name ?? '—')}</div>
                  <div>状态：{String(l.status ?? '—')}</div>
                  <div>更新于：{String(l.updatedAt ?? '—').slice(0, 19).replace('T', ' ')}</div>
                </div>
                <div className="bg-bg-elev rounded p-1.5">
                  <div className="text-fg-dim mb-0.5">远端 rev{c.remoteRev}</div>
                  <div>标题：{String(r.title ?? r.name ?? '—')}</div>
                  <div>状态：{String(r.status ?? '—')}</div>
                  <div>更新于：{String(r.updatedAt ?? '—').slice(0, 19).replace('T', ' ')}</div>
                </div>
              </div>
              <div className="flex gap-1.5 mt-2 flex-wrap">
                <button className="btn text-[11px]" onClick={() => onResolve(c.id, 'local')}>
                  保留本地
                </button>
                <button className="btn text-[11px]" onClick={() => onResolve(c.id, 'remote')}>
                  保留远端
                </button>
                <button className="btn text-[11px]" onClick={() => onResolve(c.id, 'both')}>
                  两份都留
                </button>
                <button className="btn text-[11px]" onClick={() => onResolve(c.id, 'manual')}>
                  稍后我手动改
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
