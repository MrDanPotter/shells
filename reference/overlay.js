/* shells overlay — an embeddable, self-contained front end for the shells message
 * queue. Drop this one line into any local web app you're building:
 *
 *     <script src="http://127.0.0.1:4420/overlay.js"></script>
 *
 * UX: it starts CLOSED as a single shell button at the bottom-right. Clicking it
 * opens a speed-dial — a stack of option bubbles animates upward (Chat, Decisions,
 * Tasks, Knowledge, Notifications), one per section of the reference UI. Clicking a
 * bubble opens that section as a centered modal. Everything is driven by the SAME
 * JSON API the full-page reference UI uses, so it already has your project's context.
 *
 * Isolation: everything lives inside a shadow root, so the host page's CSS and this
 * widget's CSS cannot reach into each other. Zero dependencies, no build step.
 *
 * Binding: the backing server is inferred from where THIS script was served from
 * (document.currentScript.src), so the overlay is automatically wired to the shells
 * project it came from. Cross-origin calls work because reference/server.js reflects
 * loopback origins (see its CORS note); to embed from a non-loopback origin, set
 * SHELLS_CORS_ORIGINS on the server.
 *
 * Same protocol.md "bruises" as the full UI: all dynamic text reaches the DOM via
 * textContent (never innerHTML), a message list is held — not redrawn — while a
 * reply box is focused or dirty, and status is reported honestly.
 */
