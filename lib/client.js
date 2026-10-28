/**
 * dsh-clarify — client half (browser bundle).
 *
 * Two surfaces, one shared poller:
 *
 *  - **the pill** (`conversation.input.right`) — the mode switch, and the alarm
 *    that says "there are questions waiting";
 *  - **the panel** (`conversation.input.dock`) — the interview itself: every
 *    question gets its own option chips and its own text box, so a batch of
 *    questions no longer collapses into one answer field.
 *
 * The panel is the only thing that polls. That choice is load-bearing: if the
 * dock slot is unavailable in some composition, nothing polls, the host never
 * sees a client, and the tools fall back to the built-in channel instead of
 * waiting for an answer no UI can send.
 *
 * Everything else is deliberately dumb: one GET every couple of seconds, one
 * POST per action, and the host stays the single source of truth for what is
 * pending, whether the mode is on, and which card was approved.
 *
 * @module dsh-clarify/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-clarify',

  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** `<style>` id, so a reload replaces rather than stacks the sheet. */
    const STYLE_ID = 'dsh-clarify-css'
    /** Slot entry ids. */
    const PILL_ID = 'clarify-mode'
    const PANEL_ID = 'clarify-panel'
    /** Fast enough that a waiting model is not kept waiting; slow when idle. */
    const POLL_PENDING_MS = 2000
    const POLL_ENABLED_MS = 3000
    const POLL_IDLE_MS = 9000
    const REQUEST_TIMEOUT_MS = 8000
    const REVIEW_ID = 'review'

    const CSS = `
.dclr-bar{
  display:inline-flex;
  align-items:center;
  gap:4px;
  flex:0 0 auto;
}
.dclr-btn{
  display:inline-flex;
  align-items:center;
  gap:5px;
  box-sizing:border-box;
  height:24px;
  padding:0 8px;
  border:.5px solid var(--dsw-alias-border-l1);
  border-radius:6px;
  background:transparent;
  color:var(--dsw-alias-label-secondary);
  font:inherit;
  font-size:12px;
  line-height:1;
  white-space:nowrap;
  cursor:pointer;
}
.dclr-btn:hover:not(:disabled){
  color:var(--dsw-alias-label-primary);
  border-color:var(--dsw-alias-border-l2);
}
.dclr-btn:focus-visible{
  outline:2px solid var(--dsw-alias-brand-primary);
  outline-offset:1px;
}
.dclr-btn:disabled{cursor:progress;opacity:.65}
.dclr-btn.dclr-on{
  color:var(--dsw-alias-label-primary);
  border-color:var(--dsw-alias-border-l2);
  background:var(--dsw-alias-bg-layer-1);
}
.dclr-btn.dclr-attn{
  color:var(--dsw-alias-label-primary-foreground);
  border-color:transparent;
  background:var(--dsw-alias-button-primary-fill);
}
.dclr-btn.dclr-attn:hover{opacity:.9}
.dclr-dot{
  width:6px;height:6px;border-radius:50%;flex:0 0 auto;
  background:var(--dsw-alias-label-secondary);opacity:.55;
}
.dclr-btn.dclr-on .dclr-dot{background:var(--dsw-alias-brand-primary);opacity:1}
.dclr-btn.dclr-attn .dclr-dot{background:currentColor;opacity:.9}
.dclr-btn.dclr-error .dclr-dot{background:var(--dsw-alias-state-error-primary, #d9534f);opacity:1}
[data-sidebar-collapsed] .dclr-wait{display:none}
.dclr-wait{font-variant-numeric:tabular-nums}

.dclr-panel{
  box-sizing:border-box;
  width:100%;
  margin:0 0 8px;
  border:1px solid var(--dsw-alias-border-l2);
  border-radius:12px;
  background:var(--dsw-alias-bg-base);
  background:var(--dsw-alias-bg-layer-1);
  color:var(--dsw-alias-label-primary);
  box-shadow:0 8px 24px rgba(0,0,0,.10);
  font-size:13px;
  line-height:1.55;
  overflow:hidden;
}
.dclr-head{
  display:flex;align-items:center;gap:8px;
  padding:9px 12px;
  border-bottom:1px solid var(--dsw-alias-border-l1);
}
.dclr-head .dclr-title{font-weight:600}
.dclr-head .dclr-count,
.dclr-head .dclr-tag{
  font-size:11px;padding:1px 6px;border-radius:999px;
  background:var(--dsw-alias-bg-layer-2, transparent);
  color:var(--dsw-alias-label-secondary);
}
.dclr-head .dclr-tag{max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dclr-head .dclr-spacer{flex:1 1 auto}
.dclr-icon{
  height:22px;min-width:22px;padding:0 6px;
  border:.5px solid transparent;border-radius:6px;background:transparent;
  color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer;
}
.dclr-icon:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l1)}
.dclr-body{padding:10px 12px 4px;max-height:min(52vh,560px);overflow:auto}
.dclr-intro{
  margin:0 0 10px;padding:7px 9px;border-radius:8px;
  background:var(--dsw-alias-bg-layer-2, rgba(0,0,0,.04));
  color:var(--dsw-alias-label-secondary);font-size:12px;
}
.dclr-note{
  margin:0 0 10px;padding:0 2px;
  color:var(--dsw-alias-label-secondary);font-size:11px;line-height:1.5;
  white-space:pre-wrap;
}
.dclr-q{padding:10px 0;border-top:1px dashed var(--dsw-alias-border-l1)}
.dclr-q:first-of-type{border-top:none;padding-top:2px}
.dclr-q-head{display:flex;align-items:baseline;gap:6px;margin-bottom:4px}
.dclr-q-index{
  flex:0 0 auto;font-size:11px;color:var(--dsw-alias-label-secondary);
  border:.5px solid var(--dsw-alias-border-l1);border-radius:5px;padding:0 5px;
}
.dclr-q-header{font-weight:600}
.dclr-q-text{margin:0 0 6px}
.dclr-q-detail{margin:0 0 6px;color:var(--dsw-alias-label-secondary);font-size:12px;white-space:pre-wrap}
.dclr-options{display:flex;flex-wrap:wrap;gap:6px;margin:6px 0}
.dclr-option{
  box-sizing:border-box;text-align:left;max-width:100%;
  padding:6px 10px;border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;
  background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;
  cursor:pointer;
}
.dclr-option:hover{border-color:var(--dsw-alias-label-secondary)}
.dclr-option.is-on{
  border-color:var(--dsw-alias-brand-primary);
  box-shadow:inset 0 0 0 1px var(--dsw-alias-brand-primary);
}
.dclr-option .dclr-opt-desc{display:block;margin-top:2px;color:var(--dsw-alias-label-secondary);font-size:11px}
.dclr-custom{
  box-sizing:border-box;width:100%;min-height:34px;resize:vertical;
  margin-top:6px;padding:7px 9px;
  border:.5px solid var(--dsw-alias-border-l1);border-radius:8px;
  background:transparent;color:var(--dsw-alias-label-primary);
  font:inherit;font-size:12px;line-height:1.5;
}
.dclr-custom:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}
.dclr-review{
  margin:0 0 8px;padding:10px;max-height:min(38vh,380px);overflow:auto;
  border-radius:8px;background:var(--dsw-alias-bg-layer-2, transparent);
  white-space:pre-wrap;word-break:break-word;
  font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:1.6;
}
.dclr-foot{
  display:flex;align-items:center;gap:8px;
  padding:9px 12px;border-top:1px solid var(--dsw-alias-border-l1);
}
.dclr-foot .dclr-hint{flex:1 1 auto;color:var(--dsw-alias-label-secondary);font-size:11px}
.dclr-primary{
  height:28px;padding:0 14px;border:none;border-radius:8px;
  background:var(--dsw-alias-button-primary-fill);
  color:var(--dsw-alias-label-primary-foreground);
  font:inherit;font-size:12px;cursor:pointer;
}
.dclr-primary:hover:not(:disabled){opacity:.9}
.dclr-primary:disabled{opacity:.5;cursor:progress}
.dclr-ghost{
  height:28px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;
  background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer;
}
.dclr-ghost:hover{color:var(--dsw-alias-label-primary)}
.dclr-error{margin:0;padding:6px 12px 0;color:var(--dsw-alias-state-error-primary, #d9534f);font-size:12px}
.dclr-card-actions{display:flex;gap:8px;justify-content:flex-end;padding:9px 12px;border-top:1px solid var(--dsw-alias-border-l1)}
`

    const DICTS = {
      zh: {
        off: '澄清',
        on: '澄清中',
        ok: '已确认',
        card: '卡',
        unavailable: '不可用',
        pending: '…',
        ask: n => `先答 ${n} 个问题`,
        review: '确认需求卡',
        offTitle: '打开后，这个会话的第一件事是先问清需求：复述理解 → 用面板问清关键问题 → 给一张需求卡等你确认，确认后才开工。',
        onTitle: '澄清模式已开：下一轮会先问清关键问题，再给你一张需求卡；你确认之后才开始动手。点击关闭。',
        approvedTitle: '需求卡已确认，正在按卡施工。点击关闭澄清模式。',
        panelTitle: '需求访谈',
        reviewTitle: '需求确认',
        badge: n => `${n} 题`,
        quickMode: '快问',
        focusPrefix: '只问：',
        collapse: '收起',
        expand: '展开',
        skip: '跳过',
        skipTitle: '跳过这次访谈：让 AI 按它推荐的默认值补上假设，直接开工',
        close: '关闭',
        closeTitle: '关掉面板，这一轮交还给你（AI 会停下，等你下一条消息）',
        customPlaceholder: '其他：直接写你自己的答案（会覆盖上面的选择）',
        allRecommended: '全部按推荐',
        submit: '提交答案',
        submitReview: '提交',
        submitting: '提交中…',
        hintQuestions: '每题已默认选中推荐值，直接提交即可',
        hintReview: '确认开工，或者写下要改什么',
        needChoice: '先选一个，或者写下你要改什么',
        errorPrefix: '提交失败：',
        cardTitle: '已确认的需求卡',
        reopen: '开始新任务',
        reopenHint: '清掉这张卡，下一条消息重新走澄清流程',
        waiting: n => `另一个会话在等回答（${n}）`,
        waitingTitle: n => `${n} 个会话正在等你的回答；切过去就能看到问题，不切过去它会一直等`,
        cardHint: '下一轮仍按这张卡执行',
        emptyPreview: '（问题为空）',
      },
      en: {
        off: 'Clarify',
        on: 'Clarifying',
        ok: 'Approved',
        card: 'Card',
        unavailable: 'Unavailable',
        pending: '…',
        ask: n => `Answer ${n} question${n > 1 ? 's' : ''}`,
        review: 'Confirm brief',
        offTitle: 'Turn this on and the session asks before it works: restate the request, interview you in a panel, then hand you a requirement card. Work starts only after you approve it.',
        onTitle: 'Clarify mode is on: the next turn asks the key questions, then submits a requirement card. Work starts after you approve. Click to turn off.',
        approvedTitle: 'The requirement card is approved and being followed. Click to turn clarify mode off.',
        panelTitle: 'Requirement interview',
        reviewTitle: 'Requirement review',
        badge: n => `${n} question${n > 1 ? 's' : ''}`,
        quickMode: 'Quick',
        focusPrefix: 'Only: ',
        collapse: 'Collapse',
        expand: 'Expand',
        skip: 'Skip',
        skipTitle: 'Skip this interview: let the agent fill the gaps with its recommended defaults and start',
        close: 'Close',
        closeTitle: 'Close the panel and take the turn back (the agent stops until your next message)',
        customPlaceholder: 'Other — write your own answer (overrides the choice above)',
        allRecommended: 'All recommended',
        submit: 'Submit answers',
        submitReview: 'Submit',
        submitting: 'Submitting…',
        hintQuestions: 'Every question starts on the recommended option — submit as is',
        hintReview: 'Approve, or write what to change',
        needChoice: 'Pick an option or write what to change first',
        errorPrefix: 'Submit failed: ',
        cardTitle: 'Approved requirement card',
        reopen: 'New task',
        reopenHint: 'Drop this card so the next message is interviewed again',
        waiting: n => `Another session is waiting (${n})`,
        waitingTitle: n => `${n} session(s) are waiting for your answer; switch over to see the questions`,
        cardHint: 'The next turn still follows this card',
        emptyPreview: '(no questions)',
      },
    }

    /** Current UI language, from the document the shell already sets. */
    function language() {
      try {
        const tag = String(document.documentElement.lang || navigator.language || '')
        return tag.toLowerCase().startsWith('zh') ? 'zh' : 'en'
      } catch {
        return 'zh'
      }
    }

    /** Translate one key; unknown keys fall through as-is. */
    function t(key, ...args) {
      const dict = DICTS[language()] ?? DICTS.zh
      const value = dict[key] ?? key
      return typeof value === 'function' ? value(...args) : value
    }

    /** Install the sheet once; the disposer removes it. */
    function installStyles() {
      if (document.getElementById(STYLE_ID) === null) {
        const tag = document.createElement('style')
        tag.id = STYLE_ID
        tag.dataset.plugin = 'dsh-clarify'
        tag.textContent = CSS
        document.head.appendChild(tag)
      }
      return () => document.getElementById(STYLE_ID)?.remove()
    }

    /**
     * One request against the host half, with a timeout and a JSON contract.
     *
     * @param {string} name - Route name under `api/clarify/`.
     * @param {RequestInit} [init]
     * @returns {Promise<Record<string, any>>} parsed JSON body
     */
    async function request(name, init) {
      if (typeof fetch !== 'function') throw new Error(t('unavailable'))
      const base = document.baseURI ?? document.location?.href ?? '/'
      const url = new URL(`api/clarify/${name}`, base).toString()
      const controller = typeof AbortController === 'function' ? new AbortController() : null
      const timer = controller === null ? null : setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
      try {
        const response = await fetch(url, {
          cache: 'no-store',
          credentials: 'same-origin',
          ...init,
          signal: controller?.signal,
        })
        const bodyText = await response.text()
        let body
        try {
          body = bodyText === '' ? {} : JSON.parse(bodyText)
        } catch {
          throw new Error(`HTTP ${response.status}`)
        }
        if (!response.ok && body?.ok !== true) throw new Error(body?.error ?? `HTTP ${response.status}`)
        return body
      } finally {
        if (timer !== null) clearTimeout(timer)
      }
    }

    const post = (name, payload) => request(name, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })

    /**
     * The one shared poller.
     *
     * The panel starts it, both components read it, and it slows down when there
     * is nothing to wait for — a session with the mode off costs one request
     * every nine seconds instead of a stream.
     */
    const feed = (() => {
      let state = {
        sessionId: '',
        enabled: false,
        approved: false,
        pending: null,
        brief: '',
        showCard: false,
        status: 'idle',
        error: '',
        expandTick: 0,
      }
      const listeners = new Set()
      let timer = null
      let watching = 0
      let inFlight = false
      let stopped = false

      const emit = () => {
        for (const listener of [...listeners]) listener()
      }
      const set = (patch) => {
        state = { ...state, ...patch }
        emit()
      }
      const delay = () => {
        if (state.pending !== null) return POLL_PENDING_MS
        return state.enabled ? POLL_ENABLED_MS : POLL_IDLE_MS
      }

      async function poll() {
        if (inFlight || stopped || state.sessionId === '') return
        inFlight = true
        try {
          const body = await request(`pending?session=${encodeURIComponent(state.sessionId)}`)
          if (stopped) return
          set({
            status: 'ready',
            enabled: body.enabled === true,
            approved: body.approved === true,
            pending: body.pending ?? null,
            error: '',
          })
          if (body.approved === true && state.brief === '') void loadBrief()
        } catch (error) {
          if (!stopped) set({ status: 'error', error: String(error?.message ?? error) })
        } finally {
          inFlight = false
          schedule()
        }
      }

      function schedule() {
        if (timer !== null) clearTimeout(timer)
        timer = null
        if (stopped || watching <= 0) return
        timer = setTimeout(() => {
          timer = null
          void poll()
        }, delay())
      }

      /** Read the mode/brief without claiming a panel exists (the pill uses this). */
      async function refreshState() {
        if (state.sessionId === '') return
        try {
          const body = await request(`state?session=${encodeURIComponent(state.sessionId)}`)
          set({
            status: 'ready',
            enabled: body.enabled === true,
            approved: body.approved === true,
            brief: typeof body.brief === 'string' ? body.brief : '',
            error: '',
          })
        } catch (error) {
          set({ status: 'error', error: String(error?.message ?? error) })
        }
      }

      /** Bind a session without polling: the pill acts, the panel polls. */
      function setSession(sessionId) {
        if (state.sessionId === sessionId) return
        set({ sessionId, pending: null, brief: '', showCard: false, enabled: false, approved: false, status: 'idle' })
      }

      async function loadBrief() {
        if (state.sessionId === '') return
        try {
          const body = await request(`state?session=${encodeURIComponent(state.sessionId)}`)
          set({ brief: typeof body.brief === 'string' ? body.brief : '', approved: body.approved === true })
        } catch {
          /* the popover fallback is not worth an error banner */
        }
      }

      return {
        get: () => state,
        subscribe(listener) {
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
        setSession,
        /** Start polling for one session; the returned disposer refcounts. */
        watch(sessionId) {
          watching += 1
          stopped = false
          setSession(sessionId)
          schedule()
          return () => {
            watching = Math.max(0, watching - 1)
            if (watching === 0) {
              stopped = true
              if (timer !== null) clearTimeout(timer)
              timer = null
            }
          }
        },
        expand() {
          set({ expandTick: state.expandTick + 1, showCard: false })
        },
        showCard(value) {
          set({ showCard: value })
          if (value && state.brief === '') void loadBrief()
        },
        async refresh() {
          await poll()
        },
        refreshState,
        async toggle() {
          const next = state.enabled !== true
          await post('toggle', { session: state.sessionId, enabled: next })
          set({ enabled: next })
          // Read state, not pending: a toggle must not fake a panel heartbeat.
          await refreshState()
        },
        async clearCard() {
          await post('clear', { session: state.sessionId })
          set({ brief: '', approved: false, showCard: false })
          await poll()
        },
        async answer(id, answers) {
          await post('answer', { session: state.sessionId, id, answers })
          set({ pending: null })
          await poll()
        },
        async cancel(id, reason) {
          await post('cancel', { session: state.sessionId, id, reason })
          set({ pending: null })
          await poll()
        },
      }
    })()

    /**
     * Subscribe one component to the shared feed.
     *
     * `useSyncExternalStore` would be the textbook choice; this shape keeps the
     * component renderable by the plugin test harness, which stubs only the
     * classic hooks.
     */
    function useFeed() {
      const [snapshot, setSnapshot] = React.useState(feed.get())
      React.useEffect(() => {
        setSnapshot(feed.get())
        return feed.subscribe(() => setSnapshot(feed.get()))
      }, [])
      return snapshot
    }

    /** First-render answers: an interview starts on each question's recommended option. */
    function initialDrafts(pending) {
      /** @type {Record<string, { selected: string[], custom: string }>} */
      const drafts = {}
      if (pending?.kind === 'review') {
        drafts[REVIEW_ID] = { selected: [], custom: '' }
        return drafts
      }
      for (const question of pending?.questions ?? []) {
        const recommended = Array.isArray(question.options) && question.options.length > 0
          ? question.options[0].label
          : ''
        drafts[question.id] = { selected: recommended === '' ? [] : [recommended], custom: '' }
      }
      return drafts
    }

    /**
     * The pill: mode switch, plus the alarm that questions are waiting.
     *
     * @param {{ sessionId?: string, locked?: boolean }} props
     */
    function ClarifyPill(props) {
      const sessionId = typeof props?.sessionId === 'string' ? props.sessionId : ''
      const locked = props?.locked === true
      const snapshot = useFeed()
      const [busy, setBusy] = React.useState(false)

      // The pill is useful without the panel: it only needs one state read, and
      // it must not poll (a poll is the panel's heartbeat, and a fake heartbeat
      // would make the host wait for an answer nobody can send).
      React.useEffect(() => {
        if (sessionId === '') return
        feed.setSession(sessionId)
        void feed.refreshState()
      }, [sessionId])

      const pending = snapshot.pending
      const known = snapshot.status === 'ready'
      const failed = snapshot.status === 'error'

      const onClick = React.useCallback(() => {
        if (busy || sessionId === '') return
        if (pending !== null) {
          feed.expand()
          return
        }
        setBusy(true)
        feed.toggle()
          .catch(() => {})
          .finally(() => setBusy(false))
      }, [busy, pending, sessionId])

      let label = t('off')
      if (snapshot.status === 'idle') label = t('pending')
      else if (failed && !known) label = t('unavailable')
      else if (pending !== null) {
        label = pending.kind === 'review' ? t('review') : t('ask', Array.isArray(pending.questions) ? pending.questions.length : 1)
      } else if (snapshot.enabled) {
        label = snapshot.approved ? t('ok') : t('on')
      }

      let title = snapshot.enabled
        ? (snapshot.approved ? t('approvedTitle') : t('onTitle'))
        : t('offTitle')
      if (pending !== null) title = `${t('panelTitle')}\n${title}`
      if (snapshot.error !== '') title = `${title}\n${snapshot.error}`

      const className = [
        'dclr-btn',
        pending !== null ? 'dclr-on' : snapshot.enabled && known ? 'dclr-on' : '',
        pending !== null ? 'dclr-attn' : '',
        failed ? 'dclr-error' : '',
      ].filter(part => part !== '').join(' ')

      return h('span', { className: 'dclr-bar' }, [
        h('button', {
          key: 'main',
          type: 'button',
          className,
          title,
          disabled: busy || locked || sessionId === '' || (snapshot.status === 'idle' && !known),
          'aria-pressed': pending !== null || (snapshot.enabled && known),
          'aria-label': 'clarify mode',
          onClick,
        }, [
          h('span', { className: 'dclr-dot', key: 'dot', 'aria-hidden': 'true' }),
          label,
        ]),
        snapshot.approved && snapshot.enabled && pending === null
          ? h('button', {
            key: 'card',
            type: 'button',
            className: 'dclr-btn',
            title: t('cardTitle'),
            onClick: () => feed.showCard(!snapshot.showCard),
          }, t('card'))
          : null,
      ])
    }

    /**
     * One question row: chips plus its own text box.
     *
     * @param {{ question: object, index: number, value: { selected: string[], custom: string }, onChange: Function }} props
     */
    function QuestionRow(props) {
      const question = props.question
      const value = props.value ?? { selected: [], custom: '' }
      const options = Array.isArray(question.options) ? question.options : []
      return h('div', { className: 'dclr-q' }, [
        h('div', { className: 'dclr-q-head', key: 'head' }, [
          h('span', { className: 'dclr-q-index', key: 'i' }, String(props.index + 1)),
          question.header !== '' ? h('span', { className: 'dclr-q-header', key: 'h' }, question.header) : null,
        ]),
        h('p', { className: 'dclr-q-text', key: 'text' }, question.question),
        question.detail !== ''
          ? h('p', { className: 'dclr-q-detail', key: 'detail' }, question.detail)
          : null,
        options.length > 0
          ? h('div', { className: 'dclr-options', key: 'options' }, options.map(option => h('button', {
            key: option.label,
            type: 'button',
            className: value.selected.includes(option.label) ? 'dclr-option is-on' : 'dclr-option',
            'aria-pressed': value.selected.includes(option.label),
            onClick: () => props.onChange({
              selected: value.selected.includes(option.label) ? [] : [option.label],
              custom: value.custom,
            }),
          }, [
            option.label,
            option.description !== undefined ? h('span', { className: 'dclr-opt-desc', key: 'd' }, option.description) : null,
          ])))
          : null,
        question.allowCustom === false
          ? null
          : h('textarea', {
            key: 'custom',
            className: 'dclr-custom',
            placeholder: t('customPlaceholder'),
            value: value.custom,
            rows: 2,
            onChange: event => props.onChange({ selected: value.selected, custom: event.target.value }),
          }),
      ])
    }

    /**
     * The panel: interview, review, or the approved card — one card above the
     * composer, in normal flow, so nothing is clipped by the composer's chrome.
     *
     * @param {{ sessionId?: string }} props
     */
    function ClarifyPanel(props) {
      const sessionId = typeof props?.sessionId === 'string' ? props.sessionId : ''
      React.useEffect(() => feed.watch(sessionId), [sessionId])
      const snapshot = useFeed()
      const pending = snapshot.pending
      const pendingId = pending?.id ?? ''

      const [drafts, setDrafts] = React.useState({})
      const [collapsed, setCollapsed] = React.useState(false)
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')

      React.useEffect(() => {
        setDrafts(initialDrafts(pending))
        setCollapsed(false)
        setError('')
      }, [pendingId])

      React.useEffect(() => {
        if (snapshot.expandTick > 0) setCollapsed(false)
      }, [snapshot.expandTick])

      if (pending === null) {
        if (!snapshot.showCard || !snapshot.approved) return null
        return h('div', { className: 'dclr-panel', 'data-clarify': 'card' }, [
          h('div', { className: 'dclr-head', key: 'head' }, [
            h('span', { className: 'dclr-title', key: 't' }, t('cardTitle')),
            h('span', { className: 'dclr-spacer', key: 's' }),
            h('button', {
              key: 'x',
              type: 'button',
              className: 'dclr-icon',
              title: t('close'),
              onClick: () => feed.showCard(false),
            }, '×'),
          ]),
          h('div', { className: 'dclr-body', key: 'body' }, [
            h('pre', { className: 'dclr-review', key: 'card' }, snapshot.brief === '' ? t('emptyPreview') : snapshot.brief),
          ]),
          h('div', { className: 'dclr-card-actions', key: 'foot' }, [
            h('span', { className: 'dclr-hint', key: 'hint' }, t('cardHint')),
            h('button', {
              key: 'close',
              type: 'button',
              className: 'dclr-ghost',
              onClick: () => feed.showCard(false),
            }, t('close')),
            h('button', {
              key: 'reopen',
              type: 'button',
              className: 'dclr-primary',
              title: t('reopenHint'),
              disabled: busy,
              onClick: () => {
                setBusy(true)
                feed.clearCard().catch(() => {}).finally(() => setBusy(false))
              },
            }, t('reopen')),
          ]),
        ])
      }

      const isReview = pending.kind === 'review'
      const questions = Array.isArray(pending.questions) ? pending.questions : []
      const initial = initialDrafts(pending)
      const title = isReview ? t('reviewTitle') : t('panelTitle')
      const count = isReview ? 1 : questions.length
      // All three are optional host extras: absent or malformed means no badge,
      // no hint, and exactly the panel that existed before they were added.
      const quickMode = pending.mode === 'quick'
      const focus = typeof pending.focus === 'string' ? pending.focus.trim() : ''
      const focusText = focus === '' ? '' : `${t('focusPrefix')}${focus}`
      const note = typeof pending.note === 'string' && pending.note.trim() !== '' ? pending.note : ''

      const update = (id, value) => setDrafts(current => ({ ...current, [id]: value }))

      const submit = () => {
        if (busy) return
        if (isReview) {
          const draft = drafts[REVIEW_ID] ?? { selected: [], custom: '' }
          const custom = String(draft.custom ?? '').trim()
          if (draft.selected.length === 0 && custom === '') {
            setError(t('needChoice'))
            return
          }
          setBusy(true)
          setError('')
          feed.answer(pending.id, [{ id: REVIEW_ID, selected: draft.selected, custom }])
            .catch(err => setError(`${t('errorPrefix')}${err?.message ?? err}`))
            .finally(() => setBusy(false))
          return
        }
        const answers = questions.map(question => {
          const draft = drafts[question.id] ?? initial[question.id] ?? { selected: [], custom: '' }
          return {
            id: question.id,
            selected: Array.isArray(draft.selected) ? draft.selected : [],
            custom: String(draft.custom ?? '').trim(),
          }
        })
        setBusy(true)
        setError('')
        feed.answer(pending.id, answers)
          .catch(err => setError(`${t('errorPrefix')}${err?.message ?? err}`))
          .finally(() => setBusy(false))
      }

      const skip = () => {
        if (busy) return
        setBusy(true)
        feed.cancel(pending.id, 'skipped').catch(() => {}).finally(() => setBusy(false))
      }

      const close = () => {
        if (busy) return
        setBusy(true)
        feed.cancel(pending.id, 'dismissed').catch(() => {}).finally(() => setBusy(false))
      }

      const allRecommended = () => {
        if (isReview) return
        setDrafts(initialDrafts(pending))
        setError('')
      }

      const body = collapsed
        ? null
        : h('div', { className: 'dclr-body', key: 'body' }, [
          pending.intro !== undefined && pending.intro !== ''
            ? h('p', { className: 'dclr-intro', key: 'intro' }, pending.intro)
            : null,
          note !== ''
            ? h('p', { className: 'dclr-note', key: 'note' }, note)
            : null,
          isReview
            ? h('pre', { className: 'dclr-review', key: 'card' }, typeof pending.detail === 'string' ? pending.detail : t('emptyPreview'))
            : questions.map((question, index) => h(QuestionRow, {
              key: question.id,
              question,
              index,
              value: drafts[question.id] ?? initial[question.id],
              onChange: value => update(question.id, value),
            })),
          isReview
            ? h('div', { className: 'dclr-options', key: 'review-options' }, (Array.isArray(pending.options) ? pending.options : []).map(option => {
              const draft = drafts[REVIEW_ID] ?? initial[REVIEW_ID] ?? { selected: [], custom: '' }
              const on = draft.selected.includes(option.label)
              return h('button', {
                key: option.label,
                type: 'button',
                className: on ? 'dclr-option is-on' : 'dclr-option',
                'aria-pressed': on,
                onClick: () => update(REVIEW_ID, { selected: on ? [] : [option.label], custom: draft.custom ?? '' }),
              }, [
                option.label,
                option.description !== undefined ? h('span', { className: 'dclr-opt-desc', key: 'd' }, option.description) : null,
              ])
            }))
            : null,
          isReview
            ? h('textarea', {
              key: 'review-custom',
              className: 'dclr-custom',
              placeholder: t('customPlaceholder'),
              rows: 2,
              value: drafts[REVIEW_ID]?.custom ?? '',
              onChange: event => update(REVIEW_ID, {
                selected: drafts[REVIEW_ID]?.selected ?? [],
                custom: event.target.value,
              }),
            })
            : null,
        ])

      return h('div', { className: 'dclr-panel', 'data-clarify': isReview ? 'review' : 'questions' }, [
        h('div', { className: 'dclr-head', key: 'head' }, [
          h('span', { className: 'dclr-title', key: 't' }, title),
          h('span', { className: 'dclr-count', key: 'c' }, t('badge', count)),
          quickMode
            ? h('span', { className: 'dclr-tag', key: 'quick' }, t('quickMode'))
            : null,
          focusText === ''
            ? null
            : h('span', { className: 'dclr-tag', key: 'focus', title: focusText }, focusText),
          h('span', { className: 'dclr-spacer', key: 's' }),
          h('button', {
            key: 'collapse',
            type: 'button',
            className: 'dclr-icon',
            title: collapsed ? t('expand') : t('collapse'),
            onClick: () => setCollapsed(value => !value),
          }, collapsed ? '▾' : '▴'),
          h('button', {
            key: 'skip',
            type: 'button',
            className: 'dclr-icon',
            title: t('skipTitle'),
            disabled: busy,
            onClick: skip,
          }, t('skip')),
          h('button', {
            key: 'close',
            type: 'button',
            className: 'dclr-icon',
            title: t('closeTitle'),
            disabled: busy,
            onClick: close,
          }, '×'),
        ]),
        body,
        error !== ''
          ? h('p', { className: 'dclr-error', key: 'error' }, error)
          : null,
        h('div', { className: 'dclr-foot', key: 'foot' }, [
          h('span', { className: 'dclr-hint', key: 'hint' }, isReview ? t('hintReview') : t('hintQuestions')),
          isReview
            ? null
            : h('button', {
              key: 'recommended',
              type: 'button',
              className: 'dclr-ghost',
              disabled: busy,
              onClick: allRecommended,
            }, t('allRecommended')),
          h('button', {
            key: 'submit',
            type: 'button',
            className: 'dclr-primary',
            disabled: busy,
            onClick: submit,
          }, busy ? t('submitting') : (isReview ? t('submitReview') : t('submit'))),
        ]),
      ])
    }

    /**
     * Sidebar-footer indicator: some *other* session is blocked on an answer.
     *
     * Root-scoped and deliberately dumb — it polls a counts-only route and
     * renders nothing when the queue is empty. It never touches presence, so it
     * cannot be mistaken for the panel.
     */
    function ClarifyWaitingPill() {
      const [sessions, setSessions] = React.useState([])
      const [error, setError] = React.useState('')

      React.useEffect(() => {
        let alive = true
        let timer = null
        let inFlight = false
        let delay = 15000
        const tick = async () => {
          if (inFlight) return
          inFlight = true
          try {
            const body = await request('waiting')
            if (!alive) return
            const list = Array.isArray(body.sessions) ? body.sessions : []
            setSessions(list)
            setError('')
            delay = list.length > 0 ? 3000 : 15000
          } catch (problem) {
            if (alive) setError(String(problem?.message ?? problem))
          } finally {
            inFlight = false
            if (alive) timer = setTimeout(tick, delay)
          }
        }
        void tick()
        return () => {
          alive = false
          if (timer !== null) clearTimeout(timer)
        }
      }, [])

      if (sessions.length === 0) return null
      return h('div', { className: 'dclr-bar dclr-wait' }, [
        h('button', {
          key: 'waiting',
          type: 'button',
          className: 'dclr-btn dclr-on',
          title: error !== '' ? `${t('waitingTitle', sessions.length)}
${error}` : t('waitingTitle', sessions.length),
        }, [h('span', { className: 'dclr-dot', key: 'dot', 'aria-hidden': 'true' }), `⏳ ${sessions.length}`]),
      ])
    }

    return {
      inject: ['slots'],

      apply(ctx) {
        try {
          ctx.effect(installStyles, 'dsh-clarify: styles')
        } catch (error) {
          try {
            console.warn('[dsh-clarify] stylesheet not installed:', error)
          } catch {
            /* nothing left to do */
          }
        }
        // The panel must own polling: no panel means no heartbeat, which is what
        // makes the host fall back instead of waiting for an answer forever.
        try {
          ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
            name: 'conversation.input.dock',
            id: PANEL_ID,
            order: 10,
          }, ClarifyPanel))
        } catch (error) {
          try {
            console.warn('[dsh-clarify] interview panel not registered:', error)
          } catch {
            /* nothing left to do */
          }
        }
        try {
          ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
            name: 'sidebar.footer.action',
            id: 'clarify-waiting',
            order: 5,
          }, ClarifyWaitingPill))
        } catch (error) {
          try {
            console.warn('[dsh-clarify] sidebar indicator not registered:', error)
          } catch {
            /* nothing left to do */
          }
        }
        try {
          ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
            name: 'conversation.input.right',
            id: PILL_ID,
            order: 20,
          }, ClarifyPill))
        } catch (error) {
          try {
            console.warn('[dsh-clarify] composer pill not registered:', error)
          } catch {
            /* nothing left to do */
          }
        }
      },
    }
  },
})
