import type { Snapshot } from '../../io/backup';
import type { SyncAdapter, SyncAdapterId, SyncConfig, TestResult } from './types';

/**
 * 三种远程适配器（WebDAV / GitHub / Supabase）都通过 HTTP 读写同一份 JSON 快照，
 * 因此共用一份实现骨架。
 *
 * 重要提醒（浏览器限制）：
 * - WebDAV 服务端必须返回 CORS 头，否则浏览器直连会被拦；
 * - GitHub / Supabase 本身就是云服务，属于"可关闭的附加项"，不是本地优先的必要件。
 */

function authHeader(cfg: SyncConfig, secret: string, id: SyncAdapterId): Record<string, string> {
  if (id === 'webdav') {
    return { Authorization: `Basic ${btoa(`${cfg.username}:${secret}`)}` };
  }
  if (id === 'github') {
    return { Authorization: `Bearer ${secret}`, Accept: 'application/vnd.github+json' };
  }
  if (id === 'supabase') {
    return { apikey: secret, Authorization: `Bearer ${secret}` };
  }
  return {};
}

/* ------------------------------------------------------------------ */
/* WebDAV                                                              */
/* ------------------------------------------------------------------ */

const webdav: SyncAdapter = {
  id: 'webdav',
  label: 'WebDAV',
  remote: true,
  hint: '坚果云 / 群晖 / Nextcloud 等；服务端必须允许跨域（CORS）',
  fields: ['url', 'username', 'password', 'path'],

  async test(cfg, secret): Promise<TestResult> {
    if (!cfg.url) return { ok: false, message: '请填写 WebDAV 地址' };
    try {
      const res = await fetch(cfg.url.replace(/\/$/, ''), {
        method: 'PROPFIND',
        headers: { ...authHeader(cfg, secret, 'webdav'), Depth: '0' },
      });
      return res.ok || res.status === 207
        ? { ok: true, message: `连接正常（HTTP ${res.status}）` }
        : { ok: false, message: `服务端返回 ${res.status}` };
    } catch (e) {
      return { ok: false, message: `${e instanceof Error ? e.message : e}（多半是 CORS 被拦）` };
    }
  },

  async read(cfg, secret): Promise<Snapshot | null> {
    const url = `${cfg.url.replace(/\/$/, '')}/${cfg.remotePath}`;
    const res = await fetch(url, { headers: authHeader(cfg, secret, 'webdav') });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`WebDAV 读取失败 ${res.status}`);
    return (await res.json()) as Snapshot;
  },

  async write(cfg, secret, snap): Promise<void> {
    const url = `${cfg.url.replace(/\/$/, '')}/${cfg.remotePath}`;
    const res = await fetch(url, {
      method: 'PUT',
      headers: { ...authHeader(cfg, secret, 'webdav'), 'Content-Type': 'application/json' },
      body: JSON.stringify(snap),
    });
    if (!res.ok && res.status !== 201 && res.status !== 204) {
      throw new Error(`WebDAV 写入失败 ${res.status}`);
    }
  },
};

/* ------------------------------------------------------------------ */
/* GitHub（用 Contents API 存一个 JSON 文件）                            */
/* ------------------------------------------------------------------ */

interface GhFile {
  sha?: string;
  content?: string;
}

/**
 * 仓库名归一化：用户很可能直接粘贴 https://github.com/owner/repo
 * 或者带 .git 后缀，这里都吃掉，只留 owner/repo。
 */