(() => {
  "use strict";
  if (window.__shellsOverlayLoaded) return;   // idempotent: two script tags, one widget
  window.__shellsOverlayLoaded = true;

  // currentScript is only valid during this synchronous execution — capture now.
  const thisScript = document.currentScript;
  const BASE = thisScript ? new URL(thisScript.src).origin : location.origin;

  const KINDS = ['decision', 'task', 'knowledge', 'notification'];
  // The speed-dial options, ordered nearest-the-FAB first (chat), outward to the top.
  const OPTIONS = ['chat', 'issues', 'decision', 'task', 'knowledge', 'notification', 'inspect'];
  const LABEL = { chat: 'Chat', issues: 'Issues', decision: 'Decisions', task: 'Tasks', knowledge: 'Knowledge', notification: 'Notifications', inspect: 'Inspect' };
  const PLURAL = { decision: 'decisions', task: 'tasks', knowledge: 'knowledge messages', notification: 'notifications' };
  const ICON = { chat: '💬', issues: '🧩', decision: '🔀', task: '✅', knowledge: '📖', notification: '🔔', inspect: '🎯' };

  // ---- styles (scoped to the shadow root) ----------------------------------
  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .menu, .backdrop {
      font: 14px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    }

    /* ---- speed-dial (closed = just the FAB) ---- */
    .menu { position: fixed; right: 20px; bottom: 20px; z-index: 2147483000; display: flex; flex-direction: column; align-items: flex-end; }
    .options { display: flex; flex-direction: column-reverse; align-items: flex-end; gap: 10px; margin-bottom: 12px; }
    .opt {
      display: inline-flex; align-items: center; gap: 8px; height: 40px; padding: 0 14px; border-radius: 999px;
      border: 1px solid #e6e8ec; background: #fff; color: #1b1f24; cursor: pointer; white-space: nowrap;
      font: inherit; font-weight: 600; font-size: 13.5px; box-shadow: 0 3px 12px rgba(16,24,40,.18);
      opacity: 0; transform: translateY(14px) scale(.9); pointer-events: none;
      transition: opacity .17s ease, transform .17s ease;
    }
    .opt .ic { font-size: 16px; line-height: 1; }
    .opt .cnt {
      min-width: 20px; text-align: center; padding: 0 6px; border-radius: 999px;
      background: #f0f2f5; color: #667085; border: 1px solid #e6e8ec; font-size: 11.5px; font-weight: 700;
    }
    .opt .cnt.hot { background: #c53030; color: #fff; border-color: #c53030; }
    .opt:hover { border-color: #3b6ef5; }
    .menu.open .opt { opacity: 1; transform: none; pointer-events: auto; }
    .menu.open .opt:nth-child(1) { transition-delay: .00s; }
    .menu.open .opt:nth-child(2) { transition-delay: .04s; }
    .menu.open .opt:nth-child(3) { transition-delay: .08s; }
    .menu.open .opt:nth-child(4) { transition-delay: .12s; }
    .menu.open .opt:nth-child(5) { transition-delay: .16s; }
    .menu.open .opt:nth-child(6) { transition-delay: .20s; }
    .menu.open .opt:nth-child(7) { transition-delay: .24s; }

    /* ---- issues ---- */
    .iss-row { padding: 12px 16px; border-bottom: 1px solid #e6e8ec; border-left: 3px solid #b5651d; cursor: pointer; }
    .iss-row:hover { background: #f6f7f9; }
    .iss-row.closed { opacity: .55; border-left-color: #667085; }
    .iss-row .t { font-weight: 600; }
    .iss-row .m { font-size: 12px; color: #667085; margin-top: 3px; }
    .iss-back { border: 0; background: none; color: #3b6ef5; font: inherit; font-size: 12.5px; font-weight: 600; cursor: pointer; padding: 8px 14px; }
    .iss-head { padding: 4px 16px 12px; border-bottom: 1px solid #e6e8ec; }
    .iss-head .t { font-weight: 700; font-size: 15px; }
    .iss-head .row { display: flex; align-items: center; gap: 8px; margin-top: 8px; }
    .iss-pill { font-size: 11.5px; font-weight: 700; padding: 2px 9px; border-radius: 999px; text-transform: uppercase; letter-spacing: .04em; }
    .iss-pill.open { background: #fde8d5; color: #b5651d; } .iss-pill.closed { background: #e6e8ec; color: #667085; }
    .iss-head .desc { white-space: pre-wrap; word-break: break-word; margin-top: 9px; font-size: 13px; color: #1b1f24; }
    .iss-head button.act { margin-left: auto; font: inherit; font-size: 12.5px; padding: 4px 11px; border-radius: 8px; border: 1px solid #e6e8ec; background: #f6f7f9; color: #1b1f24; cursor: pointer; }
    .mkissue { display: flex; align-items: center; gap: 6px; padding: 0 14px 10px; font-size: 12.5px; color: #667085; user-select: none; cursor: pointer; }
    .mkissue input { margin: 0; }

    /* ---- inspect (click-to-discuss) ---- */
    .ins-hl { position: fixed; z-index: 2147483002; pointer-events: none; display: none; box-sizing: border-box;
      border: 2px solid #3b6ef5; background: rgba(59,110,245,.14); border-radius: 3px; }
    .ins-hl .tag { position: absolute; top: -19px; left: -2px; font: 700 11px/1.5 ui-monospace, Menlo, Consolas, monospace;
      background: #3b6ef5; color: #fff; padding: 1px 6px; border-radius: 4px; white-space: nowrap; max-width: 60vw; overflow: hidden; text-overflow: ellipsis; }
    .ins-hint { position: fixed; z-index: 2147483003; left: 50%; top: 14px; transform: translateX(-50%); display: none; pointer-events: none;
      background: #16202b; color: #fff; padding: 7px 14px; border-radius: 999px; font: 13px system-ui; box-shadow: 0 6px 20px rgba(16,24,40,.35); }
    .ins-pop { position: fixed; z-index: 2147483004; width: 300px; max-width: calc(100vw - 24px); background: #fff; color: #16202b;
      border: 1px solid #e6e8ec; border-radius: 12px; box-shadow: 0 14px 44px rgba(16,24,40,.32); padding: 12px; font: 13px system-ui; }
    .ins-pop .sel { font: 600 12px/1.4 ui-monospace, Menlo, Consolas, monospace; color: #3b6ef5; word-break: break-all; margin-bottom: 8px; }
    .ins-pop textarea { width: 100%; box-sizing: border-box; font: inherit; padding: 8px 10px; border: 1px solid #e6e8ec; border-radius: 9px;
      background: #f6f7f9; color: #16202b; resize: vertical; min-height: 40px; }
    .ins-pop .row { display: flex; gap: 8px; margin-top: 10px; }
    .ins-pop button { font: inherit; font-weight: 600; padding: 7px 12px; border-radius: 9px; border: 1px solid #e6e8ec; background: #f6f7f9; color: #16202b; cursor: pointer; }
    .ins-pop button.go { background: #3b6ef5; color: #fff; border-color: #3b6ef5; flex: 1; }
    .ins-pop .shot { margin-bottom: 8px; min-height: 44px; display: flex; align-items: center; justify-content: center;
      background: #f0f2f5; border: 1px solid #e6e8ec; border-radius: 8px; color: #667085; font-size: 12px; overflow: hidden; }
    .ins-pop .shot img { max-width: 100%; max-height: 170px; display: block; border-radius: 7px; }
    .chat-shot { display: block; margin-top: 6px; max-width: 100%; border-radius: 8px; border: 1px solid #e6e8ec; }
    @media (prefers-color-scheme: dark) {
      .ins-pop { background: #171b21; color: #e6e9ee; border-color: #262c34; }
      .ins-pop textarea { background: #0f1216; color: #e6e9ee; border-color: #262c34; }
      .ins-pop button { background: #0f1216; color: #e6e9ee; border-color: #262c34; }
      .ins-pop .shot { background: #0f1216; border-color: #262c34; }
      .chat-shot { border-color: #262c34; }
    }

    .fab {
      position: relative; width: 56px; height: 56px; border-radius: 50%; align-self: flex-end;
      border: 0; cursor: pointer; background: #3b6ef5; color: #fff; box-shadow: 0 4px 14px rgba(16,24,40,.30);
      transition: transform .14s ease;
    }
    .fab:hover { transform: translateY(-2px); }
    .fab .fab-ic { display: flex; align-items: center; justify-content: center; height: 56px; }
    .fab .shell { width: 28px; height: 28px; }
    .fab-x { display: none; font-size: 26px; line-height: 1; }
    .menu.open .shell { display: none; }
    .menu.open .fab-x { display: block; }
    .fab-badge {
      position: absolute; top: -3px; right: -3px; min-width: 20px; height: 20px; padding: 0 5px;
      border-radius: 999px; background: #c53030; color: #fff; font-size: 12px; font-weight: 700; line-height: 20px; display: none;
    }
    .fab-badge.show { display: block; }
    .fab-dot { position: absolute; bottom: 0; left: 0; width: 13px; height: 13px; border-radius: 50%; background: #667085; border: 2px solid #fff; }
    .fab-dot.ok { background: #2f855a; } .fab-dot.warn { background: #b7791f; } .fab-dot.bad { background: #c53030; }
    /* actively working: the status dot becomes a spinning ball instead of a static green */
    .fab-dot.working { background: conic-gradient(from 0deg, #2f855a, rgba(47,133,90,.12)); animation: shwork .8s linear infinite; }
    @keyframes shwork { to { transform: rotate(360deg); } }

    /* ---- centered modal ---- */
    .backdrop {
      position: fixed; inset: 0; z-index: 2147483001; background: rgba(16,24,40,.45);
      display: none; align-items: center; justify-content: center; padding: 20px;
    }
    .backdrop.show { display: flex; }
    .modal {
      width: 540px; max-width: 100%; max-height: 82vh; display: flex; flex-direction: column; overflow: hidden;
      background: #fff; color: #1b1f24; border: 1px solid #e6e8ec; border-radius: 16px;
      box-shadow: 0 24px 64px rgba(16,24,40,.38); animation: pop .16s ease;
    }
    @keyframes pop { from { opacity: 0; transform: translateY(10px) scale(.98); } to { opacity: 1; transform: none; } }
    .mhead { display: flex; align-items: center; gap: 9px; padding: 14px 18px; border-bottom: 1px solid #e6e8ec; }
    .mhead .mic { font-size: 18px; }
    .mhead .mtitle { font-weight: 700; font-size: 15px; }
    .mhead .status { margin-left: auto; font-size: 12px; color: #667085; display: inline-flex; align-items: center; gap: 5px; }
    .mhead .sdot { width: 8px; height: 8px; border-radius: 50%; background: #667085; }
    .mhead .sdot.ok { background: #2f855a; } .mhead .sdot.warn { background: #b7791f; } .mhead .sdot.bad { background: #c53030; }
    .mhead .tochat { border: 1px solid #e6e8ec; background: #f6f7f9; color: #16202b; font: inherit; font-size: 12px; font-weight: 600; padding: 3px 10px; border-radius: 999px; cursor: pointer; }
    .mhead .tochat:hover { border-color: #3b6ef5; }
    .mhead .x { border: 0; background: none; color: #667085; font-size: 24px; line-height: 1; cursor: pointer; padding: 0 2px; }
    .mbody { overflow-y: auto; flex: 1; }
    .empty { padding: 30px 18px; text-align: center; color: #667085; font-size: 13.5px; }

    /* chat */
    .chat-log { display: flex; flex-direction: column; gap: 8px; padding: 14px 16px; }
    .bubble { max-width: 88%; padding: 8px 12px; border-radius: 12px; font-size: 13.5px; white-space: pre-wrap; word-break: break-word; }
    .bubble.you { align-self: flex-end; background: #3b6ef5; color: #fff; border-bottom-right-radius: 3px; }
    .bubble.agent { align-self: flex-start; background: #f0f2f5; color: #16202b; border-bottom-left-radius: 3px; }
    .bubble.external { align-self: flex-start; background: #e05a52; color: #fff; border-bottom-left-radius: 3px; }
    .bubble.external .src { display: block; font-size: 10px; font-weight: 700; letter-spacing: .05em; text-transform: uppercase; opacity: .85; margin-bottom: 3px; }
    .bubble .when { display: block; font-size: 10px; opacity: .75; margin-top: 2px; }
    .chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 7px; }
    .chip { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; font-weight: 600; padding: 3px 9px; border-radius: 999px;
      border: 1px solid #e6e8ec; background: #fff; color: #16202b; cursor: pointer; max-width: 100%; }
    .chip:hover { border-color: #3b6ef5; }
    .chip.done { opacity: .45; }   /* linked item already acknowledged (read/done/closed) */
    .chip .cdot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
    .chip .clabel { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .chip.k-decision .cdot { background: #b5651d; } .chip.k-task .cdot { background: #2f855a; }
    .chip.k-knowledge .cdot { background: #6b46c1; } .chip.k-notification .cdot { background: #667085; }
    @keyframes shflash { from { background: rgba(59,110,245,.20); } to { background: transparent; } }
    .msg.flash { animation: shflash 1.6s ease; }
    .bubble.typing { align-self: flex-start; display: inline-flex; align-items: center; gap: 4px; padding: 11px 13px; }
    .bubble.typing .d { width: 6px; height: 6px; border-radius: 50%; background: #667085; animation: shtype 1.2s infinite ease-in-out; }
    .bubble.typing .d:nth-child(2) { animation-delay: .18s; }
    .bubble.typing .d:nth-child(3) { animation-delay: .36s; }
    @keyframes shtype { 0%, 60%, 100% { transform: translateY(0); opacity: .4; } 30% { transform: translateY(-4px); opacity: .9; } }
    .composer { display: flex; gap: 8px; padding: 12px 14px; border-top: 1px solid #e6e8ec; align-items: flex-end; }
    .composer textarea {
      font: inherit; flex: 1; padding: 9px 11px; border-radius: 10px; border: 1px solid #e6e8ec;
      background: #f6f7f9; color: #1b1f24; resize: vertical; min-height: 40px; max-height: 34vh; line-height: 1.4;
    }
    .composer button { font: inherit; font-weight: 600; padding: 9px 15px; border-radius: 10px; border: 0; background: #3b6ef5; color: #fff; cursor: pointer; }

    /* messages */
    .msg { padding: 14px 16px; border-bottom: 1px solid #e6e8ec; border-left: 3px solid #e6e8ec; }
    .msg:last-child { border-bottom: 0; }
    .msg.k-decision { border-left-color: #b5651d; }
    .msg.k-task { border-left-color: #2f855a; }
    .msg.k-knowledge { border-left-color: #6b46c1; }
    .msg.k-notification { border-left-color: #667085; }
    .msg .title { font-weight: 600; }
    .msg .body { white-space: pre-wrap; word-break: break-word; margin: 5px 0 0; font-size: 13.5px; }
    .msg .meta { font-size: 12.5px; color: #667085; margin-top: 6px; }
    .msg .meta b { color: #1b1f24; }
    .msg .reply { margin-top: 6px; padding: 7px 10px; background: #f6f7f9; border-radius: 8px; font-size: 13px; }
    .acts { display: flex; gap: 7px; flex-wrap: wrap; margin-top: 10px; align-items: center; }
    .acts button { font: inherit; font-size: 13px; padding: 5px 11px; border-radius: 8px; border: 1px solid #e6e8ec; background: #f6f7f9; color: #1b1f24; cursor: pointer; }
    .acts button.primary { background: #3b6ef5; color: #fff; border-color: #3b6ef5; }
    .acts input.revise { font: inherit; font-size: 13px; padding: 5px 9px; border-radius: 8px; flex: 1; min-width: 130px; border: 1px solid #e6e8ec; background: #fff; color: #1b1f24; }
    .acts .waiting { font-size: 12.5px; color: #667085; }

    @media (prefers-color-scheme: dark) {
      .opt, .modal { background: #171b21; color: #e6e9ee; border-color: #262c34; }
      .opt .cnt { background: #0f1216; color: #9aa4b2; border-color: #262c34; }
      .mhead, .composer, .msg, .msg:last-child { border-color: #262c34; }
      .mhead .status, .empty, .msg .meta, .acts .waiting { color: #9aa4b2; }
      .composer textarea, .acts input.revise { background: #0f1216; color: #e6e9ee; border-color: #262c34; }
      .msg .reply { background: #0f1216; }
      .acts button { background: #0f1216; color: #e6e9ee; border-color: #262c34; }
      .bubble.agent { background: #0f1216; color: #e6e9ee; }
      .bubble.external { background: #b5433f; }
      .chip { background: #0f1216; color: #e6e9ee; border-color: #262c34; }
      .mhead .tochat { background: #0f1216; color: #e6e9ee; border-color: #262c34; }
      .iss-row, .iss-head { border-color: #262c34; } .iss-row:hover { background: #0f1216; }
      .iss-row .m, .iss-head .desc, .mkissue { color: #9aa4b2; }
      .iss-head .desc { color: #e6e9ee; }
      .iss-pill.open { background: #3a2a17; color: #e0a267; } .iss-pill.closed { background: #0f1216; color: #9aa4b2; }
      .iss-head button.act { background: #0f1216; color: #e6e9ee; border-color: #262c34; }
    }
  `;

  // ---- static skeleton (no dynamic data ever passes through this innerHTML) --
  const TEMPLATE = `
    <div class="menu">
      <div class="options"></div>
      <button class="fab" title="shells" aria-label="Open shells menu">
        <span class="fab-ic"><svg class="shell" viewBox="0 0 24 24" aria-hidden="true"><path fill="#fff" d="M12 20.5 L3.5 11.5 Q5.2 6.5 6.9 10.5 Q8.6 6.5 10.3 10.5 Q12 6.5 13.7 10.5 Q15.4 6.5 17.1 10.5 Q18.8 6.5 20.5 11.5 Z"/><path fill="none" stroke="#3b6ef5" stroke-width="1.1" stroke-linecap="round" d="M12 20.5 L12 7.8 M12 20.5 L8.6 9.2 M12 20.5 L15.4 9.2 M12 20.5 L5.8 10.8 M12 20.5 L18.2 10.8"/></svg><span class="fab-x">×</span></span><span class="fab-badge">0</span><span class="fab-dot"></span>
      </button>
    </div>
    <div class="backdrop" role="dialog" aria-modal="true" aria-label="shells">
      <div class="modal">
        <div class="mhead">
          <span class="mic"></span><span class="mtitle"></span>
          <button class="tochat" title="Back to chat">‹ Chat</button>
          <span class="status"><span class="sdot"></span><span class="stxt"></span></span>
          <button class="x" title="Close" aria-label="Close">×</button>
        </div>
        <div class="mbody"></div>
      </div>
    </div>
    <div class="ins-hl" aria-hidden="true"><span class="tag"></span></div>
    <div class="ins-hint">Click any element to discuss it · Esc to cancel</div>`;

  // ---- mount ----------------------------------------------------------------
  const host = document.createElement('div');
  host.id = 'shells-overlay-host';
  const root = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style'); style.textContent = CSS;
  const wrap = document.createElement('div'); wrap.innerHTML = TEMPLATE;
  root.append(style, wrap);
  document.documentElement.appendChild(host);

  const $ = sel => root.querySelector(sel);
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };

  const menu = $('.menu'), optionsBox = $('.options'), fab = $('.fab');
  const fabIc = $('.fab-ic'), fabBadge = $('.fab-badge'), fabDot = $('.fab-dot');
  const backdrop = $('.backdrop'), mbody = $('.mbody');
  const insHl = $('.ins-hl'), insHint = $('.ins-hint');

  // ---- state ----------------------------------------------------------------
  let menuOpen = false, currentModal = null;   // currentModal: null | 'chat' | a kind
  let messages = [], chatLog = [];
  let lastSig = '', lastChatSig = '', highlightId = null;
  let activityState = '';   // reported_state from /api/activity — drives the working spinner + typing dots
  let pendingScrollBottom = false;   // force the chat to the bottom once, after it opens and becomes visible
  let currentIssue = null, issuesList = [], lastIssuesSig = '';   // issues: list + the one being viewed
  let issueChat = [], lastIssueChatSig = '';
  let holdUntil = 0; const HOLD_MS = 1200;
  const bumpHold = () => { holdUntil = Date.now() + HOLD_MS; };
  const openOf = kind => messages.filter(m => m.kind === kind && m.status !== 'closed');

  // ---- speed-dial options ---------------------------------------------------
  const optCnt = {};
  OPTIONS.forEach(key => {
    const b = el('button', 'opt k-' + key); b.dataset.key = key;
    b.appendChild(el('span', 'ic', ICON[key]));
    b.appendChild(el('span', null, LABEL[key]));
    if (KINDS.includes(key)) { const c = el('span', 'cnt', '0'); optCnt[key] = c; b.appendChild(c); }
    b.addEventListener('click', () => { if (key === 'inspect') startInspect(); else openModal(key); });
    optionsBox.appendChild(b);
  });

  function setMenu(open) {
    menuOpen = open;
    menu.classList.toggle('open', open);
    fab.setAttribute('aria-label', open ? 'Close shells menu' : 'Open shells menu');
  }

  // ---- inspect: click any element, screenshot it + its DOM, send to chat --------
  // Hover highlights the element (DevTools-style); a click freezes it and opens a
  // popover with a preview + note; "Discuss this" POSTs the DOM serialization AND a
  // cropped screenshot to /api/context. The screenshot is grabbed from the REAL
  // rendered pixels of the shared tab (getDisplayMedia), so it matches the page
  // exactly — no re-render approximation (which is what missed emoji and nested
  // backgrounds when this used html2canvas).
  let inspecting = false, insPop = null, insTarget = null, displayStream = null;

  // Request a screen-share of the current tab, once per session, kept alive for reuse.
  // MUST be called from a user gesture — the Inspect menu click and the element click
  // both qualify. Rejects if the user dismisses the picker.
  async function ensureStream() {
    const t = displayStream && displayStream.getVideoTracks()[0];
    if (t && t.readyState === 'live') return displayStream;
    displayStream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 30 }, audio: false, preferCurrentTab: true
    });
    const track = displayStream.getVideoTracks()[0];
    if (track) track.addEventListener('ended', () => { displayStream = null; });   // re-prompt next time
    return displayStream;
  }

  // Capture the element + ~24px of surroundings from the shared tab's real pixels.
  // Our overlay is hidden during the grab so it isn't in the shot. PNG data URL or null.
  async function captureRegion(target) {
    let hidden = false, video = null;
    try {
      const stream = await ensureStream();
      video = document.createElement('video');
      video.srcObject = stream; video.muted = true;
      await video.play().catch(() => {});
      if (!video.videoWidth) await new Promise(res => { video.onloadedmetadata = res; setTimeout(res, 600); });
      host.style.visibility = 'hidden'; hidden = true;            // keep our own UI out of the frame
      await new Promise(res => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(res, 60))));
      const vw = video.videoWidth, vh = video.videoHeight;
      if (!vw || !vh) return null;
      const scaleX = vw / window.innerWidth, scaleY = vh / window.innerHeight;   // captured px per CSS px
      const r = target.getBoundingClientRect();                                   // viewport coords
      const PAD = 24;
      const cl = Math.max(0, (r.left - PAD) * scaleX);
      const ct = Math.max(0, (r.top - PAD) * scaleY);
      const cw = Math.min(vw - cl, (r.width + PAD * 2) * scaleX);
      const ch = Math.min(vh - ct, (r.height + PAD * 2) * scaleY);
      if (cw < 1 || ch < 1) return null;
      const out = document.createElement('canvas'); out.width = cw; out.height = ch;
      out.getContext('2d').drawImage(video, cl, ct, cw, ch, 0, 0, cw, ch);
      return out.toDataURL('image/png');
    } catch (e) { return null; }
    finally {
      if (hidden) host.style.visibility = '';
      if (video) { try { video.pause(); video.srcObject = null; } catch (e) {} }
    }
  }

  function insDescribe(t) {
    let s = t.tagName.toLowerCase();
    if (t.id) s += '#' + t.id;
    if (t.classList.length) s += '.' + [...t.classList].slice(0, 2).join('.');
    return s;
  }
  function insSelector(t) {
    if (t.id) return t.tagName.toLowerCase() + '#' + t.id;
    let sel = t.tagName.toLowerCase();
    if (t.classList.length) sel += '.' + [...t.classList].slice(0, 3).join('.');
    const p = t.parentElement;
    if (p && p !== document.body) {
      const same = [...p.children].filter(c => c.tagName === t.tagName);
      if (same.length > 1) sel += ':nth-of-type(' + ([...p.children].indexOf(t) + 1) + ')';
      sel = (p.id ? p.tagName.toLowerCase() + '#' + p.id : p.tagName.toLowerCase()) + ' > ' + sel;
    }
    return sel;
  }
  function insAttrs(t) {
    const keep = ['role', 'type', 'name', 'href', 'src', 'alt', 'title', 'placeholder', 'aria-label', 'for'];
    const out = [];
    for (const a of t.attributes) {
      if (['value', 'class', 'id', 'style'].includes(a.name)) continue;   // value redacted; class/id/style shown elsewhere
      if (a.name.startsWith('data-') || keep.includes(a.name)) out.push(a.name + '="' + a.value + '"');
    }
    return out.join(' ');
  }
  function insContext(t) {
    const r = t.getBoundingClientRect();
    const cs = getComputedStyle(t);
    const comp = ['display', 'position', 'color', 'background-color', 'font-size', 'width', 'height']
      .map(p => p + ':' + cs.getPropertyValue(p)).join('; ');
    let html = t.outerHTML.replace(/\s+/g, ' ').trim();
    if (html.length > 1500) html = html.slice(0, 1500) + ' …[truncated]';
    let text = (t.innerText || '').replace(/\s+/g, ' ').trim();
    if (text.length > 300) text = text.slice(0, 300) + ' …';
    const a = insAttrs(t);
    return [
      '[inspect] element selected for discussion',
      'page: ' + location.pathname,
      'selector: ' + insSelector(t),
      'tag: ' + t.tagName.toLowerCase()
        + (t.id ? '  id: ' + t.id : '')
        + (t.classList.length ? '  classes: ' + [...t.classList].join(' ') : ''),
      'rect: x=' + Math.round(r.left) + ' y=' + Math.round(r.top) + ' w=' + Math.round(r.width) + ' h=' + Math.round(r.height),
      a ? 'attributes: ' + a : null,
      text ? 'text: "' + text + '"' : null,
      'computed: ' + comp,
      'outerHTML: ' + html
    ].filter(Boolean).join('\n');
  }

  function insPosition(r) {
    insHl.style.display = 'block';
    insHl.style.left = r.left + 'px'; insHl.style.top = r.top + 'px';
    insHl.style.width = r.width + 'px'; insHl.style.height = r.height + 'px';
  }
  const onInsMove = e => {
    if (!inspecting || insTarget) return;                       // frozen once a target is picked
    const t = e.target;
    if (!t || t === host || host.contains(t)) { insHl.style.display = 'none'; return; }
    const r = t.getBoundingClientRect();
    if (!r.width && !r.height) { insHl.style.display = 'none'; return; }
    insPosition(r);
    insHl.querySelector('.tag').textContent = insDescribe(t);
  };
  const onInsClick = e => {
    if (!inspecting) return;
    if (e.target === host || host.contains(e.target)) return;   // clicks on our own popover pass through
    e.preventDefault(); e.stopPropagation();                    // don't let the page act on the click
    insTarget = e.target;                                       // freeze selection
    insPosition(insTarget.getBoundingClientRect());
    insHl.querySelector('.tag').textContent = insDescribe(insTarget);
    showInsPopover(e.clientX, e.clientY);
  };
  const onInsKey = e => { if (e.key === 'Escape') { e.preventDefault(); stopInspect(); } };

  function startInspect() {
    if (inspecting) return;
    setMenu(false);
    inspecting = true; insTarget = null;
    ensureStream().catch(() => {});       // prompt for tab-share now (user gesture) so capture is instant
    insHint.style.display = 'block';
    document.documentElement.style.cursor = 'crosshair';
    document.addEventListener('mousemove', onInsMove, true);
    document.addEventListener('click', onInsClick, true);
    window.addEventListener('keydown', onInsKey, true);
  }
  function stopInspect() {
    inspecting = false; insTarget = null;
    insHl.style.display = 'none'; insHint.style.display = 'none';
    document.documentElement.style.cursor = '';
    if (insPop) { insPop.remove(); insPop = null; }
    document.removeEventListener('mousemove', onInsMove, true);
    document.removeEventListener('click', onInsClick, true);
    window.removeEventListener('keydown', onInsKey, true);
  }

  function positionInsPop(x, y) {
    const pw = 300, ph = insPop.offsetHeight || 150;
    insPop.style.left = Math.max(12, Math.min(x + 12, window.innerWidth - pw - 12)) + 'px';
    insPop.style.top = Math.max(12, Math.min(y + 12, window.innerHeight - ph - 12)) + 'px';
  }
  async function showInsPopover(x, y) {
    if (insPop) insPop.remove();
    const target = insTarget;
    insPop = el('div', 'ins-pop');
    const shot = el('div', 'shot', 'capturing…');           // preview of what's being attached
    insPop.appendChild(shot);
    insPop.appendChild(el('div', 'sel', insSelector(target)));
    const mkLbl = el('label', 'mkissue');
    const mk = el('input'); mk.type = 'checkbox';
    mkLbl.append(mk, document.createTextNode('Create an issue'));
    insPop.appendChild(mkLbl);
    const ta = el('textarea'); ta.placeholder = 'What about this element? (optional)';
    insPop.appendChild(ta);
    const row = el('div', 'row');
    const go = el('button', 'go', '💬 Discuss this');
    const cancel = el('button', null, 'Cancel');
    let imageData = null;
    go.onclick = async () => {
      const note = ta.value.trim();
      const domText = insContext(target);
      const selector = insSelector(target);
      const mkIssue = mk.checked;
      go.disabled = true;
      let sent = false, issueId = null;
      // Preferred path: the context endpoint (saves the screenshot + delivers the DOM).
      try {
        const r = await api('/api/context', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: domText, note, image: imageData, selector, createIssue: mkIssue }) });
        sent = true; if (mkIssue && r && r.issue) issueId = r.issue;
      } catch (e) { /* server may not have /api/context — fall back to a plain inbox message */ }
      if (!sent) {
        try {
          const r = await api('/api/inbox', { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: (note ? note + '\n\n' : '') + domText, createIssue: mkIssue }) });
          if (mkIssue && r && r.id) issueId = r.id;
        } catch (err) { alert(err.message); go.disabled = false; return; }
      }
      stopInspect();
      if (issueId) { openModal('issues'); openIssueDetail(issueId); }
      else { lastChatSig = ''; openModal('chat'); }
    };
    cancel.onclick = () => stopInspect();
    row.append(go, cancel); insPop.appendChild(row);
    root.appendChild(insPop);
    positionInsPop(x, y);
    // capture the padded region, then swap the placeholder for the preview
    const data = await captureRegion(target);
    if (insPop && insTarget === target) {
      imageData = data;
      shot.textContent = '';
      if (data) { const img = el('img'); img.src = data; shot.appendChild(img); }
      else shot.textContent = 'screenshot unavailable — will send DOM only';
      positionInsPop(x, y);
    }
  }

  // ---- api ------------------------------------------------------------------
  async function api(path, opts) {
    const r = await fetch(BASE + path, opts);
    let j = null; try { j = await r.json(); } catch {}
    if (!r.ok) throw new Error((j && j.error) || ('HTTP ' + r.status));
    return j;
  }
  const post = path => api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
  async function respond(id, verdict, response) {
    try {
      await api('/api/messages/' + encodeURIComponent(id) + '/respond', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ verdict, response: response || '' })
      });
    } catch (e) { alert(e.message); return; }
    lastSig = ''; loadMessages(true);
  }
  async function act(path) { try { await post(path); } catch (e) { alert(e.message); } lastSig = ''; loadMessages(true); }

  // ---- modal ----------------------------------------------------------------
  function openModal(key, hid) {
    currentModal = key;
    highlightId = hid || null;
    setMenu(false);
    $('.mic').textContent = ICON[key];
    $('.mtitle').textContent = LABEL[key];
    $('.tochat').style.display = key === 'chat' ? 'none' : '';   // "back to chat" everywhere but chat
    if (key === 'chat') pendingScrollBottom = true;              // land at the newest message on open
    if (key === 'issues') { currentIssue = null; lastIssuesSig = ''; }
    lastSig = ''; lastChatSig = '';
    renderModal(true);
    backdrop.classList.add('show');
    if (key === 'chat') loadChat();
    if (key === 'issues') loadIssues();
  }
  function closeModal() { currentModal = null; highlightId = null; backdrop.classList.remove('show'); mbody.textContent = ''; }

  function applyFlash() {
    if (!highlightId) return;
    const sel = (window.CSS && CSS.escape) ? CSS.escape(highlightId) : highlightId;
    const node = mbody.querySelector('.msg[data-id="' + sel + '"]');
    if (!node) return;
    node.scrollIntoView({ block: 'center', behavior: 'smooth' });
    node.classList.remove('flash'); void node.offsetWidth; node.classList.add('flash');
    highlightId = null;
  }

  // Resolve an agent reply's link ids into click-to-open chips (kind + title),
  // resolved against the loaded messages snapshot. Clicking jumps to that item's
  // modal and flashes it. An unresolved id still renders a clickable chip.
  function chipRow(ids) {
    const row = el('div', 'chips');
    ids.forEach(id => {
      const m = messages.find(x => x.id === id);
      const chip = el('div', 'chip' + (m ? ' k-' + m.kind : '') + (m && m.status !== 'open' ? ' done' : ''));
      chip.appendChild(el('span', 'cdot'));
      const label = m ? (LABEL[m.kind].replace(/s$/, '') + ': ' + m.title) : 'open item';
      chip.appendChild(el('span', 'clabel', label));
      chip.title = label;
      chip.onclick = () => { const t = messages.find(x => x.id === id); if (t) openModal(t.kind, id); };
      row.appendChild(chip);
    });
    return row;
  }

  function editing() {
    const a = root.activeElement;
    if (a && a.classList && a.classList.contains('revise')) return true;
    return [...mbody.querySelectorAll('input.revise')].some(i => i.value.trim() !== '');
  }

  function renderModal(force) {
    if (!currentModal) return;
    if (currentModal === 'chat') return renderChat();
    if (currentModal === 'issues') return renderIssues(force);
    if (!force && (editing() || Date.now() < holdUntil)) { setTimeout(() => renderModal(false), 400); return; }
    let shown = openOf(currentModal);
    // If we're jumping to a specific item that happens to be closed (e.g. a link to
    // an already-read knowledge entry), surface just that one so the jump isn't a dead end.
    if (highlightId) {
      const t = messages.find(m => m.id === highlightId);
      if (t && t.kind === currentModal && !shown.some(m => m.id === t.id)) shown = [t, ...shown];
    }
    const sig = currentModal + '|' + JSON.stringify(shown.map(m => [m.id, m.status, m.updated_at, m.response]));
    if (sig === lastSig) { applyFlash(); return; }
    lastSig = sig;
    mbody.textContent = '';
    if (!shown.length) { mbody.appendChild(el('div', 'empty', 'No open ' + PLURAL[currentModal] + '.')); return; }
    shown.forEach(m => mbody.appendChild(msgNode(m)));
    applyFlash();
  }

  function msgNode(m) {
    const w = el('div', 'msg k-' + m.kind); w.dataset.id = m.id;
    w.appendChild(el('div', 'title', m.title));
    if (m.body) w.appendChild(el('div', 'body', m.body));
    if (m.kind === 'decision') {
      if (m.options && m.options.length) { const d = el('div', 'meta'); d.appendChild(el('b', null, 'options: ')); d.appendChild(document.createTextNode(m.options.join(' · '))); w.appendChild(d); }
      if (m.chosen) { const d = el('div', 'meta'); d.appendChild(el('b', null, 'default taken: ')); d.appendChild(document.createTextNode(m.chosen)); w.appendChild(d); }
    }
    if (m.response) { const r = el('div', 'reply'); r.appendChild(el('b', null, (m.verdict || 'reply') + ': ')); r.appendChild(document.createTextNode(m.response)); w.appendChild(r); }

    const acts = el('div', 'acts');
    if (m.kind === 'decision' && m.status === 'open') {
      const ok = el('button', 'primary', 'Approve'); ok.onclick = () => respond(m.id, 'approved');
      const inp = el('input', 'revise'); inp.placeholder = 'revise note';
      const back = el('button', null, 'Send back'); back.onclick = () => { if (!inp.value.trim()) { inp.focus(); return; } respond(m.id, 'revised', inp.value.trim()); };
      acts.append(ok, inp, back);
    } else if (m.kind === 'task' && m.status === 'open') {
      const b = el('button', 'primary', 'Mark done'); b.onclick = () => respond(m.id, 'done'); acts.appendChild(b);
    } else if ((m.kind === 'knowledge' || m.kind === 'notification') && m.status === 'open') {
      const b = el('button', null, 'Mark read'); b.onclick = () => act('/api/messages/' + encodeURIComponent(m.id) + '/read'); acts.appendChild(b);
    } else if (m.status === 'answered' || m.status === 'done') {
      acts.appendChild(el('span', 'waiting', 'waiting on the agent to apply & resolve'));
    }
    if (acts.childNodes.length) w.appendChild(acts);
    return w;
  }

  // ---- chat -----------------------------------------------------------------
  // One chat bubble element — shared by the main chat and each issue's own chat.
  function bubbleEl(r) {
    const roleCls = r.role === 'agent' ? 'agent' : r.role === 'external-agent' ? 'external' : 'you';
    const b = el('div', 'bubble ' + roleCls);
    if (r.role === 'external-agent') b.appendChild(el('span', 'src', r.source ? ('external · ' + r.source) : 'external agent'));
    b.appendChild(document.createTextNode(r.text));
    const t = new Date(r.sent_at); b.appendChild(el('span', 'when', isNaN(t) ? '' : t.toLocaleTimeString()));
    if (r.links && r.links.length) b.appendChild(chipRow(r.links));
    if (r.image) { const im = el('img'); im.className = 'chat-shot'; im.src = BASE + r.image; b.appendChild(im); }
    return b;
  }

  // A composer that POSTs {text} to `endpoint` then calls `after`. With `withIssue`,
  // it adds a "Create an issue" checkbox — ticked, the message opens an issue instead.
  function composer(endpoint, after, withIssue) {
    const wrap = el('div');
    let mk = null;
    if (withIssue) {
      const lbl = el('label', 'mkissue');
      mk = el('input'); mk.type = 'checkbox';
      lbl.append(mk, document.createTextNode('Create an issue from this message'));
      wrap.appendChild(lbl);
    }
    const comp = el('div', 'composer');
    const ta = el('textarea'); ta.placeholder = 'Message the session… (Enter sends, Shift+Enter = newline)';
    const send = el('button', null, 'Send');
    const doSend = async () => {
      const text = ta.value.trim(); if (!text) return; ta.value = '';
      const payload = { text }; if (mk && mk.checked) payload.createIssue = true;
      try { await api(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); }
      catch (e) { alert(e.message); ta.value = text; return; }
      if (mk) mk.checked = false;
      after();
    };
    ta.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend(); } });
    send.addEventListener('click', doSend);
    comp.append(ta, send); wrap.appendChild(comp);
    return wrap;
  }

  function renderChat() {
    const atBottom = mbody.scrollHeight - mbody.scrollTop - mbody.clientHeight < 60;
    mbody.textContent = '';
    const log = el('div', 'chat-log');
    if (!chatLog.length) log.appendChild(el('div', 'empty', 'No messages yet.'));
    else chatLog.forEach(r => log.appendChild(bubbleEl(r)));
    mbody.appendChild(log);
    mbody.appendChild(composer('/api/inbox', () => { lastChatSig = ''; loadChat(); }, true));
    updateTyping();
    if (pendingScrollBottom) {
      mbody.scrollTop = mbody.scrollHeight;
      if (mbody.clientHeight > 0) pendingScrollBottom = false;   // only clear once actually visible
    } else if (atBottom) {
      mbody.scrollTop = mbody.scrollHeight;
    }
  }

  // Show/hide a "typing" indicator (animated dots) at the bottom of the chat log
  // whenever the session is actively working. Toggled on chat re-render AND on each
  // status poll, so it appears/disappears live without needing a full re-render.
  function updateTyping() {
    if (currentModal !== 'chat') return;
    const log = mbody.querySelector('.chat-log');
    if (!log) return;
    const has = log.querySelector('.typing');
    const working = activityState === 'working';
    if (working && !has) {
      const t = el('div', 'bubble agent typing');
      t.append(el('span', 'd'), el('span', 'd'), el('span', 'd'));
      log.appendChild(t);
      mbody.scrollTop = mbody.scrollHeight;
    } else if (!working && has) {
      has.remove();
    }
  }

  // ---- issues ---------------------------------------------------------------
  async function loadIssues() {
    let list; try { list = await api('/api/issues?all=1'); } catch { return; }
    issuesList = list;
    if (currentModal === 'issues' && !currentIssue) renderIssues();
  }
  function renderIssues(force) {
    if (currentIssue) return renderIssueDetail();
    const sig = JSON.stringify(issuesList.map(i => [i.id, i.status, i.title, i.updated_at]));
    if (!force && sig === lastIssuesSig) return;
    lastIssuesSig = sig;
    $('.mtitle').textContent = 'Issues';
    mbody.textContent = '';
    if (!issuesList.length) { mbody.appendChild(el('div', 'empty', 'No issues yet. Tick "Create an issue" in chat or the inspect popover to open one.')); return; }
    const open = issuesList.filter(i => i.status !== 'closed');
    const closed = issuesList.filter(i => i.status === 'closed');
    [...open, ...closed].forEach(i => {
      const row = el('div', 'iss-row' + (i.status === 'closed' ? ' closed' : ''));
      row.appendChild(el('div', 't', i.title));
      row.appendChild(el('div', 'm', i.status + (i.origin ? ' · from ' + i.origin : '') + (i.links && i.links.length ? ' · ' + i.links.length + ' link(s)' : '')));
      row.onclick = () => openIssueDetail(i.id);
      mbody.appendChild(row);
    });
  }
  function openIssueDetail(id) {
    currentIssue = id; issueChat = []; lastIssueChatSig = '';
    renderIssueDetail();
    loadIssueChat();
  }
  async function loadIssueChat() {
    if (!currentIssue) return;
    let log; try { log = await api('/api/issues/' + encodeURIComponent(currentIssue) + '/inbox'); } catch { return; }
    const sig = JSON.stringify(log.map(r => [r.id, r.role || 'user', r.image || '']));
    if (sig === lastIssueChatSig) return;
    lastIssueChatSig = sig; issueChat = log;
    if (currentModal === 'issues' && currentIssue) renderIssueDetail();
  }
  function renderIssueDetail() {
    const iss = issuesList.find(i => i.id === currentIssue);
    $('.mtitle').textContent = 'Issue';
    mbody.textContent = '';
    const back = el('button', 'iss-back', '‹ All issues');
    back.onclick = () => { currentIssue = null; lastIssuesSig = ''; renderIssues(true); };
    mbody.appendChild(back);
    const head = el('div', 'iss-head');
    head.appendChild(el('div', 't', iss ? iss.title : currentIssue));
    const row = el('div', 'row');
    row.appendChild(el('span', 'iss-pill ' + (iss && iss.status === 'closed' ? 'closed' : 'open'), iss ? iss.status : '…'));
    const toggle = el('button', 'act', iss && iss.status === 'closed' ? 'Reopen' : 'Close');
    toggle.onclick = async () => {
      const action = iss && iss.status === 'closed' ? 'reopen' : 'close';
      try { await api('/api/issues/' + encodeURIComponent(currentIssue) + '/' + action, { method: 'POST', headers: { 'Content-Type': 'application/json' } }); }
      catch (e) { alert(e.message); return; }
      lastIssuesSig = ''; await loadIssues(); renderIssueDetail();
    };
    row.appendChild(toggle);
    head.appendChild(row);
    if (iss && iss.body) head.appendChild(el('div', 'desc', iss.body));
    if (iss && iss.image) { const im = el('img'); im.className = 'chat-shot'; im.style.marginTop = '9px'; im.src = BASE + iss.image; head.appendChild(im); }
    mbody.appendChild(head);
    const log = el('div', 'chat-log');
    if (!issueChat.length) log.appendChild(el('div', 'empty', 'No discussion yet.'));
    else issueChat.forEach(r => log.appendChild(bubbleEl(r)));
    mbody.appendChild(log);
    mbody.appendChild(composer('/api/issues/' + encodeURIComponent(currentIssue) + '/inbox', () => { lastIssueChatSig = ''; loadIssueChat(); }, false));
    mbody.scrollTop = mbody.scrollHeight;
  }

  // ---- data loaders ---------------------------------------------------------
  async function loadMessages(force) {
    let list; try { list = await api('/api/messages?all=1'); } catch { return; }
    messages = list;
    const decN = openOf('decision').length;
    fabBadge.textContent = String(decN);
    fabBadge.classList.toggle('show', decN > 0);
    KINDS.forEach(k => {
      const c = optCnt[k]; if (!c) return;
      const n = String(openOf(k).length);
      if (c.textContent !== n) c.textContent = n;
      c.classList.toggle('hot', k === 'decision' && openOf('decision').length > 0);
    });
    if (currentModal && currentModal !== 'chat') renderModal(force);
  }
  async function loadChat() {
    let log; try { log = await api('/api/inbox'); } catch { return; }
    const sig = JSON.stringify(log.map(r => [r.id, r.role || 'user', r.image || '', (r.links || []).map(id => { const m = messages.find(x => x.id === id); return id + ':' + (m ? m.status : '?'); }).join('|')]));
    if (sig === lastChatSig) return;
    lastChatSig = sig; chatLog = log;
    if (currentModal === 'chat') renderChat();
  }
  const ACT = { working: ['ok', 'working'], idle: ['warn', 'idle'], compacting: ['ok', 'compacting'], stale: ['bad', 'no signal'], ended: ['bad', 'ended'] };
  async function loadStatus() {
    let cls = 'warn', label = '…';
    try { const a = await api('/api/activity'); activityState = a.reported_state || ''; const m = ACT[a.reported_state] || ['warn', a.reported_state || 'unknown']; cls = m[0]; label = (a.reported_state === 'working' && a.task) ? 'working · ' + a.task : m[1]; } catch {}
    fabDot.className = 'fab-dot ' + cls + (activityState === 'working' ? ' working' : '');
    const sdot = $('.mhead .sdot'), stxt = $('.mhead .stxt');
    if (sdot) sdot.className = 'sdot ' + cls;
    if (stxt) stxt.textContent = label;
    updateTyping();
  }

  // ---- wiring ---------------------------------------------------------------
  fab.addEventListener('click', () => setMenu(!menuOpen));
  $('.tochat').addEventListener('click', () => openModal('chat'));
  $('.x').addEventListener('click', closeModal);
  backdrop.addEventListener('click', e => { if (e.target === backdrop) closeModal(); });
  window.addEventListener('keydown', e => { if (e.key === 'Escape') { if (currentModal) closeModal(); else if (menuOpen) setMenu(false); } });
  mbody.addEventListener('pointerdown', bumpHold);
  mbody.addEventListener('keydown', bumpHold);
  mbody.addEventListener('input', bumpHold);

  loadMessages(true); loadStatus();
  setInterval(() => { loadMessages(false); loadStatus(); }, 2500);
  setInterval(() => {
    if (currentModal === 'chat') loadChat();
    else if (currentModal === 'issues') { if (currentIssue) loadIssueChat(); else loadIssues(); }
  }, 2500);
})();
