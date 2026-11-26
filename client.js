window.__ModuleLoader__.load({
  id: '@shirayner/dsh-mcp-management',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useCallback, useRef, useMemo } = React;

    /* ─── API ─── */
    function api(path) {
      const rel = path.replace(/^\/+/, '');
      return typeof document === 'undefined' ? '/' + rel : new URL(rel, document.baseURI).pathname;
    }

    async function rpc(endpoint, body) {
      const isGet = !body;
      const res = await fetch(api('/api/mcp-management/' + endpoint), isGet
        ? { method: 'GET', cache: 'no-store' }
        : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      if (![200, 400, 413, 415].includes(res.status)) throw new Error('请求失败（' + res.status + '），请确认 DSH 已登录且版本支持此插件');
      const data = await res.json();
      if (!data.ok) {
        const error = new Error(data.error?.message || 'Request failed');
        error.code = data.error?.code ?? null;
        throw error;
      }
      return data.value;
    }

    /* ═══════════════════════════════════════════════════════
       CSS
       ═══════════════════════════════════════════════════════ */
    const CSS = `
/* dsh-mcp-management v2 — scoped .mcpm */
.mcpm *{box-sizing:border-box}
.mcpm{font:14px/1.5 system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;color:var(--dsw-alias-label-primary);max-width:760px}

/* ── Typography ── */
.mcpm .mono{font-family:ui-monospace,SFMono-Regular,Consolas,"Liberation Mono",monospace;font-size:12.5px}
.mcpm .muted{color:var(--dsw-alias-label-secondary)}
.mcpm .caption{font-size:12.5px;color:var(--dsw-alias-label-tertiary)}

/* ── Header ── */
.mcpm .hd{display:flex;align-items:flex-start;gap:16px;margin-bottom:20px}
.mcpm .hd-text{flex:1}
.mcpm .hd h2{font-size:18px;margin:0 0 4px;font-weight:600}
.mcpm .hd p{margin:0;font-size:13px;color:var(--dsw-alias-label-secondary)}
.mcpm .hd-actions{display:flex;gap:8px;flex-shrink:0;padding-top:2px}

/* ── Buttons ── */
.mcpm .btn{display:inline-flex;align-items:center;gap:6px;height:32px;padding:0 12px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);cursor:pointer;white-space:nowrap;font:inherit;color:inherit;font-size:13px}
.mcpm .btn:hover{background:var(--dsw-alias-bg-layer-1)}
.mcpm .btn:disabled{opacity:.45;cursor:not-allowed}
.mcpm .btn.btn-pri{background:var(--dsw-alias-brand-primary) !important;border-color:transparent;color:var(--dsw-alias-bg-base) !important}
.mcpm .btn.btn-pri:hover{filter:brightness(1.06)}
.mcpm .btn.btn-err{color:var(--dsw-alias-state-error-primary)}
.mcpm .btn.btn-ghost{border-color:transparent;background:none}
.mcpm .btn.btn-sm{height:28px;padding:0 10px;font-size:12.5px}
.mcpm .btn:focus-visible,.mcpm input:focus-visible,.mcpm textarea:focus-visible,.mcpm .sw:focus-visible,.mcpm .seg button:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}

/* ── Switch ── */
.mcpm .sw{position:relative;width:34px;height:20px;border-radius:10px;border:0;background:var(--dsw-alias-state-idle-primary);cursor:pointer;flex:none;padding:0}
.mcpm .sw::after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;transition:left .15s}
.mcpm .sw[aria-checked="true"]{background:var(--dsw-alias-brand-primary)}
.mcpm .sw[aria-checked="true"]::after{background:var(--dsw-alias-bg-base)}
.mcpm .sw[aria-checked="true"]::after{left:16px}

/* ── Badge ── */
.mcpm .badge{display:inline-flex;align-items:center;height:20px;padding:0 7px;border-radius:10px;font-size:11.5px;font-weight:500;white-space:nowrap}
.mcpm .badge-ok{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 12%,transparent);color:var(--dsw-alias-state-success-primary)}
.mcpm .badge-err{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 12%,transparent);color:var(--dsw-alias-state-error-primary)}
.mcpm .badge-warn{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 12%,transparent);color:var(--dsw-alias-state-warn-primary)}
.mcpm .badge-info{background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent);color:var(--dsw-alias-brand-primary)}
.mcpm .badge-idle{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary)}
.mcpm .badge-oauth{background:rgba(175,82,222,.12);color:#af52de}

/* ── Status dot ── */
.mcpm .dot{display:inline-block;width:8px;height:8px;border-radius:50%;flex:none}
.mcpm .dot-ok{background:var(--dsw-alias-state-success-primary)}
.mcpm .dot-err{background:var(--dsw-alias-state-error-primary)}
.mcpm .dot-busy{background:var(--dsw-alias-brand-primary);animation:mcpm-p 1s infinite}
.mcpm .dot-idle{background:var(--dsw-alias-state-idle-primary)}
.mcpm .dot-warn{background:var(--dsw-alias-state-warn-primary)}
.mcpm .oauth-box{padding:12px 16px;border-radius:8px;background:var(--dsw-alias-bg-layer-1);display:flex;flex-direction:column;gap:10px}
.mcpm .oauth-row{display:flex;align-items:center;gap:12px}
.mcpm .oauth-code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:18px;font-weight:600;letter-spacing:2px}
.mcpm .oauth-link{word-break:break-all;color:var(--dsw-alias-label-primary);text-decoration:underline}
@keyframes mcpm-p{50%{opacity:.35}}
@media(prefers-reduced-motion:reduce){.mcpm .dot-busy{animation:none}}

/* ── Toolbar ── */
.mcpm .toolbar{display:flex;gap:12px;align-items:center;margin-bottom:16px}
.mcpm .search{flex:1;height:32px;padding:0 10px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);font:inherit;color:inherit;font-size:13px}
.mcpm .stats{display:flex;gap:14px;font-size:12.5px;color:var(--dsw-alias-label-secondary)}
.mcpm .stats span{display:inline-flex;align-items:center;gap:5px}

/* ── Server list ── */
.mcpm .list{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;overflow:hidden}
.mcpm .row{display:flex;align-items:center;gap:12px;padding:12px 16px;border-top:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);transition:background .1s}
.mcpm .row:first-child{border-top:0}
.mcpm .row:hover{background:var(--dsw-alias-bg-layer-1)}
.mcpm .row-body{flex:1;min-width:0;cursor:pointer}
.mcpm .row-title{display:flex;align-items:center;gap:8px;font-weight:600;font-size:14px}
.mcpm .row-sub{margin-top:2px;font-size:12.5px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-family:ui-monospace,SFMono-Regular,Consolas,monospace}
.mcpm .row-badges{display:flex;gap:6px;margin-top:6px;flex-wrap:wrap}
.mcpm .row-error{margin-top:6px;padding:6px 10px;border-radius:6px;font-size:12.5px;background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 8%,transparent);color:var(--dsw-alias-state-error-primary)}

/* ── Empty state ── */
.mcpm .empty{padding:48px 24px;text-align:center;border:1px dashed var(--dsw-alias-border-l2);border-radius:8px}
.mcpm .empty h3{margin:12px 0 4px;font-size:15px}

/* ── Back link ── */
.mcpm .back{border:0;background:none;padding:0;color:var(--dsw-alias-label-secondary);cursor:pointer;margin-bottom:16px;font:inherit;font-size:13px}
.mcpm .back:hover{color:var(--dsw-alias-label-primary)}

/* ── Card ── */
.mcpm .card{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:16px 18px;margin-bottom:16px;background:var(--dsw-alias-bg-base)}
.mcpm .card h3{margin:0 0 12px;font-size:14px;font-weight:600;display:flex;align-items:center;gap:8px}

/* ── Key-value grid ── */
.mcpm .kv{display:grid;grid-template-columns:110px 1fr;gap:8px 16px;font-size:13px}
.mcpm .kv dt{color:var(--dsw-alias-label-secondary)}
.mcpm .kv dd{margin:0;word-break:break-all}

/* ── Tools list ── */
.mcpm .tools{list-style:none;margin:0;padding:0}
.mcpm .tools li{padding:8px 0;border-top:1px solid var(--dsw-alias-border-l1)}
.mcpm .tools li:first-child{border-top:0}
.mcpm .tname{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12.5px;font-weight:600}
.mcpm .tdesc{font-size:12.5px;color:var(--dsw-alias-label-secondary)}

/* ── Form ── */
.mcpm .field{margin-bottom:16px}
.mcpm .flabel{display:block;font-weight:600;margin-bottom:6px;font-size:13px}
.mcpm .fhint{font-size:12px;color:var(--dsw-alias-label-tertiary);margin-top:4px}
.mcpm .ferr{font-size:12px;color:var(--dsw-alias-state-error-primary);margin-top:4px}
.mcpm input[type=text],.mcpm input[type=number],.mcpm input[type=password]{width:100%;height:34px;padding:0 10px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);font:inherit;color:inherit;font-size:13px}
.mcpm input.invalid{border-color:var(--dsw-alias-state-error-primary)}
.mcpm .two{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.mcpm .seg{display:inline-flex;padding:2px;border-radius:6px;background:var(--dsw-alias-bg-layer-2);gap:2px}
.mcpm .seg button{border:0;background:none;height:28px;padding:0 12px;border-radius:5px;cursor:pointer;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px}
.mcpm .seg button[aria-pressed="true"]{background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-weight:600;box-shadow:0 1px 2px rgba(0,0,0,.08)}
.mcpm .switch-line{display:flex;align-items:center;gap:10px;font-size:13px}
.mcpm .kvedit{display:grid;grid-template-columns:140px 1fr 32px;gap:8px;margin-bottom:6px}
.mcpm .kvedit input{height:32px;padding:0 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);width:100%;font:inherit;color:inherit;font-size:12.5px}
.mcpm .form-foot{position:sticky;bottom:0;display:flex;gap:8px;justify-content:flex-end;padding:14px 0;background:var(--dsw-alias-bg-base);border-top:1px solid var(--dsw-alias-border-l1);margin-top:8px}
.mcpm .form-foot .grow{flex:1;display:flex;align-items:center;font-size:13px}
.mcpm details.adv>summary{cursor:pointer;font-weight:600;font-size:13px;color:var(--dsw-alias-label-secondary);margin-bottom:4px}
.mcpm details.adv[open]>summary{margin-bottom:12px}

/* ── Overlay / Dialog ── */
.mcpm .overlay{position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.5)}
.mcpm .dlg{background:var(--dsw-alias-bg-base);border-radius:12px;border:1px solid var(--dsw-alias-border-l2);width:min(600px,90vw);max-height:80vh;display:flex;flex-direction:column;box-shadow:0 12px 40px rgba(0,0,0,.25)}
.mcpm .dlg-head{display:flex;align-items:center;gap:10px;padding:16px 20px 12px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.mcpm .dlg-head h3{margin:0;font-size:15px;font-weight:600;flex:1}
.mcpm .dlg-body{padding:16px 20px;overflow-y:auto;flex:1}
.mcpm .dlg-foot{padding:12px 20px;border-top:1px solid var(--dsw-alias-border-l1);display:flex;gap:8px;justify-content:flex-end}
.mcpm textarea{width:100%;min-height:180px;padding:10px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12.5px;color:inherit;resize:vertical;line-height:1.5}
.mcpm textarea:focus{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-1px}
.mcpm .preview{margin-top:12px;border-radius:6px;overflow:hidden}
.mcpm .preview-item{display:flex;align-items:center;gap:8px;padding:8px 12px;background:var(--dsw-alias-bg-layer-1);border-top:1px solid var(--dsw-alias-border-l1);font-size:13px}
.mcpm .preview-item:first-child{border-top:0}
.mcpm .result{margin-top:12px;padding:10px 12px;border-radius:6px;font-size:13px}
.mcpm .result-ok{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 10%,transparent);color:var(--dsw-alias-state-success-primary)}
.mcpm .result-err{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent);color:var(--dsw-alias-state-error-primary)}

.mcpm .sw:disabled{opacity:.45;cursor:not-allowed}
/* ── Confirm ── */
.mcpm .confirm-bar{display:flex;gap:8px;align-items:center;font-size:13px}

@media(max-width:760px){.mcpm .two{grid-template-columns:1fr}}
`;

    /* ═══════════════════════════════════════════════════════
       Helpers
       ═══════════════════════════════════════════════════════ */
    const STATUS = {
      active:   { dot: 'dot-idle', label: '已启用 · 状态待确认', badge: 'badge-idle' },
      connected: { dot: 'dot-ok', label: '已连接', badge: 'badge-ok' },
      failed:   { dot: 'dot-err',  label: '连接失败', badge: 'badge-err' },
      loading:  { dot: 'dot-busy', label: '连接中',   badge: 'badge-info' },
      pending:  { dot: 'dot-idle', label: '等待启动', badge: 'badge-idle' },
      disabled: { dot: 'dot-idle', label: '已停用',   badge: 'badge-idle' },
    };

    function serverStatus(s) {
      if (!s.enabled) return STATUS.disabled;
      // fiberPhase stays 'active' even when every connection attempt fails, so the
      // upstream response the OAuth layer observed takes precedence.
      if (s.oauth?.rejected) return { dot: 'dot-warn', label: 'token 被拒绝（401）', badge: 'badge-warn' };
      if (s.oauth?.connectionState === 'failed') return STATUS.failed;
      if (s.oauth?.connectionState === 'needs-authorization' || (s.oauth?.required && !s.oauth.authorized)) return { dot: 'dot-warn', label: '需要授权', badge: 'badge-warn' };
      if (s.oauth?.connectionState === 'connected') return STATUS.connected;
      if (s.oauth?.connectionState === 'connecting') return STATUS.loading;
      return STATUS[s.fiberPhase] || { dot: 'dot-idle', label: s.fiberPhase || '未知', badge: 'badge-idle' };
    }

    function endpointOf(s) {
      return s.transport === 'stdio' ? (s.command + ' ' + (Array.isArray(s.args) ? s.args.join(' ') : s.args || '')).trim() : (s.url || '—');
    }

    /** RFC 9110 field-name token. */
    const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
    /** Split a pasted "X-API-Key:example-token" pair without treating a Bearer value as a name. */
    const PASTED_PAIR = /^([!#$%&'*+.^_`|~0-9A-Za-z]+-[!#$%&'*+.^_`|~0-9A-Za-z-]*)\s*:\s*(.+)$/;

    function splitHeaderPair(key, value) {
      const inKey = key.match(PASTED_PAIR);
      if (inKey && !value) return { key: inKey[1], value: inKey[2].trim() };
      return { key, value };
    }

    function authLabel(s) {
      if (s.authMode === 'none') return { label: '无认证', css: 'badge-idle' };
      if (s.authMode === 'token') return { label: 'Headers · 已配置', css: 'badge-idle' };
      if (s.oauth?.configured) return { label: 'OAuth · 授权已保存', css: 'badge-oauth' };
      if (s.oauth?.required) return { label: 'OAuth · 未授权', css: 'badge-warn' };
      if (s.headerNames?.length) {
        const keys = s.headerNames;
        if (keys.some(k => k.toLowerCase() === 'authorization')) return { label: 'Token', css: 'badge-warn' };
        return { label: 'Headers', css: 'badge-idle' };
      }
      return { label: '无认证', css: 'badge-idle' };
    }

    function transportLabel(s) {
      return s.transport === 'stdio' ? 'stdio' : 'HTTP';
    }

    /* ═══════════════════════════════════════════════════════
       Primitive components
       ═══════════════════════════════════════════════════════ */
    function formatTime(ms) {
      return ms ? new Date(ms).toLocaleString() : '—';
    }

    /**
     * Device-code authorization for one URL. Usable before the server is saved:
     * the grant is keyed by URL, so saving afterwards picks it up.
     */
    function OAuthPanel({ url, oauth, onChange }) {
      const [attempt, setAttempt] = useState(null);
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState('');
      const [errorCode, setErrorCode] = useState(null);
      const [certificateNotice, setCertificateNotice] = useState('');
      const opened = useRef(null);

      useEffect(() => {
        if (!attempt || attempt.status !== 'pending') return undefined;
        let live = true, timer;
        async function poll() {
          try {
            const next = await rpc('oauth/status', { attemptId: attempt.attemptId });
            if (!live) return;
            setAttempt(next);
            if (next.status === 'pending' && next.notice?.url && opened.current !== next.notice.url) {
              opened.current = next.notice.url;
              window.open(next.notice.url, '_blank', 'noopener');
            }
            if (next.status === 'authorized') onChange?.();
            if (next.status === 'pending') timer = setTimeout(poll, 1500);
          } catch (e) {
            if (!live) return;
            setError(e.message); setErrorCode(e.code ?? null); setAttempt(null);
          }
        }
        timer = setTimeout(poll, 1500);
        return () => { live = false; clearTimeout(timer); };
      }, [url, attempt?.attemptId, attempt?.status, onChange]);

      function begin() {
        if (!url) { setError('请先填写 URL'); return; }
        setBusy(true); setError(''); setErrorCode(null); setCertificateNotice(''); opened.current = null;
        rpc('oauth/start', { url })
          .then(({ attemptId }) => setAttempt({ attemptId, status: 'pending', notice: null }))
          .catch(e => { setError(e.message); setErrorCode(e.code ?? null); })
          .finally(() => setBusy(false));
      }

      function enableSystemCertificates() {
        setBusy(true); setCertificateNotice('');
        rpc('settings', { trustSystemCertificates: true })
          .then(() => {
            setError(''); setErrorCode(null); setAttempt(null);
            setCertificateNotice('已启用系统证书。请完整退出并重启 DSH，再点击“去授权”；仅刷新页面不会生效。');
          })
          .catch(e => { setError(e.message); setErrorCode(e.code ?? null); })
          .finally(() => setBusy(false));
      }

      function cancel() {
        if (attempt) rpc('oauth/cancel', { attemptId: attempt.attemptId }).catch(() => {});
        setAttempt(null);
      }

      function revoke() {
        setBusy(true); setError(''); setErrorCode(null); setCertificateNotice('');
        rpc('oauth/revoke', { url }).then(() => { setAttempt(null); onChange?.(); })
          .catch(e => { setError(e.message); setErrorCode(e.code ?? null); }).finally(() => setBusy(false));
      }

      const pending = attempt?.status === 'pending';
      const done = attempt?.status === 'authorized';
      const current = attempt?.oauth && (!oauth || attempt.oauth.checkedAt > oauth.checkedAt) ? attempt.oauth : oauth;
      const authorized = !!current?.configured;
      const notice = attempt?.notice;
      const certificateFailure = errorCode === 'tls/certificate-trust' || attempt?.errorCode === 'tls/certificate-trust';

      return h('div', { className: 'oauth-box' },
        h('div', { className: 'oauth-row' },
          h('div', { style: { flex: 1 } },
            h('div', { style: { fontWeight: 600, fontSize: 13 } }, 'OAuth 2.0 授权'),
            h('div', { className: 'caption' },
              pending ? (notice ? notice.message : '正在连接授权服务器…')
                : current?.rejected ? '授权已保存，但服务器拒绝了当前 token（HTTP 401）。重新授权后仍出现时，请检查 MCP 服务端的 token 校验。'
                : authorized && current?.connectionState === 'failed' ? '授权已保存，但 MCP 连接失败；这不等于未授权。'
                : authorized ? '授权已保存' + (done && attempt.restarted ? '，已重新发起连接' : '') + ' · token 过期 ' + formatTime(current.expiresAt) + '（到期前自动续期）'
                : '点击授权后在浏览器中确认，无需复制 token')
          ),
          pending
            ? h('button', { type: 'button', className: 'btn btn-sm', onClick: cancel }, '取消')
            : h('button', { type: 'button', className: 'btn btn-sm btn-pri', onClick: begin, disabled: busy || !url }, authorized ? '重新授权' : '去授权'),
          authorized && !pending && h('button', { type: 'button', className: 'btn btn-sm btn-ghost', onClick: revoke, disabled: busy }, '取消授权')
        ),
        pending && notice?.url && h('div', null,
          notice.code && h('div', { className: 'oauth-row' },
            h('span', { className: 'caption' }, '确认码'),
            h('span', { className: 'oauth-code' }, notice.code)
          ),
          h('div', { className: 'caption', style: { marginTop: 6 } }, '浏览器没有自动打开时，点这里：'),
          h('a', { className: 'oauth-link', href: notice.url, target: '_blank', rel: 'noopener noreferrer' }, notice.url)
        ),
        attempt?.connectionError && h('div', { className: 'ferr' }, '授权已保存，但连接失败：' + attempt.connectionError),
        attempt?.status === 'failed' && h('div', { className: 'ferr' }, '授权失败：' + attempt.error),
        attempt?.status === 'cancelled' && h('div', { className: 'fhint' }, '已取消授权'),
        current?.error && !pending && current.error !== error && current.error !== attempt?.error && h('div', { className: 'ferr' }, current.error),
        error && h('div', { className: 'ferr', role: 'alert' }, error),
        certificateFailure && !pending && h('div', null,
          h('div', { className: 'fhint' }, '仅在操作系统已信任该证书时启用。此设置会影响当前 DSH 进程的所有 TLS 连接，不会跳过证书校验。'),
          h('button', { type: 'button', className: 'btn btn-sm', onClick: enableSystemCertificates, disabled: busy }, '启用系统证书（重启后生效）')
        ),
        certificateNotice && h('div', { className: 'fhint', role: 'status' }, certificateNotice)
      );
    }

    function Seg({ value, onChange, options }) {
      return h('div', { className: 'seg', role: 'group' },
        options.map(o => h('button', {
          key: o[0], type: 'button',
          'aria-pressed': String(value === o[0]),
          onClick: () => onChange(o[0]),
        }, o[1]))
      );
    }

    function Switch({ checked, onChange, label, disabled = false }) {
      return h('button', {
        type: 'button', className: 'sw', role: 'switch',
        'aria-checked': String(!!checked),
        'aria-label': label || '', disabled,
        onClick: () => { if (!disabled) onChange(!checked); },
      });
    }

    /* ═══════════════════════════════════════════════════════
       MAIN COMPONENT
       ═══════════════════════════════════════════════════════ */
    function McpManager() {
      const [view, setView] = useState('list');   // list | detail | form
      const [servers, setServers] = useState([]);
      const [loading, setLoading] = useState(true);
      const [current, setCurrent] = useState(null);  // serverName for detail
      const [editTarget, setEditTarget] = useState(null); // null=add, serverName=edit
      const [search, setSearch] = useState('');
      const [showImport, setShowImport] = useState(false);
      const [settings, setSettings] = useState({ trustSystemCertificates: false });
      const [error, setError] = useState('');
      const [busy, setBusy] = useState(null);
      const [notice, setNotice] = useState('');
      const actionPending = useRef(false);

      const refresh = useCallback(() => {
        return Promise.all([rpc('servers'), rpc('settings')]).then(([data, config]) => {
          setServers(data); setSettings(config); setError(''); setLoading(false);
        }).catch(e => { setError(e.message); setLoading(false); });
      }, []);

      useEffect(() => { refresh(); }, [refresh]);

      function openDetail(s) { setCurrent(s.serverName); setView('detail'); }
      function openAdd() { setEditTarget(null); setView('form'); }
      function openEdit(serverName) { setEditTarget(serverName); setView('form'); }
      function backToList() { setView('list'); refresh(); }

      async function runServerAction(kind, body) {
        if (actionPending.current) return;
        actionPending.current = true;
        setBusy(kind); setError(''); setNotice('');
        try {
          const result = await rpc(kind, body);
          if (kind === 'remove') setView('list');
          await refresh();
          if (result.application === 'overridden') setNotice('配置已保存，但被更高优先级的配置覆盖，当前启停状态未改变。');
          else if (result.applied === false) setNotice('配置已保存，请完整重启 DSH 后生效。' + (result.restartReason ? '（' + result.restartReason + '）' : ''));
          else setNotice(kind === 'remove' ? '服务器已删除。' : body.enabled ? '服务器已启用；连接状态以服务器响应为准。' : '服务器已停用。');
          if (result.warnings?.length) setNotice(message => message + ' ' + result.warnings.map(warning => warning.message ?? String(warning)).join('；'));
        } catch (e) { setError(e.message); }
        finally { actionPending.current = false; setBusy(null); }
      }

      function handleToggle(s) {
        return runServerAction('toggle', { entryId: s.entryId, enabled: !s.enabled });
      }

      function handleRemove(serverName) {
        return runServerAction('remove', { serverName });
      }

      if (loading) return h('div', { className: 'mcpm' }, h('p', { className: 'muted' }, '加载中...'));

      const feedback = h(React.Fragment, null,
        error && h('div', { className: 'result result-err', role: 'alert' }, error),
        busy && h('div', { className: 'fhint', role: 'status' }, '处理中…'),
        notice && h('div', { className: 'fhint', role: 'status' }, notice)
      );

      if (view === 'detail') {
        const s = servers.find(x => x.serverName === current);
        if (!s) { setView('list'); return null; }
        return h('div', { className: 'mcpm' },
          feedback,
          h(DetailView, { key: s.entryId, server: s, busy: !!busy, onBack: backToList, onEdit: () => openEdit(s.serverName), onRemove: () => handleRemove(s.serverName), onRefresh: refresh })
        );
      }

      if (view === 'form') {
        const s = editTarget ? servers.find(x => x.serverName === editTarget) : null;
        return h('div', { className: 'mcpm' },
          feedback,
          h(FormView, { server: s, onBack: backToList, onSaved: backToList, onRefresh: refresh })
        );
      }

      return h('div', { className: 'mcpm' },
        feedback,
        h(ListView, {
          servers, search, setSearch, settings, busy: !!busy,
          onTrustSystem: enabled => rpc('settings', { trustSystemCertificates: enabled }).then(() => { setSettings({ ...settings, trustSystemCertificates: enabled }); window.alert('证书设置已保存，重启 DSH 后生效。'); }).catch(e => setError(e.message)),
          onOpen: openDetail,
          onAdd: openAdd,
          onToggle: handleToggle,
          onImport: () => setShowImport(true),
        }),
        showImport && h(ImportDialog, {
          onClose: () => setShowImport(false),
          onDone: () => { setShowImport(false); refresh(); },
        })
      );
    }

    /* ═══════════════════════════════════════════════════════
       LIST VIEW
       ═══════════════════════════════════════════════════════ */
    function ListView({ servers, search, setSearch, onOpen, onAdd, onToggle, onImport, settings, onTrustSystem, busy }) {
      const q = search.trim().toLowerCase();
      const filtered = servers.filter(s => !q || s.serverName.toLowerCase().includes(q) || endpointOf(s).toLowerCase().includes(q));

      const connected = servers.filter(s => serverStatus(s) === STATUS.connected).length;
      const failed = servers.filter(s => s.enabled && s.fiberPhase === 'failed').length;
      const disabled = servers.filter(s => !s.enabled).length;

      return h(React.Fragment, null,
        /* Header */
        h('div', { className: 'hd' },
          h('div', { className: 'hd-text' },
            h('h2', null, 'MCP 服务器'),
            h('p', null, '管理 Model Context Protocol 服务器连接')
          ),
          h('div', { className: 'hd-actions' },
            h('button', { type: 'button', className: 'btn', onClick: onImport }, '↓ 导入 JSON'),
            h('button', { type: 'button', className: 'btn btn-pri', onClick: onAdd }, '+ 添加服务器')
          )
        ),

        h('label', { className: 'caption', style: { display: 'block', marginBottom: 12 } },
          h('input', { type: 'checkbox', checked: !!settings?.trustSystemCertificates, onChange: e => onTrustSystem(e.target.checked) }),
          ' 使用系统证书（影响当前 DSH 进程；更改后需重启）'
        ),

        /* Toolbar */
        servers.length > 0 && h('div', { className: 'toolbar' },
          h('input', {
            className: 'search', type: 'text',
            placeholder: '搜索服务器名称或端点...',
            value: search, onChange: e => setSearch(e.target.value),
          })
        ),

        /* Stats */
        servers.length > 0 && h('div', { className: 'stats', style: { marginBottom: 12 } },
          connected > 0 && h('span', null, h('span', { className: 'dot dot-ok' }), connected + ' 个已连接'),
          failed > 0 && h('span', null, h('span', { className: 'dot dot-err' }), failed + ' 个连接失败'),
          disabled > 0 && h('span', null, h('span', { className: 'dot dot-idle' }), disabled + ' 个已停用')
        ),

        /* List */
        filtered.length > 0
          ? h('div', { className: 'list' }, filtered.map(s =>
              h(ServerRow, { key: s.entryId, server: s, busy, onOpen: () => onOpen(s), onToggle: () => onToggle(s) })
            ))
          : servers.length === 0
            ? h('div', { className: 'empty' },
                h('div', { style: { fontSize: 32 } }, '🔌'),
                h('h3', null, '还没有 MCP 服务器'),
                h('p', { className: 'muted' }, '添加一个 MCP 服务器，连接后它的工具会出现在所有会话里'),
                h('div', { style: { marginTop: 12, display: 'flex', gap: 8, justifyContent: 'center' } },
                  h('button', { type: 'button', className: 'btn', onClick: onImport }, '↓ 导入 JSON'),
                  h('button', { type: 'button', className: 'btn btn-pri', onClick: onAdd }, '+ 添加服务器')
                )
              )
            : h('p', { className: 'muted', style: { textAlign: 'center', padding: 24 } }, '没有匹配的服务器')
      );
    }

    /* ── Server Row ── */
    function ServerRow({ server: s, onOpen, onToggle, busy }) {
      const st = serverStatus(s);
      const auth = authLabel(s);
      return h('div', { className: 'row' },
        h('span', { className: 'dot ' + st.dot }),
        h('div', { className: 'row-body', onClick: onOpen, role: 'button', tabIndex: 0 },
          h('div', { className: 'row-title' }, s.serverName),
          h('div', { className: 'row-sub' }, endpointOf(s)),
          h('div', { className: 'row-badges' },
            h('span', { className: 'badge badge-idle' }, transportLabel(s)),
            h('span', { className: 'badge ' + auth.css }, auth.label),
            h('span', { className: 'badge ' + st.badge }, st.label)
          ),
          s.fiberPhase === 'failed' && s.enabled &&
            h('div', { className: 'row-error' }, '⚠ 连接失败，点击查看详情')
        ),
        h(Switch, { checked: s.enabled, onChange: onToggle, disabled: !!busy || s.readOnly, label: s.readOnly ? '只读服务器：' + s.serverName : (s.enabled ? '停用 ' : '启用 ') + s.serverName })
      );
    }

    /* ═══════════════════════════════════════════════════════
       DETAIL VIEW
       ═══════════════════════════════════════════════════════ */
    function DetailView({ server: s, onBack, onEdit, onRemove, onRefresh, busy }) {
      const [confirmDel, setConfirmDel] = useState(false);
      const st = serverStatus(s);
      const auth = authLabel(s);

      return h(React.Fragment, null,
        h('button', { type: 'button', className: 'back', onClick: onBack }, '← 返回列表'),

        /* Title bar */
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 } },
          h('span', { className: 'dot ' + st.dot, style: { width: 10, height: 10 } }),
          h('h2', { style: { margin: 0, fontSize: 18, flex: 1 } }, s.serverName),
          !s.readOnly && h('button', { type: 'button', className: 'btn btn-sm', onClick: onEdit }, '编辑'),
          !s.readOnly && !confirmDel && h('button', { type: 'button', className: 'btn btn-sm btn-err', onClick: () => setConfirmDel(true) }, '删除'),
          !s.readOnly && confirmDel && h('div', { className: 'confirm-bar' },
            h('span', null, '确认删除？'),
            h('button', { type: 'button', className: 'btn btn-sm btn-err', onClick: onRemove, disabled: busy }, busy ? '删除中…' : '确认'),
            h('button', { type: 'button', className: 'btn btn-sm', onClick: () => setConfirmDel(false), disabled: busy }, '取消')
          )
        ),

        /* Connection info */
        h('div', { className: 'card' },
          h('h3', null, '连接信息'),
          h('dl', { className: 'kv' },
            h('dt', null, '传输方式'), h('dd', null, s.transport),
            s.url && h(React.Fragment, null, h('dt', null, 'URL'), h('dd', { className: 'mono' }, s.url)),
            s.command && h(React.Fragment, null, h('dt', null, '命令'), h('dd', { className: 'mono' }, s.command + ' ' + (s.args || ''))),
            h('dt', null, '认证'), h('dd', null, h('span', { className: 'badge ' + auth.css }, auth.label)),
            h('dt', null, '状态'), h('dd', null, h('span', { className: 'badge ' + st.badge }, st.label)),
            h('dt', null, '超时'), h('dd', null, s.toolCallTimeoutMs + ' ms'),
            h('dt', null, '启动失败'), h('dd', null, s.failOnStartupError ? '阻断启动' : '不阻断'),
          )
        ),

        /* OAuth: also for read-only entries, whose grant lives outside the patch file */
        s.transport !== 'stdio' && s.url && s.oauth?.required && h('div', { className: 'card' },
          h(OAuthPanel, { url: s.url, oauth: s.oauth, onChange: onRefresh })
        ),

        /* Read-only notice */
        s.readOnly && h('div', { className: 'card', style: { borderLeftColor: 'var(--dsw-alias-state-warn-primary)', borderLeftWidth: 3 } },
          h('p', { style: { fontSize: 13 } }, '🔒 此服务器由 ', h('strong', null, s.readOnlyReason || '系统'), ' 管理，不可编辑')
        )
      );
    }

    /* ═══════════════════════════════════════════════════════
       FORM VIEW (Add / Edit)
       ═══════════════════════════════════════════════════════ */
    function FormView({ server, onBack, onSaved, onRefresh }) {
      const isEdit = !!server;
      const [name, setName] = useState(server?.serverName || '');
      const [transport, setTransport] = useState(server?.transport === 'stdio' ? 'stdio' : 'http');
      const [url, setUrl] = useState(server?.url || '');
      const [command, setCommand] = useState(server?.command || '');
      const [args, setArgs] = useState(Array.isArray(server?.args) ? JSON.stringify(server.args) : server?.args || '');
      const [authMode, setAuthMode] = useState(server?.authMode ?? 'none');
      const [headerRows, setHeaderRows] = useState(() => {
        const rows = (server?.headerNames || []).map(key => ({ key, value: '', configured: true }));
        return rows.length > 0 ? rows : [{ key: 'Authorization', value: '' }];
      });
      function updateHeaderRow(index, next) {
        setHeaderRows(rows => rows.map((row, j) => (j === index ? next : row)));
      }
      const [timeout, setTimeout_] = useState(String(server?.toolCallTimeoutMs ?? 60000));
      const [failOnStart, setFailOnStart] = useState(server?.failOnStartupError ?? false);
      const [reconnect, setReconnect] = useState(server?.reconnect?.enabled ?? true);
      const [maxRetries, setMaxRetries] = useState(String(server?.reconnect?.maxAttempts ?? 10));
      const [saving, setSaving] = useState(false);
      const [error, setError] = useState('');

      function handleSave() {
        setError('');
        if (!/^[A-Za-z0-9_-]{1,32}$/.test(name.trim())) { setError('服务器名称需为 1–32 个英文字母、数字、下划线或连字符'); return; }
        if (transport === 'http' && !url.trim()) { setError('请填写 URL'); return; }
        if (transport === 'stdio' && !command.trim()) { setError('请填写命令'); return; }

        const spec = { serverName: name.trim(), authMode };
        if (transport === 'http') {
          spec.url = url.trim();
        } else {
          spec.command = command.trim();
          if (args.trim()) spec.args = args.trim();
        }
        if (authMode === 'token') {
          const headers = {};
          const keepHeaderNames = [];
          for (const row of headerRows) {
            const key = row.key.trim();
            const value = row.value.trim();
            if (!key && !value) continue;
            if (!HEADER_NAME.test(key)) { setError('Header 名称不合法：' + (key || '(空)')); return; }
            if (!value && row.configured) { keepHeaderNames.push(key); continue; }
            if (!value) { setError('请填写 ' + key + ' 的值'); return; }
            headers[key] = value;
          }
          spec.headers = headers;
          spec.keepHeaderNames = keepHeaderNames;
        }
        spec.toolCallTimeoutMs = parseInt(timeout, 10) || 60000;
        spec.failOnStartupError = failOnStart;
        spec.reconnect = { enabled: reconnect, maxAttempts: parseInt(maxRetries, 10) || 10 };

        setSaving(true);
        rpc('save', spec)
          .then(data => {
            if (data.applied === false) window.alert('已保存，需重启 DSH 后生效。');
            else if (data.warnings?.length) window.alert('已保存。\n' + data.warnings.join('\n'));
            onSaved();
          })
          .catch(e => { setError(e.message); setSaving(false); });
      }

      return h(React.Fragment, null,
        h('button', { type: 'button', className: 'back', onClick: onBack }, '← 返回列表'),
        h('h2', { style: { fontSize: 18, marginBottom: 20 } }, isEdit ? '编辑服务器' : '添加服务器'),

        /* Name */
        h('div', { className: 'field' },
          h('label', { className: 'flabel' }, '服务器名称'),
          h('input', { type: 'text', value: name, maxLength: 32, onChange: e => setName(e.target.value), placeholder: 'my-mcp-server', disabled: isEdit }),
          isEdit && h('div', { className: 'fhint' }, '名称创建后不可修改')
        ),

        /* Transport */
        h('div', { className: 'field' },
          h('label', { className: 'flabel' }, '传输方式'),
          h(Seg, { value: transport, onChange: setTransport, options: [['http', 'HTTP'], ['stdio', 'stdio']] })
        ),

        /* HTTP fields */
        transport === 'http' && h('div', { className: 'field' },
          h('label', { className: 'flabel' }, 'URL'),
          h('input', { type: 'text', value: url, onChange: e => setUrl(e.target.value), placeholder: 'https://example.com/mcp' })
        ),

        /* stdio fields */
        transport === 'stdio' && h(React.Fragment, null,
          h('div', { className: 'field' },
            h('label', { className: 'flabel' }, '命令'),
            h('input', { type: 'text', value: command, onChange: e => setCommand(e.target.value), placeholder: 'npx' })
          ),
          h('div', { className: 'field' },
            h('label', { className: 'flabel' }, '参数'),
            h('input', { type: 'text', value: args, onChange: e => setArgs(e.target.value), placeholder: '-y @some/mcp-server' }),
            h('div', { className: 'fhint' }, '推荐填写 JSON 数组以保留空格与 Windows 路径，例如 ["script.mjs", "--name", "hello world"]')
          )
        ),

        /* Auth */
        h('div', { className: 'field' },
          h('label', { className: 'flabel' }, '认证方式'),
          h(Seg, { value: authMode, onChange: setAuthMode, options: [['none', '无认证'], ['token', 'Token'], ['oauth', 'OAuth']] })
        ),

        authMode === 'token' && h('div', { className: 'field' },
          h('label', { className: 'flabel' }, '请求 Header'),
          headerRows.map((row, i) => h('div', { className: 'kvedit', key: i },
            h('input', {
              type: 'text', value: row.key, placeholder: 'Header 名称', 'aria-label': 'Header 名称',
              onChange: e => updateHeaderRow(i, { ...splitHeaderPair(e.target.value, row.value), configured: false }),
            }),
            h('input', {
              type: 'password', autoComplete: 'new-password', value: row.value, placeholder: row.configured ? '已配置，留空保留' : '值', 'aria-label': (row.key || 'Header') + ' 的值',
              onChange: e => updateHeaderRow(i, { ...row, value: e.target.value }),
            }),
            h('button', {
              type: 'button', className: 'btn btn-ghost btn-sm', 'aria-label': '删除这一行',
              onClick: () => setHeaderRows(rows => rows.filter((_, j) => j !== i)),
            }, '×')
          )),
          h('button', {
            type: 'button', className: 'btn btn-sm',
            onClick: () => setHeaderRows(rows => [...rows, { key: '', value: '' }]),
          }, '+ 添加 Header'),
          h('div', { className: 'fhint' }, '例如 Authorization: Bearer example-token，或 X-API-Key: example-token。已配置的秘密不会回显；留空保留，删除行则移除该 Header。')
        ),

        authMode === 'oauth' && h('div', { className: 'field' },
          transport === 'http'
            ? h(OAuthPanel, { key: url.trim(), url: url.trim(), oauth: server?.url === url.trim() ? server.oauth : null, onChange: onRefresh })
            : h('div', { className: 'fhint' }, 'OAuth 只适用于 HTTP 传输')
        ),

        /* Advanced */
        h('details', { className: 'adv' },
          h('summary', null, '高级选项'),
          h('div', { className: 'two' },
            h('div', { className: 'field' },
              h('label', { className: 'flabel' }, '超时时间 (ms)'),
              h('input', { type: 'number', value: timeout, onChange: e => setTimeout_(e.target.value) })
            ),
            h('div', { className: 'field' },
              h('label', { className: 'flabel' }, '最大重试次数'),
              h('input', { type: 'number', value: maxRetries, onChange: e => setMaxRetries(e.target.value) })
            )
          ),
          h('div', { className: 'field' },
            h('div', { className: 'switch-line' },
              h(Switch, { checked: failOnStart, onChange: setFailOnStart }),
              h('span', null, '启动失败时阻断应用')
            ),
            h('div', { className: 'fhint' }, '关闭后，MCP 服务器连接失败不影响 DSH 启动')
          ),
          h('div', { className: 'field' },
            h('div', { className: 'switch-line' },
              h(Switch, { checked: reconnect, onChange: setReconnect }),
              h('span', null, '自动重连')
            )
          )
        ),

        /* Error */
        error && h('div', { className: 'result result-err', style: { marginTop: 8 } }, error),

        /* Footer */
        h('div', { className: 'form-foot' },
          h('button', { type: 'button', className: 'btn', onClick: onBack }, '取消'),
          h('button', { type: 'button', className: 'btn btn-pri', onClick: handleSave, disabled: saving }, saving ? '保存中...' : '保存')
        )
      );
    }

    /* ═══════════════════════════════════════════════════════
       IMPORT DIALOG
       ═══════════════════════════════════════════════════════ */
    function ImportDialog({ onClose, onDone }) {
      const [text, setText] = useState('');
      const [busy, setBusy] = useState(false);
      const [result, setResult] = useState(null);

      /* Live preview: try to parse as user types */
      const preview = useMemo(() => {
        if (!text.trim()) return null;
        try {
          const parsed = JSON.parse(text.trim());
          const servers = parsed.mcpServers || parsed;
          if (typeof servers !== 'object' || Array.isArray(servers)) return null;
          return Object.entries(servers).map(([name, spec]) => ({
            name,
            type: spec.url ? 'HTTP' : spec.command ? 'stdio' : '?',
            endpoint: spec.url || (spec.command + ' ' + (spec.args || [])).trim(),
            auth: spec.headers ? 'Token' : '无认证',
          }));
        } catch { return null; }
      }, [text]);

      function handleImport() {
        if (!text.trim()) return;
        let parsed;
        try { parsed = JSON.parse(text.trim()); }
        catch (e) { setResult({ ok: false, msg: 'JSON 解析失败: ' + e.message }); return; }

        setBusy(true);
        setResult(null);
        rpc('import', parsed)
          .then(data => {
            const parts = [];
            if (data.added.length) parts.push('新增 ' + data.added.length + ' 个');
            if (data.updated.length) parts.push('更新 ' + data.updated.length + ' 个');
            const pending = data.applied === false ? '已保存，需重启 DSH 后生效。' : '';
            setResult({ ok: true, msg: parts.join('，') + '。共 ' + data.total + ' 个服务器。' + pending });
            setTimeout(() => onDone(), 1000);
          })
          .catch(e => setResult({ ok: false, msg: e.message }))
          .finally(() => setBusy(false));
      }

      return h('div', { className: 'overlay', onClick: e => { if (e.target === e.currentTarget) onClose(); } },
        h('div', { className: 'dlg' },
          h('div', { className: 'dlg-head' },
            h('h3', null, '导入 MCP 服务器'),
            h('button', { type: 'button', className: 'btn btn-ghost btn-sm', onClick: onClose }, '✕')
          ),
          h('div', { className: 'dlg-body' },
            h('textarea', {
              value: text,
              onChange: e => { setText(e.target.value); setResult(null); },
              placeholder: '{\n  "mcpServers": {\n    "my-server": {\n      "url": "https://example.com/mcp"\n    }\n  }\n}',
              spellCheck: false,
            }),

            /* Hints */
            h('div', { className: 'caption', style: { marginTop: 8 } },
              '支持: HTTP · stdio · 含 Authorization headers'
            ),

            /* Preview */
            preview && preview.length > 0 && h('div', { className: 'preview' },
              preview.map(p =>
                h('div', { key: p.name, className: 'preview-item' },
                  h('span', { style: { fontWeight: 600, minWidth: 120 } }, p.name),
                  h('span', { className: 'badge badge-idle' }, p.type),
                  h('span', { className: 'badge ' + (p.auth === 'Token' ? 'badge-warn' : 'badge-idle') }, p.auth),
                  h('span', { className: 'mono muted', style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, p.endpoint)
                )
              )
            ),

            /* Result */
            result && h('div', { className: 'result ' + (result.ok ? 'result-ok' : 'result-err') }, result.msg)
          ),
          h('div', { className: 'dlg-foot' },
            h('button', { type: 'button', className: 'btn', onClick: onClose }, '取消'),
            h('button', {
              type: 'button', className: 'btn btn-pri',
              onClick: handleImport,
              disabled: busy || !preview || preview.length === 0,
            }, busy ? '导入中...' : preview ? '导入 (' + preview.length + ')' : '导入')
          )
        )
      );
    }

    /* ═══════════════════════════════════════════════════════
       STYLES & SLOT REGISTRATION
       ═══════════════════════════════════════════════════════ */
    const STYLE_ID = '@shirayner/dsh-mcp-management/styles';
    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.effect(() => {
          const tag = document.createElement('style');
          tag.setAttribute('data-plugin-css', STYLE_ID);
          tag.textContent = CSS;
          document.head.appendChild(tag);
          return () => tag.remove();
        });
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register({
            name: 'settings.section',
            id: 'mcp-servers',
            order: 25,
            label: 'MCP 服务器',
          }, McpManager)
        );
      },
    };
  },
});