function normalizeRepo(input: string): string {
  return input
    .trim()
    .replace(/^https?:\/\/github\.com\//i, '')
    .replace(/^git@github\.com:/i, '')
    .replace(/\.git$/i, '')
    .replace(/^\/+|\/+$/g, '');
}

/** 把 GitHub 返回的原话带上，比只看状态码有用得多 */
async function ghDetail(res: Response): Promise<string> {
  try {
    const j = (await res.json()) as { message?: string };
    return j?.message ? ` GitHub 原话：${j.message}` : '';
  } catch {
    return ''; // 响应不是 JSON（比如被中间层改写），忽略
  }
}

/**
 * GitHub 的错误码要说人话。
 * 特别注意：**私有仓库没权限时也返回 404**（GitHub 故意的，避免泄露仓库是否存在），
 * 所以 404 必须提示"可能是权限不够"，否则用户会一直在仓库名上找问题。
 */
function ghError(status: number, repo: string): string {
  if (status === 401) {
    return [
      '401：Token 无效、已过期，或者**没有写入权限**。',
      '特别注意：如果「测试连接」能通过、但同步时报 401，几乎可以肯定你用的是',
      'fine-grained token 且 Contents 权限还是默认的 Read-only ——',
      '请到 GitHub 把它改成 Read and write（或改用 classic token 并勾选 repo）。',
    ].join(' ');
  }
  if (status === 403) {
    return [
      '403：权限不足或被限流。',
      'fine-grained token 请把 Contents 设为 Read and write；',
      'classic token 请勾选 repo。',
    ].join(' ');
  }
  if (status === 409) {
    return [
      '409：写入冲突（版本号过期）。最常见的情况是**这个文件刚被写过** ——',
      '「自动同步」和「备份到同步目标」撞在一起，或你在另一台设备/网页上刚改过。',
      '软件已自动重试 3 次；仍失败的话，等 10 秒再点一次同步通常就好了。',
      '如果反复出现，再检查分支名（仓库默认可能是 master，而你填了 main）。',
      '下面的 GitHub 原话能区分这两者。',
    ].join(' ');
  }
  if (status === 404) {
    return [
      `404：仓库「${repo}」不存在，或者 Token 没权限访问它。`,
      'GitHub 对"无权限的私有仓库"也返回 404，所以请依次确认：',
      '① 仓库名格式是 owner/repo（不是完整网址，也不是邮箱）',
      '② 仓库确实存在，且是你要用 Token 的那个账号下的',
      '③ classic token 要勾选 repo；fine-grained token 要选中这个仓库并给 Contents: Read and write',
    ].join(' ');
  }
  return `GitHub 返回 ${status}`;
}

const github: SyncAdapter = {
  id: 'github',
  label: 'GitHub 仓库',
  remote: true,
  hint: '在仓库里存一个 JSON 文件；需要 Personal Access Token（repo 权限）',
  fields: ['repo', 'branch', 'path', 'password'],

  async test(cfg, secret): Promise<TestResult> {
    const repo = normalizeRepo(cfg.repo);
    if (!repo.includes('/')) {
      return { ok: false, message: '仓库格式应为 owner/repo（例如 zhangsan/personal-os-sync）' };
    }
    if (!secret) return { ok: false, message: '还没填 Token（密码一栏）' };
    try {
      const res = await fetch(`https://api.github.com/repos/${repo}`, {
        headers: authHeader(cfg, secret, 'github'),
      });
      if (!res.ok) return { ok: false, message: ghError(res.status, repo) };
      // 顺带判断"能不能写"——只读的 Token 会让测试通过但同步失败，很难查
      const scopes = (res.headers.get('X-OAuth-Scopes') ?? '').trim();
      let hint: string;
      if (!scopes) {
        hint =
          '（读不到权限列表，多半是 fine-grained token：请确认 Contents 是 Read and write，否则测试能过但同步会 401）';
      } else if (/\brepo\b/.test(scopes) || /\bpublic_repo\b/.test(scopes)) {
        hint = `（Token 权限含写：${scopes}）`;
      } else {
        hint = `（⚠ Token 没有写权限，只有 ${scopes} —— 同步上传会失败，请加 repo 权限）`;
      }
      return { ok: true, message: `仓库可访问：${repo} ${hint}` };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
  },

  async read(cfg, secret): Promise<Snapshot | null> {
    const repo = normalizeRepo(cfg.repo);
    const url = `https://api.github.com/repos/${repo}/contents/${cfg.remotePath}?ref=${cfg.branch || 'main'}&_=${Date.now()}`;
    // cache: 'no-store' 很重要 —— 见 write() 里的注释
    const res = await fetch(url, { headers: authHeader(cfg, secret, 'github'), cache: 'no-store' });
    if (res.status === 404) return null; // 文件还没有，正常
    if (!res.ok) throw new Error(ghError(res.status, repo) + (await ghDetail(res)));
    const data = (await res.json()) as GhFile;
    if (!data.content) return null;
    return JSON.parse(decodeURIComponent(escape(atob(data.content.replace(/\n/g, ''))))) as Snapshot;
  },

  /**
   * 写入串行化。
   *
   * 「自动同步」和「备份到同步目标」都会写同一个 JSON，两者撞在一起时
   * 先完成的那次会让后一次的 sha 立刻过期 → 409 "does not match <旧 sha>"。
   * 用户看到的就是"先显示已同步，紧接着又报写入失败"。
   * 所以同一时刻只允许一个 GitHub 写操作在跑，后来者排队。
   */
  async write(cfg, secret, snap): Promise<void> {
    const run = () => ghWrite(cfg, secret, snap);
    const task = ghWriteChain.then(run, run); // 前一个失败也不阻塞后一个
    ghWriteChain = task.catch(() => undefined);
    return task;
  },
};

/** GitHub 写入队列（模块级，跨调用共享） */
let ghWriteChain: Promise<unknown> = Promise.resolve();

/** 真正的写入实现（已被 write() 串行化） */
async function ghWrite(
  cfg: Parameters<SyncAdapter['write']>[0],
  secret: string,
  snap: Snapshot,
): Promise<void> {
  const repo = normalizeRepo(cfg.repo);
  const branch = cfg.branch || 'main';
  const url = `https://api.github.com/repos/${repo}/contents/${cfg.remotePath}`;
  const headers = authHeader(cfg, secret, 'github');
  const payload = {
    message: `sync ${new Date().toISOString()}`,
    content: btoa(unescape(encodeURIComponent(JSON.stringify(snap)))),
    branch,
  };

  /**
   * 取远端当前文件的 sha —— 文件已存在时**必须**带上，否则 GitHub 直接 409。
   *
   * `cache: 'no-store'` + 时间戳参数是必需品，不是保险：
   * GitHub Contents API 的读走 CDN，**刚写完立刻读很可能拿到旧 sha**，
   * 于是 PUT 报 409 "does not match <旧 sha>"，而且重读还是旧值 ——
   * 这个坑从报错文案完全看不出来，只会让人去怀疑分支名。
   *
   * ⚠️ 千万别顺手加 `Cache-Control: no-cache` / `Pragma: no-cache` 这类请求头。
   * 它们是非标准头，会让浏览器先发 CORS 预检；GitHub 的
   * `Access-Control-Allow-Headers` 不含这两个，预检直接被拒 ——
   * 而 `cache: 'no-store'` 是 fetch 的**选项**不是请求头，不触发预检，安全性一样。
   * 症状很有迷惑性：GET 正常、PUT 报 "Failed to fetch"，看起来像网络问题。
   */
  const currentSha = async (): Promise<string | undefined> => {
    const res = await fetch(`${url}?ref=${encodeURIComponent(branch)}&_=${Date.now()}`, {
      headers,
      cache: 'no-store',
    });
    if (res.status === 200) return ((await res.json()) as GhFile).sha;
    if (res.status === 404) return undefined; // 文件还没有，正常
    // 其它情况（权限、分支不存在…）不能当成"文件不存在"，否则会带着空 sha 去写 → 409
    throw new Error(`准备写入时读取出错：${ghError(res.status, repo)}${await ghDetail(res)}`);
  };

  const doPut = async (sha?: string) =>
    fetch(url, {
      method: 'PUT',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(sha ? { ...payload, sha } : payload),
    });

  /**
   * fetch 抛的不是 HTTP 错误，而是**请求根本没发出去**（网络中断、代理挂掉、
   * 或 CORS 预检被拒）。这时 `e.message` 只有一句 "Failed to fetch"，
   * 对用户毫无信息量 —— 翻译成人话，并给出可操作的排查方向。
   */
  const send = async (sha?: string): Promise<Response> => {
    try {
      return await doPut(sha);
    } catch (e) {
      throw new Error(
        `请求没能发出去（${e instanceof Error ? e.message : String(e)}）。` +
          '这不是账号或仓库配置的问题，而是网络层被拦断了。常见原因：' +
          '① 代理 / VPN 不稳定或已断开；' +
          '② 网络环境屏蔽了 api.github.com；' +
          '③ 浏览器层面的跨域预检被拒。' +
          '可以先断开代理再试一次，或换一个网络（如手机热点）。',
      );
    }
  };

  let res = await send(await currentSha());

  /**
   * 409 重试：重新读 sha 再写，最多 3 次，退避 250 / 1000 / 2250ms。
   * 退避不能省 —— 立刻重读多半还是同一个旧值，干等必然会一直失败。
   */
  for (let attempt = 1; attempt <= 3 && res.status === 409; attempt += 1) {
    await new Promise((r) => setTimeout(r, 250 * attempt * attempt));
    res = await send(await currentSha());
  }

  if (!res.ok) {
    throw new Error(`写入失败：${ghError(res.status, repo)}${await ghDetail(res)}`);
  }
}

/* ------------------------------------------------------------------ */
/* Supabase（PostgREST）                                               */
/* ------------------------------------------------------------------ */

export const SUPABASE_SQL = `create table if not exists snapshots (
  id text primary key,
  data jsonb not null,
  updated_at timestamptz default now()
);
alter table snapshots enable row level security;
-- 如果你是自己一个人用，可以临时放开：
create policy "own data" on snapshots for all using (true) with check (true);`;

const supabase: SyncAdapter = {
  id: 'supabase',
  label: 'Supabase',
  remote: true,
  hint: '云端 Postgres；需先建一张 snapshots 表（建表 SQL 见下方）',
  fields: ['url', 'table', 'password'],

  async test(cfg, secret): Promise<TestResult> {
    if (!cfg.url) return { ok: false, message: '请填写 Project URL' };
    try {
      const res = await fetch(`${cfg.url.replace(/\/$/, '')}/rest/v1/${cfg.table}?select=id&limit=1`, {
        headers: authHeader(cfg, secret, 'supabase'),
      });
      return res.ok
        ? { ok: true, message: '表可访问' }
        : { ok: false, message: `${res.status}（检查 URL / Key / 表名，或表还没建）` };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
  },

  async read(cfg, secret): Promise<Snapshot | null> {
    const res = await fetch(
      `${cfg.url.replace(/\/$/, '')}/rest/v1/${cfg.table}?id=eq.main&select=data`,
      { headers: authHeader(cfg, secret, 'supabase') },
    );
    if (!res.ok) throw new Error(`Supabase 读取失败 ${res.status}`);
    const rows = (await res.json()) as { data?: Snapshot }[];
    return rows[0]?.data ?? null;
  },

  async write(cfg, secret, snap): Promise<void> {
    const res = await fetch(`${cfg.url.replace(/\/$/, '')}/rest/v1/${cfg.table}`, {
      method: 'POST',
      headers: {
        ...authHeader(cfg, secret, 'supabase'),
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates',
      },
      body: JSON.stringify({ id: 'main', data: snap }),
    });
    if (!res.ok) throw new Error(`Supabase 写入失败 ${res.status}`);
  },
};

export const remoteAdapters = { webdav, github, supabase };
