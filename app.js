/* 森林刷题册 - 静态网页程序 */
(function () {
  const BANK = window.QUESTION_BANKS;
  const STORAGE_KEY = 'forest_quiz_book_state_v1';

  const typeName = { single: '单选', multiple: '多选', short: '简答' };
  const masteryText = { not_started: '未开始', learning: '进行中', mastered: '已掌握' };
  const masteryTag = { not_started: 'gray', learning: 'coin', mastered: '' };

  let ui = {
    screen: 'home',
    setId: localStorage.getItem('forest_quiz_current_set') || 'maogai',
    selectedChapters: [],
    chapterMode: 'chapter_all',
    showQuestionSheet: false,
    wrongTab: 'priority',
    memoryChapter: 'all',
    memoryOpenId: '',
    memoryFavoriteOnly: false,
    memoryAnswerVisible: {},
    memoryRandomIds: [],
    submitConfirmFor: '',
    browserGuardArmed: false,
    history: [],
    showExitDialog: false,
    showStartConflictDialog: false,
    exitTarget: 'home',
    pendingExamStart: null,
    exam: null,
    lastResult: null
  };

  let store = loadStore();
  let inactiveAt = 0;
  let storageIssue = false;

  function loadStore() {
    const fallback = {
      attempts: [],
      results: [],
      practiceResults: [],
      wrongs: {},
      lastWrongIds: {},
      reviewBatches: {},
      recentComprehensive: {},
      memory: {},
      answeredIds: {},
      suspendedExams: {}
    };
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return fallback;
      const loaded = Object.assign(fallback, JSON.parse(raw));
      if (!loaded.reviewBatches || typeof loaded.reviewBatches !== 'object') loaded.reviewBatches = {};
      return loaded;
    } catch (e) {
      console.warn('读取本地数据失败，已重置。', e);
      return fallback;
    }
  }

  function saveStore() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
      storageIssue = false;
      refreshSaveStatus();
      return true;
    } catch (error) {
      if (!storageIssue) showToast('浏览器未能保存，请重试或导出进度', 'error');
      storageIssue = true;
      refreshSaveStatus();
      return false;
    }
  }

  function refreshSaveStatus() {
    document.querySelectorAll('[data-save-status]').forEach(el => {
      el.textContent = storageIssue ? '未保存，请重试' : '进度已保存';
      el.classList.toggle('save-failed', storageIssue);
    });
    document.querySelectorAll('[data-storage-warning]').forEach(el => { el.hidden = !storageIssue; });
  }

  function activeElapsedMs() {
    return ui.exam ? Math.max(0, (inactiveAt || Date.now()) - ui.exam.started_at) : 0;
  }

  function checkpoint() {
    if (!ui.exam) return;
    store.suspendedExams[ui.exam.set_id] = {
      ...ui.exam, elapsed_before_pause: activeElapsedMs(), saved_at: nowText()
    };
    return saveStore();
  }

  function saveShortDraft(value) {
    const q = currentQuestion();
    if (!q || q.type !== 'short' || getResponse(q.question_id)?.submitted) return;
    ui.exam.responses[q.question_id] = { ...getResponse(q.question_id), user_text: value };
    checkpoint();
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function nowText() {
    const d = new Date();
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function setList() { return BANK.sets; }
  function getSet(setId = ui.setId) { return setList().find(s => s.set_id === setId) || setList()[0]; }
  function questions(setId = ui.setId) { return BANK.questions.filter(q => q.set_id === setId); }
  function getQuestion(id) { return BANK.questions.find(q => q.question_id === id); }
  function chapters(setId = ui.setId) { return getSet(setId).chapters || []; }
  function byType(qs, type) { return qs.filter(q => q.type === type); }

  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function sample(arr, n) {
    return shuffle(arr).slice(0, Math.min(n, arr.length));
  }

  function unique(arr) {
    return Array.from(new Set(arr));
  }

  function eqAnswer(user, correct) {
    const a = unique((user || []).map(x => String(x).toUpperCase())).sort().join('');
    const b = unique((correct || []).map(x => String(x).toUpperCase())).sort().join('');
    return a === b && b.length > 0;
  }

  function responseSnapshot(result) {
    const snapshot = {};
    (result.wrong_ids || []).forEach(qid => {
      const res = result.responses?.[qid] || {};
      snapshot[qid] = { user_answer: (res.user_answer || []).slice() };
    });
    return snapshot;
  }

  function ensureReviewBatches(setId = ui.setId) {
    if (!store.reviewBatches) store.reviewBatches = {};
    if (!Array.isArray(store.reviewBatches[setId])) store.reviewBatches[setId] = [];
    const batches = store.reviewBatches[setId];
    const knownExamIds = new Set(batches.map(batch => batch.exam_id));
    let changed = false;
    [...store.results, ...store.practiceResults]
      .filter(result => result.set_id === setId && result.mode !== 'redo' && !knownExamIds.has(result.exam_id))
      .forEach(result => {
        batches.push({
          batch_id: `review_${result.exam_id}`,
          exam_id: result.exam_id,
          mode_name: result.mode_name,
          mode: result.mode,
          scope_name: result.scope_name,
          created_at: result.created_at,
          wrong_ids: (result.wrong_ids || []).slice(),
          responses: responseSnapshot(result),
          resolved_ids: (result.wrong_ids || []).filter(id => store.wrongs[id]?.active_wrong_status === 'mastered')
        });
        changed = true;
      });
    batches.sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')));
    // Keep unresolved batches even after the old 30-exam threshold.
    return { batches: store.reviewBatches[setId], changed };
  }

  function pendingIdsForBatch(batch) {
    const resolved = new Set(batch?.resolved_ids || []);
    return (batch?.wrong_ids || []).filter(id => !resolved.has(id) && getQuestion(id));
  }

  function resolveWrongInReviewBatches(setId, questionId, resolvedAt) {
    const { batches } = ensureReviewBatches(setId);
    batches.forEach(batch => {
      if (!(batch.wrong_ids || []).includes(questionId)) return;
      batch.resolved_ids = unique([...(batch.resolved_ids || []), questionId]);
      batch.last_resolved_at = resolvedAt;
    });
  }

  function latestExamBatch(batches) {
    return batches.filter(batch => batch.mode !== 'chapter_all').slice(-1)[0];
  }


  function armBrowserBackGuard() {
    if (ui.browserGuardArmed || ui.screen !== 'exam') return;
    try {
      history.pushState({ forestQuizExamGuard: true }, '', location.href);
      ui.browserGuardArmed = true;
    } catch (e) {
      console.warn('无法写入浏览器历史保护状态。', e);
    }
  }

  function releaseBrowserBackGuard() {
    ui.browserGuardArmed = false;
  }

  function setCurrentSet(setId) {
    ui.setId = setId;
    ui.selectedChapters = [];
    ui.lastResult = null;
    localStorage.setItem('forest_quiz_current_set', setId);
    nav('home');
  }


function directNav(screen) {
  const previousScreen = ui.screen;
  ui.screen = screen;
  if (screen === 'memory') {
    ui.memoryOpenId = '';
    if (previousScreen !== 'memoryDetail' && previousScreen !== 'memory') {
      ui.memoryChapter = 'all';
      ui.memoryFavoriteOnly = false;
    }
  }
  if (screen === 'exam') armBrowserBackGuard();
  else releaseBrowserBackGuard();
  render();
  if (screen !== previousScreen) window.scrollTo({ top: 0, behavior: 'instant' });
}

function requestExamExit(target = 'home') {
  ui.exitTarget = target;
  ui.showExitDialog = true;
  ui.showStartConflictDialog = false;
  render();
}

function requestStartConflict(mode, selectedChapterIds = [], fixedQuestionIds = [], reviewContext = {}) {
  ui.pendingExamStart = {
    mode,
    selectedChapterIds: selectedChapterIds.slice(),
    fixedQuestionIds: fixedQuestionIds.slice(),
    reviewContext: { ...reviewContext }
  };
  ui.showStartConflictDialog = true;
  ui.showExitDialog = false;
  render();
}

function cancelStartConflict() {
  ui.showStartConflictDialog = false;
  ui.pendingExamStart = null;
  render();
}

function abandonSuspendedAndStart() {
  const pending = ui.pendingExamStart;
  if (!pending) return cancelStartConflict();
  const saved = store.suspendedExams?.[ui.setId];
  if (saved) delete store.suspendedExams[ui.setId];
  if (!saveStore()) {
    if (saved) store.suspendedExams[ui.setId] = saved;
    return;
  }
  ui.showStartConflictDialog = false;
  ui.pendingExamStart = null;
  const fixedQuestions = (pending.fixedQuestionIds || []).map(id => getQuestion(id)).filter(Boolean);
  buildExam(pending.mode, pending.selectedChapterIds || [], fixedQuestions.length ? fixedQuestions : null, pending.reviewContext || {});
}

function continuePreviousFromConflict() {
  ui.showStartConflictDialog = false;
  ui.pendingExamStart = null;
  continueSuspendedExam();
}

function nav(screen) {
  if (ui.screen === 'exam' && screen !== 'exam') {
    requestExamExit(screen);
    return;
  }
  if (screen !== ui.screen) {
    ui.history.push(ui.screen);
    if (ui.history.length > 24) ui.history.shift();
  }
  directNav(screen);
}

function goBack() {
  if (ui.screen === 'memory' && ui.memoryOpenId) {
    ui.memoryOpenId = '';
    render();
    return;
  }
  const target = ui.history.length ? ui.history[ui.history.length - 1] : 'home';
  if (ui.screen === 'exam') {
    requestExamExit(target);
    return;
  }
  ui.history.pop();
  directNav(target === 'exam' ? 'home' : target);
}

function goHome() {
  nav('home');
}

function cancelExamExit() {
  ui.showExitDialog = false;
  ui.exitTarget = 'home';
  render();
}

function saveAndExitExam() {
  const target = ui.exitTarget;
  if (checkpoint() === false) return;
  ui.showExitDialog = false;
  ui.exitTarget = 'home';
  ui.exam = null;
  inactiveAt = 0;
  directNav(target === 'exam' ? 'home' : target);
}

function discardAndExitExam() {
  const target = ui.exitTarget;
  if (ui.exam && store.suspendedExams) {
    const saved = store.suspendedExams[ui.exam.set_id];
    delete store.suspendedExams[ui.exam.set_id];
    if (!saveStore()) {
      if (saved) store.suspendedExams[ui.exam.set_id] = saved;
      return;
    }
  }
  ui.showExitDialog = false;
  ui.exitTarget = 'home';
  ui.exam = null;
  inactiveAt = 0;
  directNav(target === 'exam' ? 'home' : target);
}

function continueSuspendedExam() {
  const saved = store.suspendedExams?.[ui.setId];
  if (!saved) return nav('mode');
  ui.exam = {
    ...saved,
    started_at: Date.now() - (saved.elapsed_before_pause || 0)
  };
  ui.submitConfirmFor = '';
  ui.showQuestionSheet = false;
  inactiveAt = 0;
  checkpoint();
  directNav('exam');
}

  function statsForSet(setId = ui.setId) {
    const qs = questions(setId);
    const objectiveAttempts = store.attempts.filter(a => a.set_id === setId && ['single', 'multiple'].includes(a.type));
    const correct = objectiveAttempts.filter(a => a.is_correct).length;
    const answeredSet = new Set(store.answeredIds[setId] || []);
    return {
      total: qs.length,
      answered: answeredSet.size,
      attemptCount: objectiveAttempts.length,
      accuracy: objectiveAttempts.length ? Math.round(correct / objectiveAttempts.length * 100) : 0,
      finishRate: qs.length ? Math.round(answeredSet.size / qs.length * 100) : 0,
      wrongActive: Object.values(store.wrongs).filter(w => w.set_id === setId && w.active_wrong_status !== 'mastered').length,
      memoryDone: shortQuestions(setId).filter(q => (store.memory[q.question_id] || {}).mastery_status === 'mastered').length,
      memoryTotal: shortQuestions(setId).length
    };
  }

  function shortQuestions(setId = ui.setId) {
    return questions(setId).filter(q => q.type === 'short');
  }


  function updateNavBadges() {
    const st = statsForSet(ui.setId);
    const mappings = {
      navWrongBadge: st.wrongActive,
      navMemoryBadge: Math.max(st.memoryTotal - st.memoryDone, 0)
    };
    Object.entries(mappings).forEach(([id, count]) => {
      const el = document.getElementById(id);
      if (!el) return;
      if (count > 0) {
        el.textContent = count > 99 ? '99+' : String(count);
        el.classList.add('show');
      } else {
        el.textContent = '';
        el.classList.remove('show');
      }
    });
  }

  function splitMemoryText(text) {
    const source = String(text || '').replace(/\r/g, '').trim();
    if (!source) return [];
    const lines = source
      .split('\n')
      .map(s => s.trim())
      .filter(Boolean)
      .filter(s => !/^使用说明/.test(s));
    const units = [];
    lines.forEach(line => {
      const expanded = line.split(/(?=[①②③④⑤⑥⑦⑧⑨⑩])/).map(s => s.trim()).filter(Boolean);
      (expanded.length ? expanded : [line]).forEach(part => units.push(part));
    });
    const blocks = [];
    units.forEach(raw => {
      let cleaned = raw.replace(/^[（(]?\d+[）)]\s*/, '').trim();
      cleaned = cleaned.replace(/^[①②③④⑤⑥⑦⑧⑨⑩]\s*/, '').trim();
      if (!cleaned) return;
      const matched = cleaned.match(/^([^：:]{2,18})[：:](.*)$/);
      if (matched) {
        blocks.push({ title: matched[1].trim(), content: matched[2].trim() });
      } else {
        blocks.push({ title: blocks.length === 0 ? '总述' : `要点 ${blocks.length + 1}`, content: cleaned });
      }
    });
    return blocks;
  }

  function previewMemoryTags(text) {
    return splitMemoryText(text).map(item => item.title).filter(Boolean).slice(0, 3);
  }

function formatParagraph(text) {
  const keywords = ['实事求是','群众路线','独立自主','共同富裕','高质量发展','新发展理念','人民当家作主','依法治国','全面从严治党','中国共产党领导','以人民为中心','改革开放','科学发展观','社会主义本质'];
  let html = escapeHtml(String(text || ''));
  keywords.forEach(word => {
    html = html.replaceAll(word, `<span class="highlight-term">${word}</span>`);
  });
  return html;
}

function renderMemoryAnswer(text) {
  const blocks = splitMemoryText(text);
  if (!blocks.length) return `<div class="memory-plain">暂无参考答案</div>`;
  return `
    <div class="memory-answer memory-answer-focus">
      ${blocks.map((item, idx) => {
        const full = String(item.content || '');
        const isLong = full.length > 110;
        const preview = isLong ? full.slice(0, 110) + '……' : full;
        return `
          <article class="memory-point memory-v6-point glass-panel">
            <div class="memory-order">${String(idx + 1).padStart(2, '0')}</div>
            <div class="memory-body">
              <div class="memory-title-line">
                <h4>${escapeHtml(item.title)}</h4>
                <span class="tag coin">必背重点</span>
              </div>
              <p class="memory-key-text">${formatParagraph(preview)}</p>
              ${isLong ? `<details class="memory-more"><summary>展开完整内容</summary><p>${formatParagraph(full)}</p></details>` : ''}
            </div>
          </article>`;
      }).join('')}
    </div>`;
}

function renderScreenToolbar() {
  if (ui.screen === 'home' || ui.screen === 'exam') return '';
  const titleMap = {
    mode: '模拟考试', chapters: '章节选择', examIntro: '综合挑战', exam: '正在答题', result: '成绩结算', wrong: '错题复盘', memory: '记忆收藏册', memoryDetail: '背诵详情', settings: '设置'
  };
  return `
    <div class="screen-toolbar">
      <button class="screen-tool left" onclick="App.goBack()">← 返回</button>
      <span>${titleMap[ui.screen] || '当前页面'}</span>
      <button class="screen-tool right" onclick="App.goHome()">主页 ⌂</button>
    </div>`;
}



function updateDockState() {
  const nav = document.querySelector('.bottom-nav');
  if (!nav) return;
  nav.classList.remove('is-docked');
}

function renderExamExitDialog() {
  if (!ui.showExitDialog || !ui.exam) return '';
  const answered = Object.values(ui.exam.responses || {}).filter(r => r.submitted).length;
  const total = ui.exam.questions.length;
  const percent = total ? Math.round(answered / total * 100) : 0;
  return `
    <div class="modal-mask global-modal-mask" role="dialog" aria-modal="true" aria-labelledby="exitDialogTitle">
      <div class="exit-dialog glass-panel refined-exit-dialog">
        <span class="exit-pill">中途退出</span>
        <h3 id="exitDialogTitle">暂停本次刷题？</h3>
        <p>已完成 <strong>${answered}</strong> / ${total} 题。保留进度后，可从首页接着做。</p>
        <div class="exit-modal-progress" aria-label="当前完成进度 ${percent}%">
          <div><span>当前进度</span><b>${percent}%</b></div>
          <i style="width:${percent}%"></i>
        </div>
        <div class="exit-actions refined-exit-actions">
          <button class="pixel-btn primary" onclick="App.saveAndExitExam()">保留进度并离开</button>
          <button class="pixel-btn secondary" onclick="App.cancelExamExit()">继续答题</button>
          <button class="pixel-btn danger" onclick="App.discardAndExitExam()">放弃本次进度</button>
        </div>
      </div>
    </div>`;
}

function renderStartConflictDialog() {
  if (!ui.showStartConflictDialog) return '';
  const saved = store.suspendedExams?.[ui.setId];
  if (!saved) return '';
  const answered = Object.values(saved.responses || {}).filter(r => r.submitted).length;
  const total = saved.questions?.length || 0;
  const percent = total ? Math.round(answered / total * 100) : 0;
  return `
    <div class="modal-mask global-modal-mask" role="dialog" aria-modal="true" aria-labelledby="conflictDialogTitle">
      <div class="exit-dialog glass-panel refined-exit-dialog conflict-dialog">
        <span class="exit-pill warning-pill">已保存进度</span>
        <h3 id="conflictDialogTitle">继续上次，还是重新开始？</h3>
        <p>你还有 <strong>${answered}</strong> / ${total} 题的进度未完成。放弃后不会保存本次错题记录，也不会计入学习统计。</p>
        <div class="exit-modal-progress" aria-label="未完成考试进度 ${percent}%">
          <div><span>已保存进度</span><b>${percent}%</b></div>
          <i style="width:${percent}%"></i>
        </div>
        <div class="exit-actions refined-exit-actions">
          <button class="pixel-btn primary" onclick="App.continuePreviousFromConflict()">继续上次刷题</button>
          <button class="pixel-btn secondary" onclick="App.cancelStartConflict()">取消</button>
          <button class="pixel-btn danger" onclick="App.abandonSuspendedAndStart()">放弃旧进度，重新开始</button>
        </div>
      </div>
    </div>`;
}

  function typeCounts(qs) {
    return {
      single: qs.filter(q => q.type === 'single').length,
      multiple: qs.filter(q => q.type === 'multiple').length,
      short: qs.filter(q => q.type === 'short').length
    };
  }

  function render() {
    document.body.dataset.screen = ui.screen === 'memoryDetail' ? 'memory' : ui.screen;
    document.body.classList.toggle('modal-open', !!(ui.showExitDialog || ui.showStartConflictDialog));
    const activeTab = ui.screen === 'memoryDetail' ? 'memory' : ui.screen;
    document.querySelectorAll('.bottom-nav button').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tab === activeTab);
    });
    const app = document.getElementById('app');
    const map = {
      home: renderHome,
      mode: renderMode,
      chapters: renderChapters,
      examIntro: renderExamIntro,
      exam: renderExam,
      result: renderResult,
      wrong: renderWrong,
      memory: renderMemory,
      memoryDetail: renderMemoryDetail,
      settings: renderSettings
    };
    app.innerHTML = renderScreenToolbar() + (map[ui.screen] || renderHome)();
    const dialogs = document.getElementById('dialogs');
    dialogs.innerHTML = renderExamExitDialog() + renderStartConflictDialog();
    document.querySelector('.app-shell').inert = !!dialogs.innerHTML;
    dialogs.querySelector('button')?.focus({ preventScroll: true });
    const actionBar = app.querySelector('.question-actions, .chapter-start-bar');
    document.getElementById('answerDock').replaceChildren();
    if (actionBar) document.getElementById('answerDock').appendChild(actionBar);
    afterRender();
    refreshSaveStatus();
    updateViewport();
    updateNavBadges();
    updateDockState();
  }

  function afterRender() {
    if (ui.screen === 'chapters') {
      document.querySelectorAll('[data-chapter-check]').forEach(input => {
        input.addEventListener('change', () => {
          const id = input.value;
          if (input.checked) ui.selectedChapters = unique([...ui.selectedChapters, id]);
          else ui.selectedChapters = ui.selectedChapters.filter(x => x !== id);
          render();
        });
      });
    }

    if (ui.screen === 'exam') {
      const q = currentQuestion();
      if (q && q.type === 'short') {
        const saved = getResponse(q.question_id);
        const note = document.getElementById('shortDraft');
        if (note && saved && saved.user_text) note.value = saved.user_text;
      }
    }
  }



function showToast(message, kind = 'success') {
  const old = document.querySelector('.v12-toast');
  if (old) old.remove();
  const el = document.createElement('div');
  el.className = `v12-toast ${kind}`;
  el.textContent = message;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  window.setTimeout(() => {
    el.classList.remove('show');
    window.setTimeout(() => el.remove(), 260);
  }, 1800);
}

function renderDailyAdvice(st, latest, saved, weakCount, memoryTodo, quickChapters) {
  const firstChapter = quickChapters[0];
  let title = '今天建议：先完成一组小任务';
  let desc = '先刷 10 道章节题，再复盘错题或背 3 个记忆点，学习路径更清楚。';
  let primaryText = '开始今日任务';
  let primaryAction = "App.nav('chapters')";
  let secondaryText = '去错题复盘';
  let secondaryAction = "App.nav('wrong')";
  if (saved) {
    const done = Object.values(saved.responses || {}).filter(r => r.submitted).length;
    title = '今天建议：继续上次刷题';
    desc = `你还有一场 ${escapeHtml(saved.mode_name || '模拟考试')} 未完成，已完成 ${done}/${saved.questions?.length || 0} 题。`;
    primaryText = '继续上次刷题';
    primaryAction = 'App.continueSuspendedExam()';
  } else if (weakCount > 0) {
    title = '今天建议：先修复错题';
    desc = `当前有 ${weakCount} 道错题待复盘，建议先处理高频错题，再开始新章节。`;
    primaryText = '优先复盘错题';
    primaryAction = "App.nav('wrong')";
    secondaryText = '开始章节刷题';
    secondaryAction = "App.nav('chapters')";
  } else if (memoryTodo > 0) {
    title = '今天建议：随机背 5 个记忆点';
    desc = `还有 ${memoryTodo} 个简答记忆点未掌握，先背一组再刷题会更稳。`;
    primaryText = '随机背 5 个';
    primaryAction = 'App.randomMemoryFive()';
    secondaryText = '开始章节刷题';
    secondaryAction = "App.nav('chapters')";
  } else if (firstChapter) {
    title = `今天建议：从第 ${firstChapter.chapter_no} 章开始`;
    desc = `先刷第 ${firstChapter.chapter_no} 章，再用综合挑战检测。`;
  }
  return `
    <section class="daily-advice-card glass-panel strong-border">
      <div class="daily-icon">🌿</div>
      <div class="daily-copy">
        <span class="eyebrow">下一步推荐</span>
        <h2>${title}</h2>
        <p>${desc}</p>
      </div>
      <div class="daily-actions">
        <button class="pixel-btn primary" onclick="${primaryAction}">${primaryText}</button>
        <button class="pixel-btn secondary" onclick="${secondaryAction}">${secondaryText}</button>
      </div>
    </section>`;
}

function selectedAnswerText(q, res) {
  const user = res?.user_answer || [];
  if (!user.length) return q.type === 'multiple' ? '未选择，多选题可选择多个答案' : '未选择';
  return `${q.type === 'multiple' ? '已选择' : '已选择'}：${user.join('、')}`;
}

function confirmSubmitCurrent() {
  ui.submitConfirmFor = '';
  submitCurrent('__confirmed__');
}

function cancelSubmitConfirm() {
  ui.submitConfirmFor = '';
  render();
}

function renderPriorityWrong(items) {
  if (!items.length) return `<div class="empty"><span class="big">🍀</span>暂无需要优先复盘的错题。</div>`;
  const groups = new Map();
  items.forEach(w => {
    const q = getQuestion(w.question_id);
    if (!q) return;
    if (!groups.has(q.chapter_id)) groups.set(q.chapter_id, { chapter: chapters(q.set_id).find(ch => ch.chapter_id === q.chapter_id), items: [] });
    groups.get(q.chapter_id).items.push(w);
  });
  const rankedGroups = Array.from(groups.values()).sort((a, b) => {
    const score = group => group.items.reduce((sum, w) => sum + wrongPriorityScore(w), 0);
    return score(b) - score(a);
  });
  return `
    <section class="card priority-review-card">
      <div class="card-title"><h3>按章节优先复盘</h3><span class="tag coin">${rankedGroups.length} 个重点章节</span></div>
      <p class="muted-line">章节按待掌握状态、错误次数和多选题风险综合排序，先修复排名靠前的章节。</p>
      ${rankedGroups.map((group, groupIndex) => `
        <section class="chapter-priority-block">
          <div class="chapter-rank-title"><span class="chapter-rank-number">#${groupIndex + 1}</span><div><strong>第 ${group.chapter?.chapter_no || '-'} 章 ${escapeHtml(group.chapter?.chapter_name || '')}</strong><small>${group.items.length} 道优先错题</small></div></div>
          ${group.items.map(w => {
            const q = getQuestion(w.question_id);
            if (!q) return '';
            const reasons = [];
            if ((w.history_error_count || 0) >= 3) reasons.push('错3次+');
            if (w.active_wrong_status !== 'mastered') reasons.push('最近仍错');
            if (w.type === 'multiple') reasons.push('多选易漏');
            if (!(w.sources || []).includes('redo')) reasons.push('未重做');
            return `
              <div class="list-item priority-item">
                <div class="priority-tags"><span class="tag">${typeName[q.type]}</span>${reasons.slice(0,3).map(r => `<span class="tag coin">${r}</span>`).join('')}</div>
                <p>${escapeHtml(q.question)}</p>
                <div class="actions"><button class="pixel-btn primary" onclick="App.startRedo('${w.question_id}')">立即重做</button></div>
              </div>`;
          }).join('')}
        </section>`).join('')}
    </section>`;
}

function wrongPriorityScore(w) {
  return (w.active_wrong_status !== 'mastered' ? 8 : 0)
    + ((w.history_error_count || 0) >= 3 ? 6 : 0)
    + (w.type === 'multiple' ? 4 : 0)
    + (!(w.sources || []).includes('redo') ? 2 : 0)
    + (w.history_error_count || 0);
}

function randomMemoryFive() {
  const pool = shortQuestions(ui.setId).filter(q => (store.memory[q.question_id]?.mastery_status || 'not_started') !== 'mastered');
  const finalPool = shuffle(pool.length ? pool : shortQuestions(ui.setId)).slice(0, 5);
  if (!finalPool.length) return alert('当前套系暂无简答题。');
  ui.screen = 'memory';
  ui.memoryChapter = 'all';
  ui.memoryFavoriteOnly = false;
  ui.memoryRandomIds = finalPool.map(q => q.question_id);
  ui.memoryOpenId = finalPool[0].question_id;
  ui.memoryAnswerVisible = {};
  render();
  showToast('已抽取 5 个记忆点，先遮挡答案默背');
}

function clearRandomMemory() {
  ui.memoryRandomIds = [];
  ui.memoryOpenId = '';
  render();
}

function toggleMemoryAnswer(id) {
  ui.memoryAnswerVisible[id] = !ui.memoryAnswerVisible[id];
  render();
}

function renderHome() {
  const set = getSet();
  const st = statsForSet();
  const latest = [...store.results, ...store.practiceResults].filter(r => r.set_id === ui.setId && r.mode !== 'redo').sort((a,b)=>String(a.created_at).localeCompare(String(b.created_at))).slice(-1)[0];
  const saved = store.suspendedExams?.[ui.setId];
  const quickChapters = chapters().filter(ch => ch.question_count).slice(0, 6);
  const weakCount = st.wrongActive;
  const memoryTodo = Math.max(st.memoryTotal - st.memoryDone, 0);
  const savedAnswered = saved ? Object.values(saved.responses || {}).filter(r => r.submitted).length : 0;
  const savedTotal = saved ? saved.questions.length : 0;
  const savedPercent = savedTotal ? Math.round(savedAnswered / savedTotal * 100) : 0;
  return `
    <div class="home-dashboard">
      <div class="home-left-col">
        <section class="home-v6-hero glass-panel strong-border">
          <div class="home-v5-topline">
            <span class="eyebrow">当前题库 · ${escapeHtml(set.short_name)}</span>
            <button class="quiet-btn mini" onclick="App.nav('settings')">设置</button>
          </div>
          <h1>${saved ? '继续上次刷题' : '今天从章节刷起'}</h1>
          <p>${saved ? `已保存 ${escapeHtml(saved.saved_at || '刚刚')} 的进度，当前完成 ${savedAnswered}/${savedTotal} 题。` : '先用章节冒险打基础，再用综合挑战查漏补缺。错题和记忆点放在右侧/下方，复盘更顺。'}</p>
          ${saved ? `<div class="home-resume-progress"><div><span>保存进度</span><b>${savedPercent}%</b></div><i style="width:${savedPercent}%"></i></div>` : ''}
          <div class="home-v5-main-actions">
            ${saved
              ? `<button class="pixel-btn primary jumbo home-main-cta continue-btn" onclick="App.continueSuspendedExam()">继续上次刷题</button>`
              : `<button class="pixel-btn primary jumbo home-main-cta" onclick="App.nav('chapters')">开始章节刷题</button>`}
            <button class="pixel-btn secondary" onclick="App.nav('examIntro')">综合挑战</button>
          </div>
        </section>

        <section class="home-v6-switch glass-panel strong-border">
          <div class="home-v5-section-head">
            <div><strong>题库套系</strong><small>毛概 / 习概数据独立保存</small></div>
            <span class="tag coin">${set.question_count} 题</span>
          </div>
          <div class="home-v6-set-tabs">
            ${setList().map(s => `
              <button class="${s.set_id === ui.setId ? 'active' : ''}" onclick="App.setCurrentSet('${s.set_id}')">
                <span class="set-count">${s.question_count}题</span>
                <b>${escapeHtml(s.short_name)}</b>
                <small>${s.chapter_count} 章 · ${s.set_id === ui.setId ? '当前学习中' : '点击切换'}</small>
              </button>
            `).join('')}
          </div>
        </section>

        <section class="home-v6-card glass-panel strong-border">
          <div class="home-v5-section-head">
            <div><strong>快速章节</strong><small>点选章节，直接刷完本章</small></div>
            <button class="quiet-btn mini" onclick="App.nav('chapters')">全部章节</button>
          </div>
          <div class="home-v6-chapter-row">
            ${quickChapters.map(ch => `<button onclick="App.startFullChapter('${ch.chapter_id}')"><b>第${ch.chapter_no}章</b><span>全刷 ${ch.question_count} 题</span></button>`).join('')}
          </div>
        </section>
      </div>

      <aside class="home-right-col">
        <section class="home-v6-stats">
          <button onclick="App.nav('chapters')"><span class="stat-ico">🌱</span><strong>${st.finishRate}%</strong><small>完成度</small></button>
          <button onclick="App.nav('mode')"><span class="stat-ico">🎯</span><strong>${st.accuracy}%</strong><small>正确率</small></button>
          <button onclick="App.nav('wrong')"><span class="stat-ico">📕</span><strong>${weakCount}</strong><small>待复盘错题</small></button>
          <button onclick="App.nav('memory')"><span class="stat-ico">💎</span><strong>${st.memoryDone}/${st.memoryTotal}</strong><small>已掌握简答</small></button>
        </section>

        <section class="home-v6-quick-grid">
          <button class="home-v6-task primary-task" onclick="App.nav('chapters')">
            <span class="task-icon">📜</span><div><strong>章节刷题</strong><small>按章节巩固知识点</small></div><em>推荐</em><span class="task-arrow">›</span>
          </button>
          <button class="home-v6-task" onclick="App.nav('wrong')">
            <span class="task-icon">📕</span><div><strong>错题复盘</strong><small>${weakCount ? `${weakCount} 题待处理` : '暂无待复盘'}</small></div><span class="task-arrow">›</span>
          </button>
          <button class="home-v6-task" onclick="App.nav('memory')">
            <span class="task-icon">💎</span><div><strong>记忆收藏</strong><small>${memoryTodo ? `${memoryTodo} 个记忆点待背` : '简答题已掌握'}</small></div><span class="task-arrow">›</span>
          </button>
          <button class="home-v6-task" onclick="App.nav('examIntro')">
            <span class="task-icon">🏆</span><div><strong>综合模拟</strong><small>考前检测整套题</small></div><span class="task-arrow">›</span>
          </button>
        </section>

        <section class="home-v6-card glass-panel strong-border">
          <div class="home-v5-section-head">
            <div><strong>最近一次记录</strong><small>判断下一步是刷题还是复盘</small></div>
            <span class="tag ${latest ? 'coin' : 'gray'}">${latest ? '已记录' : '暂无'}</span>
          </div>
          <div class="home-v5-latest">
            ${latest
              ? `<strong>${Math.round(latest.score)} 分</strong><span>${escapeHtml(latest.mode_name)}｜${escapeHtml(latest.created_at || latest.finished_at)}｜错题 ${latest.wrong_ids.length} 道</span>`
              : `<span>完成一次章节冒险或综合挑战后，这里会显示最近成绩。</span>`}
          </div>
        </section>
      </aside>
    </div>
  `;
}

  function renderMode() {
    return `
      <section class="focus-panel small">
        <div class="focus-copy">
          <span class="eyebrow">模拟考试</span>
          <h1>选一种刷题方式</h1>
          <p>别被功能分散注意力：日常复习选章节冒险，临考检测选综合挑战。</p>
        </div>
      </section>
      <section class="grid mode-grid mode-choice">
        <button class="mode-card recommended" onclick="App.nav('chapters')">
          <span class="entry-icon">📜</span>
          <strong>章节冒险</strong>
          <small>自选章节范围</small>
          <p>本章全部题目，或随机抽题自测</p>
          <em>适合今天刷题</em>
        </button>
        <button class="mode-card" onclick="App.nav('examIntro')">
          <span class="entry-icon">🏆</span>
          <strong>综合挑战</strong>
          <small>全章节随机抽题</small>
          <p>单选 20 道 + 多选 15 道 + 简答 3 道</p>
          <em>适合考前测试</em>
        </button>
      </section>
      <div class="notice slim">题量不足时会按实际题量组卷，并自动折算为 100 分。</div>
    `;
  }


  function renderChapters() {
    const chs = chapters();
    const allIds = chs.map(c => c.chapter_id);
    const allSelected = allIds.every(id => ui.selectedChapters.includes(id));
    const pool = questions().filter(q => ui.selectedChapters.includes(q.chapter_id));
    const tc = typeCounts(pool);
    const count = ui.chapterMode === 'chapter_all' ? pool.length : Math.min(tc.single,10)+Math.min(tc.multiple,10)+Math.min(tc.short,1);
    const done = new Set(store.answeredIds[ui.setId] || []);
    return `
      <section class="focus-panel small">
        <div class="focus-copy">
          <span class="eyebrow">章节冒险 · ${escapeHtml(getSet().short_name)}</span>
          <h1>一章一章，完整掌握</h1>
          <p>全刷依次练习全部单选、多选和简答，随时保存接着做。</p>
        </div>
      </section>
      <div class="chapter-mode-picker" role="group" aria-label="章节刷题方式">
        <button aria-pressed="${ui.chapterMode === 'chapter_all'}" onclick="App.setChapterMode('chapter_all')"><strong>全部题目</strong><small>逐题全刷 · 不漏题</small></button>
        <button aria-pressed="${ui.chapterMode === 'chapter'}" onclick="App.setChapterMode('chapter')"><strong>随机自测</strong><small>单选10 · 多选10 · 简答1</small></button>
      </div>
      <div class="section-title"><h3>选择章节</h3><button class="quiet-btn" onclick="App.selectAllChapters(${!allSelected})">${allSelected ? '取消全选' : '全选章节'}</button></div>
      ${chs.map(ch => {
        const disabled = !ch.question_count;
        return `
        <article class="chapter-entry">
        <label class="chapter-row ${disabled ? 'disabled' : ''}">
          <input data-chapter-check type="checkbox" value="${ch.chapter_id}" ${ui.selectedChapters.includes(ch.chapter_id) ? 'checked' : ''} ${disabled ? 'disabled' : ''}/>
          <span>
            <strong>第 ${ch.chapter_no} 章　${escapeHtml(ch.chapter_name)}</strong>
            <small>单选 ${ch.type_counts.single || 0}｜多选 ${ch.type_counts.multiple || 0}｜简答 ${ch.type_counts.short || 0}｜共 ${ch.question_count} 题</small>
            <small class="chapter-covered">已练 ${questions().filter(q=>q.chapter_id === ch.chapter_id && done.has(q.question_id)).length} / ${ch.question_count} 题</small>
          </span>
          <span class="tag wood">${ch.question_count}题</span>
        </label>
        <button class="chapter-full-btn" onclick="App.startFullChapter('${ch.chapter_id}')" ${disabled ? 'disabled' : ''}>刷本章全部 ${ch.question_count} 题 <span aria-hidden="true">→</span></button>
        </article>`;
      }).join('')}
      <div class="chapter-start-bar"><span>${ui.selectedChapters.length ? `已选 ${ui.selectedChapters.length} 章 · ${count} 题` : '勾选章节，可合并练习'}</span><button class="pixel-btn primary" onclick="App.startChapterExam()" ${count ? '' : 'disabled'}>${ui.chapterMode === 'chapter_all' ? '开始全刷' : '开始自测'}</button></div>
    `;
  }

  function selectAllChapters(yes) {
    ui.selectedChapters = yes ? chapters().map(c => c.chapter_id) : [];
    render();
  }

  function setChapterMode(mode) {
    ui.chapterMode = mode === 'chapter' ? 'chapter' : 'chapter_all';
    render();
  }

  function startFullChapter(id) {
    if (!chapters().some(ch => ch.chapter_id === id)) return;
    ui.chapterMode = 'chapter_all';
    ui.selectedChapters = [id];
    startChapterExam();
  }

  function renderExamIntro() {
    const qs = questions();
    const tc = typeCounts(qs);
    return `
      <section class="hero">
        <h2>综合挑战说明</h2>
        <p>考试范围：${escapeHtml(getSet().short_name)}全章节。系统会尽量避开最近 3 次综合挑战中出现过的题目。</p>
      </section>
      <section class="card">
        <div class="card-title"><h3>标准卷题量</h3><span class="tag coin">100 分</span></div>
        <table class="table">
          <tr><th>题型</th><th>标准题量</th><th>当前题库可用</th></tr>
          <tr><td>单选题</td><td>20 道</td><td>${tc.single} 道</td></tr>
          <tr><td>多选题</td><td>15 道</td><td>${tc.multiple} 道</td></tr>
          <tr><td>简答题</td><td>3 道</td><td>${tc.short} 道</td></tr>
        </table>
        <div class="actions">
          <button class="pixel-btn secondary" onclick="App.nav('mode')">返回</button>
          <button class="pixel-btn primary" onclick="App.startComprehensiveExam()">开始综合挑战</button>
        </div>
      </section>
    `;
  }

  function buildExam(mode, selectedChapterIds = [], presetQuestions = null, reviewContext = {}) {
    const setId = ui.setId;
    let pool = presetQuestions || questions(setId).filter(q => !selectedChapterIds.length || selectedChapterIds.includes(q.chapter_id));
    const standard = mode === 'comprehensive'
      ? { single: 20, multiple: 15, short: 3 }
      : { single: 10, multiple: 10, short: 1 };

    let picked = [];
    if (presetQuestions) {
      picked = presetQuestions;
    } else if (mode === 'chapter_all') {
      picked = pool.slice();
    } else if (mode === 'comprehensive') {
      const recentIds = (store.recentComprehensive[setId] || []).flat();
      ['single','multiple','short'].forEach(type => {
        const typed = byType(pool, type);
        const fresh = typed.filter(q => !recentIds.includes(q.question_id));
        let part = sample(fresh, standard[type]);
        if (part.length < Math.min(standard[type], typed.length)) {
          const extra = sample(typed.filter(q => !part.some(p => p.question_id === q.question_id)), standard[type] - part.length);
          part = part.concat(extra);
        }
        picked = picked.concat(part);
      });
    } else {
      ['single','multiple','short'].forEach(type => {
        picked = picked.concat(sample(byType(pool, type), standard[type]));
      });
    }

    picked = [
      ...picked.filter(q => q.type === 'single'),
      ...picked.filter(q => q.type === 'multiple'),
      ...picked.filter(q => q.type === 'short')
    ];

    if (!picked.length) {
      alert('当前范围没有可用题目。');
      return;
    }

    const scopeName = presetQuestions
      ? (reviewContext.scopeName || '错题重刷')
      : mode === 'comprehensive'
        ? '全章节综合'
        : selectedChapterIds.map(id => chapters(setId).find(c => c.chapter_id === id)?.chapter_name || id).join('、');

    ui.exam = {
      exam_id: `exam_${Date.now()}_${Math.random().toString(36).slice(2,8)}`,
      set_id: setId,
      mode,
      mode_name: mode === 'comprehensive' ? '综合挑战' : mode === 'redo' ? '错题重刷' : mode === 'chapter_all' ? '章节全刷' : '章节自测',
      scope_name: scopeName,
      review_source: reviewContext.source || '',
      review_batch_id: reviewContext.batchId || '',
      questions: picked,
      index: 0,
      responses: {},
      started_at: Date.now()
    };
    ui.screen = 'exam';
    inactiveAt = 0;
    ui.submitConfirmFor = '';
    ui.showQuestionSheet = false;
    armBrowserBackGuard();
    checkpoint();
    render();
    window.scrollTo({top:0, behavior:'instant'});
  }

  function startChapterExam() {
    if (!ui.selectedChapters.length) return alert('请至少选择一个章节。');
    if (store.suspendedExams?.[ui.setId]) return requestStartConflict(ui.chapterMode, ui.selectedChapters);
    buildExam(ui.chapterMode, ui.selectedChapters);
  }

  function startComprehensiveExam() {
    if (store.suspendedExams?.[ui.setId]) return requestStartConflict('comprehensive', []);
    buildExam('comprehensive', []);
  }

  function startRedo(questionId) {
    const q = getQuestion(questionId);
    if (!q) return alert('题目不存在。');
    ui.setId = q.set_id;
    localStorage.setItem('forest_quiz_current_set', q.set_id);
    if (store.suspendedExams?.[q.set_id]) {
      return requestStartConflict('redo', [], [q.question_id], { source: 'single', scopeName: '单题错题重刷' });
    }
    buildExam('redo', [], [q], { source: 'single', scopeName: '单题错题重刷' });
  }

  function reviewQueueIds(queueType) {
    const { batches, changed } = ensureReviewBatches(ui.setId);
    if (changed) saveStore();
    const latest = latestExamBatch(batches);
    if (queueType === 'current') return pendingIdsForBatch(latest);
    const older = batches.filter(batch => batch !== latest).flatMap(pendingIdsForBatch);
    const current = new Set(pendingIdsForBatch(latest));
    const activeIds = activeWrongIds();
    if (queueType === 'history') return unique([...older, ...activeIds]).filter(id => !current.has(id));
    return unique([...batches.flatMap(pendingIdsForBatch), ...activeIds]);
  }

  function activeWrongIds(setId = ui.setId) {
    return Object.values(store.wrongs).filter(w => w.set_id === setId && w.active_wrong_status !== 'mastered' && getQuestion(w.question_id)).map(w => w.question_id);
  }

  function startReviewQueue(queueType = 'all') {
    const ids = reviewQueueIds(queueType);
    if (!ids.length) return alert('这个队列里的错题已经全部完成复盘。');
    const questionsToRedo = ids.map(id => getQuestion(id)).filter(Boolean);
    const scopeMap = {
      current: '本次考试错题重刷',
      history: '历史未完成错题重刷',
      all: '全部待复盘错题重刷'
    };
    const context = { source: queueType, scopeName: scopeMap[queueType] || scopeMap.all };
    if (store.suspendedExams?.[ui.setId]) return requestStartConflict('redo', [], ids, context);
    buildExam('redo', [], questionsToRedo, context);
  }

  function currentQuestion() {
    return ui.exam?.questions?.[ui.exam.index];
  }

  function getResponse(qid) {
    return ui.exam?.responses?.[qid];
  }

function toggleOption(letter) {
  const q = currentQuestion();
  if (!q || getResponse(q.question_id)?.submitted) return;
  const res = ui.exam.responses[q.question_id] || { user_answer: [] };
  let arr = res.user_answer || [];
  if (q.type === 'single') arr = [letter];
  else {
    arr = arr.includes(letter) ? arr.filter(x => x !== letter) : [...arr, letter];
  }
  // V10：点击选项只记录选择，不立刻判定正误。
  // 这样不会出现“选对自动跳、选错停留”的排除法漏洞。
  ui.exam.responses[q.question_id] = {
    ...res,
    user_answer: arr,
    submitted: false,
    is_correct: undefined,
    auto_advanced: false
  };
  ui.submitConfirmFor = '';
  checkpoint();
  render();
  document.querySelector(`[data-letter="${letter}"]`)?.focus({preventScroll:true});
}

  function submitCurrent(mastery) {
    const q = currentQuestion();
    if (!q) return;
    let res = ui.exam.responses[q.question_id] || {};
    if (res.submitted) return;
    if (q.type === 'short') {
      if (!res.answer_visible) return revealShortAnswer();
      if (!['not_started','learning','mastered'].includes(mastery)) return showToast('对照参考答案后，请选择自评掌握度');
      const text = document.getElementById('shortDraft')?.value || '';
      const finalMastery = mastery;
      ui.exam.responses[q.question_id] = {
        ...res,
        user_text: text,
        mastery: finalMastery,
        submitted: true
      };
      if (finalMastery === 'mastered') showToast('已加入掌握清单');
    } else {
      const user = res.user_answer || [];
      if (!user.length) return alert('请先选择答案。');
      if (q.type === 'multiple' && user.length === 1 && mastery !== '__confirmed__') {
        ui.submitConfirmFor = q.question_id;
        render();
        document.querySelector('.submit-confirm-card')?.scrollIntoView({block:'center',behavior:'smooth'});
        return;
      }
      ui.submitConfirmFor = '';
      const isCorrect = eqAnswer(user, q.answer_list);
      ui.exam.responses[q.question_id] = {
        ...res,
        user_answer: user,
        is_correct: isCorrect,
        submitted: true
      };
      ui.exam.correctStreak = isCorrect ? (ui.exam.correctStreak || 0) + 1 : 0;
      if (ui.exam.correctStreak === 5) showToast('状态不错：连续答对 5 题');
      if (ui.exam.mode === 'redo' && isCorrect) showToast('本题答对，完成本轮后更新错题状态');
    }
    checkpoint();
    render();
    document.querySelector('.answer-line')?.scrollIntoView({block:'nearest',behavior:'smooth'});
  }

  function revealShortAnswer() {
    const q = currentQuestion();
    if (!q || q.type !== 'short') return;
    const res = getResponse(q.question_id) || {};
    ui.exam.responses[q.question_id] = { ...res, answer_visible: true };
    checkpoint();
    render();
    document.querySelector('.short-reference')?.scrollIntoView({block:'start',behavior:'smooth'});
  }

  function toggleQuestionSheet() {
    ui.showQuestionSheet = !ui.showQuestionSheet;
    render();
    if (ui.showQuestionSheet) document.querySelector('.question-sheet')?.scrollIntoView({block:'start',behavior:'smooth'});
  }

  function goToQuestion(index) {
    if (!ui.exam || !Number.isInteger(index) || index < 0 || index >= ui.exam.questions.length) return;
    ui.exam.index = index;
    ui.showQuestionSheet = false;
    ui.submitConfirmFor = '';
    checkpoint();
    render();
    window.scrollTo({top:0,behavior:'instant'});
  }

  function nextQuestion() {
    if (!ui.exam) return;
    if (ui.exam.index < ui.exam.questions.length - 1) {
      goToQuestion(ui.exam.index + 1);
    } else {
      finishExam();
    }
  }

  function prevQuestion() {
    if (ui.exam && ui.exam.index > 0) {
      goToQuestion(ui.exam.index - 1);
    }
  }

function exitExam() {
  requestExamExit('home');
}

function renderExam() {
    if (!ui.exam) return renderHome();
    const q = currentQuestion();
    const res = getResponse(q.question_id) || {};
    const submitted = !!res.submitted;
    const index = ui.exam.index;
    const total = ui.exam.questions.length;
    const answered = Object.values(ui.exam.responses).filter(res=>res.submitted).length;
    const progressPercent = Math.round(answered / total * 100);
    const previousQuestion = ui.exam.questions[index - 1];
    const isMultipleTransition = q.type === 'multiple' && (!previousQuestion || previousQuestion.type !== 'multiple');
    return `
      <section class="exam-shell">
        <div class="exam-status">
          <button class="quiet-btn" onclick="App.exitExam()">暂停</button>
          <div class="exam-progress">
            <div class="progress-label"><span>${escapeHtml(ui.exam.mode_name)}</span><strong>${index + 1} / ${total}</strong></div>
            <div class="progress-bar"><i style="width:${progressPercent}%"></i></div>
            <div class="progress-caption">已完成 ${answered} 题 · <span data-save-status aria-live="polite">进度已保存</span></div>
          </div>
          <button class="quiet-btn" aria-expanded="${ui.showQuestionSheet}" onclick="App.toggleQuestionSheet()">答题卡</button>
        </div>
        <section class="storage-warning" data-storage-warning ${storageIssue ? '' : 'hidden'} role="alert"><strong>本次进度尚未保存</strong><p>请重试保存；也可以导出当前进度，稍后继续。</p><div class="actions"><button class="pixel-btn primary" onclick="App.retrySave()">重试保存</button><button class="pixel-btn secondary" onclick="App.exportData()">导出当前进度</button></div></section>
        ${ui.showQuestionSheet ? `<section class="question-sheet card"><div class="card-title"><h3>答题卡</h3><button class="quiet-btn" onclick="App.toggleQuestionSheet()">收起</button></div><p>绿色为已答，空白为待答。点题号可跳转。</p><div class="question-number-grid">${ui.exam.questions.map((item,i)=>`<button class="${ui.exam.responses[item.question_id]?.submitted ? 'done' : ''} ${index === i ? 'current' : ''}" aria-label="第${i+1}题 ${typeName[item.type]} ${ui.exam.responses[item.question_id]?.submitted ? '已答' : '待答'}" onclick="App.goToQuestion(${i})">${i+1}</button>`).join('')}</div></section>` : ''}
        <section class="question-card ${q.type === 'multiple' ? 'multiple-question-card' : ''}">
          ${isMultipleTransition ? `
            <div class="type-transition-banner" role="status" aria-live="polite">
              <span class="transition-icon">✓✓</span>
              <div><strong>题型切换：接下来是多选题</strong><small>答案可能不止一个，选完请核对数量再提交。</small></div>
            </div>` : ''}
          <div class="question-meta">
            <span class="tag wood">${escapeHtml(getSet(q.set_id).short_name)}</span>
            <span class="tag">第 ${q.chapter_no} 章</span>
            <span class="tag coin">${typeName[q.type]}题</span>
            ${q.type === 'multiple' ? '<span class="tag multiple-tag">可选择多个答案</span>' : ''}
          </div>
          <div class="question-text">${escapeHtml(q.question)}</div>
          ${q.type === 'short' ? renderShortQuestion(q, res, submitted) : renderObjectiveQuestion(q, res, submitted)}
          ${renderQuestionActions(q, submitted, index, total)}
        </section>
      </section>
    `;
  }

  function renderQuestionActions(q, submitted, index, total) {
    const res = getResponse(q.question_id) || {};
    const primary = submitted
      ? `<button class="pixel-btn primary question-primary" onclick="App.nextQuestion()">${index === total - 1 ? (ui.exam.mode === 'redo' ? '完成复盘' : ui.exam.mode === 'chapter_all' ? '完成全刷' : '完成交卷') : '下一题 →'}</button>`
      : q.type === 'short'
        ? `<button class="pixel-btn primary question-primary" onclick="${res.answer_visible ? "document.querySelector('.short-rating').scrollIntoView({block:'center',behavior:'smooth'})" : 'App.revealShortAnswer()'}">${res.answer_visible ? '选择自评' : '查看参考答案'}</button>`
        : `<button class="pixel-btn primary question-primary" onclick="App.submitCurrent()" ${(res.user_answer || []).length ? '' : 'disabled'}>提交本题</button>`;
    return `
      <div class="question-actions" aria-label="答题操作">
        <button class="pixel-btn secondary question-prev" onclick="App.prevQuestion()" ${index === 0 ? 'disabled' : ''}>← 上一题</button>
        <span class="question-action-hint">${submitted ? '已提交，可查看解析' : q.type === 'short' ? '先回忆，再对照答案' : `已选 ${(res.user_answer || []).length} 项`}</span>
        ${primary}
      </div>`;
  }


  function renderObjectiveQuestion(q, res, submitted) {
    const user = res.user_answer || [];
    const answerText = (q.answer_list || []).join('');
    const opts = Object.entries(q.options || {}).map(([letter, text]) => {
      const selected = user.includes(letter);
      const isRight = submitted && q.answer_list.includes(letter);
      const isWrong = submitted && selected && !q.answer_list.includes(letter);
      return `
        <button data-letter="${letter}" aria-pressed="${selected}" aria-disabled="${submitted}" class="option ${selected ? 'selected' : ''} ${isRight ? 'correct' : ''} ${isWrong ? 'wrong' : ''}" onclick="App.toggleOption('${letter}')">
          <span class="letter">${letter}</span><span>${escapeHtml(text)}</span>
        </button>`;
    }).join('');
    const showConfirm = ui.submitConfirmFor === q.question_id && !submitted;
    return `
      ${q.type === 'multiple'
        ? '<div class="notice multiple-notice"><strong>多选题</strong>：可选择两个或更多答案。提交前不会判定正误，少选、多选、错选均不得分。</div>'
        : '<div class="notice slim">单选题 · 选择一个答案后提交。</div>'}
      <div class="selected-answer-line ${user.length ? 'has-value' : ''}">${escapeHtml(selectedAnswerText(q, res))}</div>
      <div class="options">${opts}</div>
      ${showConfirm ? `
        <div class="submit-confirm-card">
          <strong>这是多选题，目前只选了 1 项</strong>
          <p>你已选择 ${user.length} 个选项：${escapeHtml(user.join('、'))}。提交后不能修改。</p>
          <div class="actions"><button class="pixel-btn primary" onclick="App.confirmSubmitCurrent()">确认提交</button><button class="pixel-btn secondary" onclick="App.cancelSubmitConfirm()">再检查一下</button></div>
        </div>` : ''}
      ${submitted ? `
        <div class="answer-line"><strong>${res.is_correct ? '回答正确' : '回答错误'}</strong>｜正确答案：${escapeHtml(answerText)}｜你的答案：${escapeHtml((user || []).join('') || '未作答')}</div>
        <div class="analysis"><strong>答案解析</strong><br>${escapeHtml(q.analysis || '暂无解析')}</div>
      ` : ''}
    `;
  }

  function renderShortQuestion(q, res, submitted) {
    const mem = store.memory[q.question_id] || {};
    const status = res.mastery || mem.mastery_status || 'learning';
    return `
      <div class="short-input-toolbar"><label class="short-draft-label" for="shortDraft">先回忆答案（可选填，自动保存）</label><button type="button" class="quiet-btn keyboard-dismiss" onclick="App.dismissKeyboard()">收起键盘</button></div>
      <textarea id="shortDraft" oninput="App.saveShortDraft(this.value)" ${submitted ? 'readonly' : ''} placeholder="写下要点，或在心里默答，再看参考答案。">${escapeHtml(res.user_text || '')}</textarea>
      ${res.answer_visible || submitted ? `<div class="short-reference"><h3>参考答案</h3>${renderMemoryAnswer(q.answer_text || '')}${q.analysis ? `<div class="analysis">${escapeHtml(q.analysis)}</div>` : ''}</div>` : '<div class="notice">点击底部“查看参考答案”，对照后再自评。</div>'}
      ${!submitted && res.answer_visible ? `<div class="short-rating"><h3>对照后，这道题掌握得怎样？</h3><div class="actions">
        <button class="pixel-btn secondary" onclick="App.submitCurrent('not_started')">未掌握</button>
        <button class="pixel-btn secondary" onclick="App.submitCurrent('learning')">部分掌握</button>
        <button class="pixel-btn primary" onclick="App.submitCurrent('mastered')">已掌握</button>
      </div></div>` : ''}
      ${submitted ? `
        <div class="answer-line"><strong>当前自评：</strong>${masteryText[status] || status}</div>
      ` : ''}
    `;
  }

  function finishExam() {
    if (!ui.exam) return;
    const firstUnanswered = ui.exam.questions.findIndex(q => !getResponse(q.question_id)?.submitted);
    if (firstUnanswered !== -1) {
      goToQuestion(firstUnanswered);
      showToast('还有题目未提交，已回到第一道待答题');
      return;
    }
    const result = calculateResult(ui.exam);
    const isReview = ui.exam.mode === 'redo';
    // A failed durable save must leave the entire session available to retry.
    const previousStore = JSON.stringify(store);
    if (store.suspendedExams?.[ui.exam.set_id]) delete store.suspendedExams[ui.exam.set_id];
    if (!saveExamResult(result)) {
      store = JSON.parse(previousStore);
      render();
      document.querySelector('[data-storage-warning]')?.scrollIntoView({block:'center',behavior:'smooth'});
      return;
    }
    ui.lastResult = result;
    ui.exam = null;
    inactiveAt = 0;
    ui.screen = 'result';
    releaseBrowserBackGuard();
    render();
    window.scrollTo({top:0,behavior:'instant'});
    window.setTimeout(() => showToast(isReview ? '本轮错题复盘已保存，不计入考试次数' : '今日完成 +1'), 120);
  }

  function masteryRatio(status) {
    if (status === 'mastered') return 1;
    if (status === 'learning') return 0.5;
    return 0;
  }

  function calculateResult(exam) {
    const maxMap = exam.mode === 'comprehensive'
      ? { single: 40, multiple: 45, short: 15 }
      : exam.mode === 'chapter'
        ? { single: 50, multiple: 40, short: 10 }
        : { single: 80, multiple: 80, short: 20 };

    let raw = 0, availableMax = 0, correctCount = 0, wrongIds = [];
    const typeSummary = {};
    ['single','multiple','short'].forEach(type => {
      const qs = exam.questions.filter(q => q.type === type);
      if (!qs.length) return;
      const max = maxMap[type] || 0;
      availableMax += max;
      if (type === 'short') {
        const ratioSum = qs.reduce((sum, q) => sum + masteryRatio(exam.responses[q.question_id]?.mastery), 0);
        raw += ratioSum / qs.length * max;
        typeSummary[type] = { total: qs.length, completion: Math.round(ratioSum / qs.length * 100) };
      } else {
        const correct = qs.filter(q => exam.responses[q.question_id]?.is_correct).length;
        correctCount += correct;
        raw += correct / qs.length * max;
        qs.forEach(q => {
          if (!exam.responses[q.question_id]?.is_correct) wrongIds.push(q.question_id);
        });
        typeSummary[type] = { total: qs.length, correct, accuracy: Math.round(correct / qs.length * 100) };
      }
    });

    return {
      exam_id: exam.exam_id,
      set_id: exam.set_id,
      set_name: getSet(exam.set_id).set_name,
      mode: exam.mode,
      mode_name: exam.mode_name,
      scope_name: exam.scope_name,
      score: availableMax ? Math.round(raw / availableMax * 100) : 0,
      question_count: exam.questions.length,
      correct_count: correctCount,
      wrong_ids: wrongIds,
      type_summary: typeSummary,
      question_ids: exam.questions.map(q => q.question_id),
      responses: exam.responses,
      duration: Math.max(1, Math.round(activeElapsedMs() / 1000)),
      created_at: nowText()
    };
  }

  function saveExamResult(result) {
    const isReview = result.mode === 'redo';
    const isFullPractice = result.mode === 'chapter_all';
    if (!isReview) {
      const { batches } = ensureReviewBatches(result.set_id);
      const target = isFullPractice ? store.practiceResults : store.results;
      target.push(result);
      if (target.length > 100) target.splice(0, target.length - 100);
      if (!isFullPractice) store.lastWrongIds[result.set_id] = result.wrong_ids;
      if (!batches.some(batch => batch.exam_id === result.exam_id)) {
        batches.push({
          batch_id: `review_${result.exam_id}`,
          exam_id: result.exam_id,
          mode_name: result.mode_name,
          mode: result.mode,
          scope_name: result.scope_name,
          created_at: result.created_at,
          wrong_ids: result.wrong_ids.slice(),
          responses: responseSnapshot(result),
          resolved_ids: []
        });
      }
      store.reviewBatches[result.set_id] = batches;
    }

    if (!store.answeredIds[result.set_id]) store.answeredIds[result.set_id] = [];
    const answeredSet = new Set(store.answeredIds[result.set_id]);

    result.question_ids.forEach(qid => {
      const q = getQuestion(qid);
      const res = result.responses[qid] || {};
      if (!isReview) answeredSet.add(qid);

      if (q.type === 'short') {
        const old = store.memory[qid] || {};
        store.memory[qid] = {
          ...old,
          set_id: q.set_id,
          chapter_id: q.chapter_id,
          mastery_status: res.mastery || old.mastery_status || 'learning',
          updated_at: nowText()
        };
        return;
      }

      const attempt = {
        attempt_id: `att_${Date.now()}_${Math.random().toString(16).slice(2)}`,
        set_id: q.set_id,
        question_id: qid,
        type: q.type,
        exam_id: result.exam_id,
        exam_mode: result.mode,
        source: result.mode === 'comprehensive' ? 'comprehensive_exam' : isReview ? 'redo' : isFullPractice ? 'chapter_practice' : 'chapter_exam',
        user_answer: res.user_answer || [],
        is_correct: !!res.is_correct,
        created_at: result.created_at
      };
      store.attempts.push(attempt);

      if (!res.is_correct) {
        const old = store.wrongs[qid] || { history_error_count: 0, sources: [] };
        store.wrongs[qid] = {
          set_id: q.set_id,
          question_id: qid,
          chapter_id: q.chapter_id,
          type: q.type,
          history_error_count: (old.history_error_count || 0) + 1,
          last_wrong_time: result.created_at,
          last_user_answer: res.user_answer || [],
          active_wrong_status: 'active',
          sources: unique([...(old.sources || []), attempt.source])
        };
      } else if (store.wrongs[qid]) {
        store.wrongs[qid].active_wrong_status = 'mastered';
        store.wrongs[qid].mastered_at = result.created_at;
        store.wrongs[qid].sources = unique([...(store.wrongs[qid].sources || []), attempt.source]);
        if (isReview) store.wrongs[qid].last_review_time = result.created_at;
        resolveWrongInReviewBatches(result.set_id, qid, result.created_at);
      }
    });
    if (!isReview) store.answeredIds[result.set_id] = Array.from(answeredSet);

    if (result.mode === 'comprehensive') {
      const arr = store.recentComprehensive[result.set_id] || [];
      arr.push(result.question_ids);
      store.recentComprehensive[result.set_id] = arr.slice(-3);
    }

    if (store.attempts.length > 2000) store.attempts = store.attempts.slice(-2000);
    return saveStore();
  }

  function renderResult() {
    const r = ui.lastResult || store.results.filter(x => x.set_id === ui.setId).slice(-1)[0];
    if (!r) return `<div class="empty"><span class="big">🏕️</span>暂无成绩，先开始一场冒险吧。</div>`;
    const ts = r.type_summary || {};
    return `
      <section class="card sky">
        ${r.mode === 'redo' ? '<div class="review-result-note"><strong>错题复盘练习</strong><span>本轮记录只更新错题掌握状态，不计入考试次数，也不会覆盖最近一次正式考试。</span></div>' : ''}
        <div class="result-score">
          <strong>${r.mode === 'chapter_all' ? r.question_count : Math.round(r.score)}</strong><span>${r.mode === 'chapter_all' ? '题已完成 · 本轮全刷结束' : '自测总分 / 100'}</span>
        </div>
        <table class="table">
          <tr><th>项目</th><th>结果</th></tr>
          <tr><td>刷题方式</td><td>${escapeHtml(r.mode_name)}</td></tr>
          <tr><td>本次范围</td><td>${escapeHtml(r.scope_name)}</td></tr>
          <tr><td>题量</td><td>${r.question_count} 题</td></tr>
          <tr><td>用时</td><td>${Math.floor(r.duration / 60)} 分 ${r.duration % 60} 秒</td></tr>
          <tr><td>单选正确率</td><td>${ts.single ? `${ts.single.correct}/${ts.single.total}（${ts.single.accuracy}%）` : '无'}</td></tr>
          <tr><td>多选正确率</td><td>${ts.multiple ? `${ts.multiple.correct}/${ts.multiple.total}（${ts.multiple.accuracy}%）` : '无'}</td></tr>
          <tr><td>简答完成度</td><td>${ts.short ? `${ts.short.completion}%` : '无'}</td></tr>
        </table>
        <div class="actions">
          <button class="pixel-btn secondary" onclick="App.nav('${r.mode === 'redo' ? 'wrong' : 'home'}')">${r.mode === 'redo' ? '返回错题复盘' : '返回营地'}</button>
          <button class="pixel-btn primary" onclick="App.nav('wrong')">${r.mode === 'redo' ? '继续处理待复盘' : '查看错题'}</button>
        </div>
      </section>
      <section class="card">
        <div class="card-title"><h3>本次错题</h3><span class="tag danger">${r.wrong_ids.length} 题</span></div>
        ${r.wrong_ids.length ? r.wrong_ids.map(id => miniQuestionItem(id)).join('') : `<div class="empty"><span class="big">🏆</span>本次客观题全部答对。</div>`}
      </section>
    `;
  }

  function miniQuestionItem(id) {
    const q = getQuestion(id);
    if (!q) return '';
    return `
      <div class="list-item">
        <span class="tag">${typeName[q.type]}</span> <span class="tag gray">第 ${q.chapter_no} 章</span>
        <p>${escapeHtml(q.question)}</p>
        <button class="pixel-btn secondary" onclick="App.startRedo('${id}')">重做此题</button>
      </div>`;
  }

function renderWrong() {
  const setId = ui.setId;
  const reviewState = ensureReviewBatches(setId);
  if (reviewState.changed) saveStore();
  const batches = reviewState.batches;
  const latestBatch = latestExamBatch(batches);
  const currentPending = new Set(pendingIdsForBatch(latestBatch));
  const historicalPending = unique([...batches.filter(batch => batch !== latestBatch).flatMap(pendingIdsForBatch), ...activeWrongIds(setId)]).filter(id => !currentPending.has(id));
  const allPending = unique([...batches.flatMap(pendingIdsForBatch), ...activeWrongIds(setId)]);
  const allWrong = Object.values(store.wrongs).filter(w => w.set_id === setId);
  const priorityWrong = allWrong
    .filter(w => w.active_wrong_status !== 'mastered')
    .sort((a,b) => {
      return wrongPriorityScore(b) - wrongPriorityScore(a);
    });
  return `
    <section class="hero">
      <h2>错题图鉴</h2>
      <p>按章节找到薄弱点，再处理本次考试和历史待刷题目。全刷练习的错题也会保留。</p>
    </section>
    <div class="tabs wrong-tabs-v12">
      <button class="${ui.wrongTab === 'priority' ? 'active' : ''}" onclick="App.setWrongTab('priority')">优先复盘</button>
      <button class="${ui.wrongTab === 'current' ? 'active' : ''}" onclick="App.setWrongTab('current')">考试错题重刷${allPending.length ? ` · ${allPending.length}` : ''}</button>
      <button class="${ui.wrongTab === 'top' ? 'active' : ''}" onclick="App.setWrongTab('top')">章节高频 Top</button>
    </div>
    ${ui.wrongTab === 'priority' ? renderPriorityWrong(priorityWrong) : ui.wrongTab === 'current' ? renderCurrentWrong(latestBatch, historicalPending) : renderTopWrong(allWrong)}
  `;
}

function setWrongTab(tab) {
    ui.wrongTab = tab;
    render();
  }

  function renderCurrentWrong(batch, historicalIds) {
    if (!batch && !historicalIds.length) return `<div class="empty"><span class="big">🍄</span>当前套系还没有可复盘的考试错题。</div>`;
    const ids = (batch?.wrong_ids || []).filter(id => getQuestion(id));
    const pendingIds = pendingIdsForBatch(batch);
    return `
      <section class="card review-queue-card current-review-card">
        <div class="card-title"><h3>本次考试错题重刷</h3><span class="tag ${pendingIds.length ? 'danger' : ''}">${pendingIds.length ? `${pendingIds.length} 题待刷` : batch ? '已完成' : '暂无考试'}</span></div>
        <p class="queue-meta">${batch ? `${escapeHtml(batch.mode_name || '模拟考试')}｜${escapeHtml(batch.scope_name || '')}｜${escapeHtml(batch.created_at || '')}` : '暂无最近考试记录'}</p>
        ${pendingIds.length ? `<div class="review-queue-summary"><strong>系统已同步你考试时的最后选择</strong><span>可整组重刷，也可以逐题处理；答对后会自动从待刷队列移除。</span></div><div class="actions queue-actions"><button class="pixel-btn primary" onclick="App.startReviewQueue('current')">开始重刷本次 ${pendingIds.length} 题</button><button class="pixel-btn secondary" onclick="App.startReviewQueue('all')">重刷全部待复盘</button></div>` : ''}
        ${ids.length ? ids.map(id => {
          const q = getQuestion(id);
          const w = store.wrongs[id] || {};
          const resolved = (batch?.resolved_ids || []).includes(id);
          const selected = batch?.responses?.[id]?.user_answer || w.last_user_answer || [];
          return `
            <div class="list-item review-question-item ${resolved ? 'resolved' : ''}">
              <span class="tag">${typeName[q.type]}</span> <span class="tag gray">第 ${q.chapter_no} 章</span> <span class="tag ${resolved ? '' : 'danger'}">${resolved ? '已修复' : `累计错 ${w.history_error_count || 1} 次`}</span>
              <p>${escapeHtml(q.question)}</p>
              <div class="answer-compare"><span>考试时选择 <strong>${escapeHtml(selected.join('、') || '未选择')}</strong></span><span>正确答案 <strong>${escapeHtml((q.answer_list || []).join('、'))}</strong></span></div>
              ${resolved ? '' : `<div class="actions"><button class="pixel-btn secondary" onclick="App.startRedo('${id}')">只重刷此题</button></div>`}
            </div>`;
        }).join('') : `<div class="empty compact-empty">${batch ? '最近一次考试客观题全部答对。' : '暂无正式考试记录，全刷错题见下方。'}</div>`}
      </section>
      <section class="card review-queue-card history-review-card">
        <div class="card-title"><h3>历史未完成错题</h3><span class="tag ${historicalIds.length ? 'coin' : 'gray'}">${historicalIds.length} 题</span></div>
        ${historicalIds.length ? `<p class="queue-meta">保留更早考试和章节全刷中尚未答对复盘的题。</p><div class="actions queue-actions"><button class="pixel-btn primary" onclick="App.startReviewQueue('history')">继续刷历史 ${historicalIds.length} 题</button></div>${historicalIds.map(id => miniQuestionItem(id)).join('')}` : '<div class="empty compact-empty">历史待刷题已处理完成。</div>'}
      </section>`;
  }

  function renderTopWrong(items) {
    if (!items.length) return `<div class="empty"><span class="big">📗</span>当前套系暂无历史错题。</div>`;
    const grouped = new Map();
    items.forEach(w => {
      const q = getQuestion(w.question_id);
      if (!q) return;
      if (!grouped.has(q.chapter_id)) grouped.set(q.chapter_id, { chapter: chapters(q.set_id).find(ch => ch.chapter_id === q.chapter_id), items: [] });
      grouped.get(q.chapter_id).items.push(w);
    });
    const ranked = Array.from(grouped.values()).map(group => ({
      ...group,
      totalErrors: group.items.reduce((sum, w) => sum + (w.history_error_count || 0), 0),
      activeCount: group.items.filter(w => w.active_wrong_status !== 'mastered').length
    })).sort((a, b) => b.totalErrors - a.totalErrors || b.activeCount - a.activeCount).slice(0, 10);
    return `
      <section class="card chapter-top-card">
        <div class="card-title"><h3>章节高频错题榜</h3><span class="tag coin">Top ${ranked.length} 章</span></div>
        <p class="queue-meta">先按章节累计错误次数排名，再在每章内列出高频错题 Top10。</p>
        <div class="chapter-ranking-list">
          ${ranked.map((group, chapterIndex) => {
            const topQuestions = group.items.sort((a, b) => (b.history_error_count || 0) - (a.history_error_count || 0)).slice(0, 10);
            return `
              <details class="chapter-rank-block" ${chapterIndex === 0 ? 'open' : ''}>
                <summary><span class="chapter-rank-number">#${chapterIndex + 1}</span><div><strong>第 ${group.chapter?.chapter_no || '-'} 章 ${escapeHtml(group.chapter?.chapter_name || '')}</strong><small>累计错 ${group.totalErrors} 次｜${group.activeCount} 题待掌握</small></div><span class="rank-toggle">查看本章 Top${topQuestions.length}</span></summary>
                <div class="chapter-top-questions">
                  ${topQuestions.map((w, questionIndex) => {
                    const q = getQuestion(w.question_id);
                    return `
                      <div class="list-item top-wrong-item">
                        <span class="rank-badge">本章 #${questionIndex + 1}</span><span class="tag">${typeName[q.type]}</span><span class="tag danger">错 ${w.history_error_count || 0} 次</span>
                        <p>${escapeHtml(q.question)}</p>
                        <small>状态：${w.active_wrong_status === 'mastered' ? '已掌握' : '仍需复习'}｜最近错误：${escapeHtml(w.last_wrong_time || '-')}</small>
                        <div class="actions"><button class="pixel-btn secondary" onclick="App.startRedo('${w.question_id}')">重刷此题</button></div>
                      </div>`;
                  }).join('')}
                </div>
              </details>`;
          }).join('')}
        </div>
      </section>`;
  }



function memoryKeywords(q) {
  const tags = previewMemoryTags(q.answer_text || '');
  if (tags.length) return tags.slice(0, 4);
  return String(q.question || '').replace(/[？?。]/g, '').split(/[，、,\s]/).filter(Boolean).slice(0, 3);
}

function renderMemory() {
  const setId = ui.setId;
  const shorts = shortQuestions(setId);
  const chs = chapters(setId).filter(ch => shorts.some(q => q.chapter_id === ch.chapter_id));
  const chapterFiltered = ui.memoryChapter === 'all' ? shorts : shorts.filter(q => q.chapter_id === ui.memoryChapter);
  let filtered = ui.memoryFavoriteOnly ? chapterFiltered.filter(q => store.memory[q.question_id]?.favorite) : chapterFiltered;
  if (ui.memoryRandomIds && ui.memoryRandomIds.length) filtered = filtered.filter(q => ui.memoryRandomIds.includes(q.question_id));
  const ordered = filtered.slice().sort((a,b) => {
    const ma = store.memory[a.question_id]?.mastery_status || 'not_started';
    const mb = store.memory[b.question_id]?.mastery_status || 'not_started';
    const order = { not_started: 0, learning: 1, mastered: 2 };
    return (order[ma] ?? 0) - (order[mb] ?? 0) || a.chapter_no - b.chapter_no;
  });
  const total = shorts.length;
  const mastered = shorts.filter(q => (store.memory[q.question_id] || {}).mastery_status === 'mastered').length;
  const learning = shorts.filter(q => (store.memory[q.question_id] || {}).mastery_status === 'learning').length;
  const todo = Math.max(total - mastered, 0);
  const todayTarget = Math.min(5, todo || total);
  const favoriteCount = shorts.filter(q => store.memory[q.question_id]?.favorite).length;
  const latestMem = Object.entries(store.memory || {})
    .map(([id, m]) => ({ id, ...m, q: getQuestion(id) }))
    .filter(x => x.q && x.set_id === setId)
    .sort((a,b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')))[0];

  const cards = ordered.length ? ordered.map(q => {
    const mem = store.memory[q.question_id] || {};
    const status = mem.mastery_status || 'not_started';
    const isOpen = ui.memoryOpenId === q.question_id;
    const keywords = memoryKeywords(q);
    return `
      <article class="memory-card-v7 glass-panel ${isOpen ? 'open' : ''}">
        <div class="memory-card-top">
          <span class="tag gray">第 ${q.chapter_no} 章</span>
          <span class="tag ${masteryTag[status] || ''}">${masteryText[status]}</span>
        </div>
        <button class="memory-card-title" onclick="App.openMemory('${q.question_id}')">${escapeHtml(q.question)}</button>
        ${keywords.length ? `<div class="memory-keyword-row">${keywords.map(t => `<span>${escapeHtml(t)}</span>`).join('')}</div>` : ''}
        <div class="memory-card-actions">
          <button class="pixel-btn primary" onclick="App.openMemory('${q.question_id}')">${isOpen ? '收起重点' : '展开背诵'}</button>
          <button class="pixel-btn secondary" onclick="App.markMemory('${q.question_id}','learning')">还不会</button>
          <button class="pixel-btn secondary" onclick="App.markMemory('${q.question_id}','mastered')">我会了</button>
        </div>
        <div class="memory-inline ${isOpen ? 'show' : ''}">
          <div class="memory-v7-action-panel">
            <button class="pixel-btn primary" onclick="App.markMemory('${q.question_id}','mastered')">已掌握</button>
            <button class="pixel-btn secondary" onclick="App.markMemory('${q.question_id}','learning')">还不会</button>
            <button class="pixel-btn secondary" onclick="App.toggleFavoriteMemory('${q.question_id}')">${mem.favorite ? '已收藏' : '加入收藏'}</button>
            <button class="pixel-btn secondary" onclick="App.showMemoryExample('${q.question_id}')">查看例题</button>
          </div>
          <div class="memory-guide"><strong>背诵口诀：</strong>先看关键词默背，再点“显示答案”核对；像真的背书一样先回想。</div>
          ${ui.memoryAnswerVisible[q.question_id] ? `
            <div class="memory-answer-toolbar"><button class="pixel-btn secondary" onclick="App.toggleMemoryAnswer('${q.question_id}')">遮挡答案</button></div>
            ${renderMemoryAnswer(q.answer_text || '')}
            ${q.analysis ? `<div class="memory-analysis"><strong>关键记忆点</strong>${escapeHtml(q.analysis)}</div>` : ''}
          ` : `
            <div class="memory-mask-card">
              <strong>答案已遮挡</strong>
              <p>先根据标题和关键词在心里默背，再点击显示答案核对。</p>
              <button class="pixel-btn primary" onclick="App.toggleMemoryAnswer('${q.question_id}')">显示答案</button>
            </div>`}
        </div>
      </article>`;
  }).join('') : `<div class="empty"><span class="big">💎</span>${ui.memoryFavoriteOnly ? '当前没有收藏的记忆卡片。' : '当前题库暂无简答题。'}</div>`;

  return `
    <div class="memory-page-v7">
      <main class="memory-main-v7">
        <section class="memory-hero-v7 glass-panel strong-border">
          <div class="memory-headline">
            <div>
              <h2>记忆收藏册</h2>
              <p>先回忆，再展开参考答案；收藏需要反复复习的内容。</p>
            </div>
            <span class="tag coin">重点先行</span>
          </div>
          <div class="memory-overview-v7">
            <div><strong>${total}</strong><span>记忆总数</span></div>
            <div><strong>${learning}</strong><span>进行中</span></div>
            <div><strong>${mastered}</strong><span>已掌握</span></div>
            <div><strong>${todayTarget}</strong><span>今日建议</span></div>
          </div>
        </section>

        <div class="memory-filter-v7">
          <button class="${ui.memoryChapter === 'all' ? 'active' : ''}" onclick="App.setMemoryChapter('all')">全部</button>
          <button class="favorite-filter ${ui.memoryFavoriteOnly ? 'active' : ''}" aria-pressed="${ui.memoryFavoriteOnly}" onclick="App.toggleMemoryFavoriteFilter()">⭐ 收藏 ${favoriteCount}</button>
          <button onclick="App.randomMemoryFive()">随机背 5 个</button>
          ${ui.memoryRandomIds?.length ? `<button class="active" onclick="App.clearRandomMemory()">清除随机组</button>` : ''}
          ${chs.map(ch => `<button class="${ui.memoryChapter === ch.chapter_id ? 'active' : ''}" onclick="App.setMemoryChapter('${ch.chapter_id}')">第${ch.chapter_no}章</button>`).join('')}
        </div>

        <section class="memory-list-v7">${cards}</section>
      </main>

      <aside class="memory-side-v7 glass-panel strong-border">
        <div class="side-title"><strong>学习概览</strong><span>${escapeHtml(getSet(setId).short_name)}</span></div>
        <div class="side-progress"><div><span>掌握进度</span><b>${total ? Math.round(mastered / total * 100) : 0}%</b></div><i style="width:${total ? Math.round(mastered / total * 100) : 0}%"></i></div>
        <div class="side-quick-v7">
          <button onclick="App.nav('home')">🏕️ 营地</button>
          <button onclick="App.nav('mode')">🧭 冒险</button>
          <button onclick="App.nav('wrong')">📕 错题</button>
          <button onclick="App.nav('memory')">💎 记忆</button>
        </div>
        <div class="side-note-v7">
          <strong>最近复习</strong>
          <span>${latestMem ? `第 ${latestMem.q.chapter_no} 章｜${masteryText[latestMem.mastery_status] || '已记录'}｜${escapeHtml(latestMem.updated_at || '')}` : '还没有复习记录，先展开一张卡片开始。'}</span>
        </div>
        <button class="pixel-btn secondary" onclick="window.scrollTo({top:0,behavior:'smooth'})">回到顶部</button>
      </aside>
    </div>`;
}

function setMemoryChapter(id) {
  ui.memoryChapter = id;
  ui.memoryOpenId = '';
  ui.memoryRandomIds = [];
  render();
}

function toggleMemoryFavoriteFilter() {
  ui.memoryFavoriteOnly = !ui.memoryFavoriteOnly;
  ui.memoryOpenId = '';
  render();
}

function openMemory(id) {
  ui.screen = 'memory';
  const nextId = ui.memoryOpenId === id ? '' : id;
  ui.memoryOpenId = nextId;
  if (nextId) ui.memoryAnswerVisible[nextId] = false;
  render();
}

function renderMemoryDetail() {
  ui.screen = 'memory';
  return renderMemory();
}

  function toggleFavoriteMemory(id) {
    const q = getQuestion(id);
    if (!q) return;
    const old = store.memory[id] || {};
    store.memory[id] = {
      ...old,
      set_id: q.set_id,
      chapter_id: q.chapter_id,
      mastery_status: old.mastery_status || 'learning',
      favorite: !old.favorite,
      updated_at: nowText()
    };
    saveStore();
    render();
  }

  function showMemoryExample(id) {
    const q = getQuestion(id);
    if (!q) return;
    ui.selectedChapters = [q.chapter_id];
    nav('chapters');
  }

  function markMemory(id, status) {
    const q = getQuestion(id);
    if (!q) return;
    const old = store.memory[id] || {};
    store.memory[id] = {
      ...old,
      set_id: q.set_id,
      chapter_id: q.chapter_id,
      mastery_status: status,
      updated_at: nowText()
    };
    saveStore();
    render();
    if (status === 'mastered') showToast('已加入掌握清单');
  }

  function randomMemory() {
    const pool = shortQuestions(ui.setId).filter(q => (store.memory[q.question_id]?.mastery_status || 'not_started') !== 'mastered');
    const finalPool = pool.length ? pool : shortQuestions(ui.setId);
    if (!finalPool.length) return alert('当前套系暂无简答题。');
    ui.screen = 'memory';
    ui.memoryOpenId = finalPool[Math.floor(Math.random() * finalPool.length)].question_id;
    render();
  }

  function renderSettings() {
    return `
      <section class="hero">
        <h2>设置与数据</h2>
        <p>学习记录保存在当前浏览器。换手机或换访问地址时，先导出备份，再到新设备导入。</p>
      </section>
      <section class="card">
        <div class="card-title"><h3>题库信息</h3><span class="tag coin">内置数据</span></div>
        <table class="table">
          <tr><th>套系</th><th>章节</th><th>题量</th></tr>
          ${setList().map(s => `<tr><td>${escapeHtml(s.set_name)}</td><td>${s.chapter_count}</td><td>${s.question_count}</td></tr>`).join('')}
        </table>
      </section>
      <section class="card">
        <div class="card-title"><h3>学习数据</h3><span class="tag gray">安全操作</span></div>
        <div class="actions"><button class="pixel-btn primary" onclick="App.exportData()">导出学习数据</button><button class="pixel-btn secondary" onclick="document.getElementById('progressImport').click()">导入学习数据</button></div>
        <input hidden id="progressImport" type="file" accept=".json,application/json" onchange="App.importData(this.files[0])">
        <details class="data-management-fold">
          <summary>数据管理｜清空记录</summary>
          <div class="notice">清空操作不可恢复，日常使用不需要点开这里。建议先导出数据备份。</div>
          <div class="actions">
            <button class="pixel-btn danger" onclick="App.clearCurrentSet()">清空当前套系记录</button>
            <button class="pixel-btn danger" onclick="App.clearAll()">清空全部记录</button>
          </div>
        </details>
      </section>
    `;
  }

  function exportData() {
    const payload = {
      exported_at: new Date().toISOString(),
      app: BANK.meta,
      store
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `forest_quiz_progress_${Date.now()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function importData(file) {
    if (!file) return;
    try {
      const payload = JSON.parse(await file.text());
      const incoming = payload.store;
      if (!incoming || !Array.isArray(incoming.results) || !Array.isArray(incoming.attempts)) throw new Error('invalid');
      for (const key of ['wrongs','memory','suspendedExams','answeredIds','lastWrongIds','recentComprehensive','reviewBatches']) {
        if (incoming[key] != null && (typeof incoming[key] !== 'object' || Array.isArray(incoming[key]))) throw new Error('invalid');
      }
      if (incoming.practiceResults != null && !Array.isArray(incoming.practiceResults)) throw new Error('invalid');
      const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
      const isSet = id => setList().some(set => set.set_id === id);
      const isIds = ids => Array.isArray(ids) && ids.every(id => typeof id === 'string' && getQuestion(id));
      const isResponse = value => isObject(value) && (!value.user_answer || (Array.isArray(value.user_answer) && value.user_answer.every(v => typeof v === 'string')));
      if (!incoming.attempts.every(a=>isObject(a)&&isSet(a.set_id)&&getQuestion(a.question_id)&&isResponse(a))) throw new Error('invalid');
      for (const [set,groups] of Object.entries(incoming.recentComprehensive || {})) if (!isSet(set)||!Array.isArray(groups)||!groups.every(isIds)) throw new Error('invalid');
      for (const result of [...incoming.results, ...(incoming.practiceResults || [])]) {
        if (!isObject(result) || !isSet(result.set_id) || !isIds(result.question_ids) || !isIds(result.wrong_ids) || !isObject(result.responses) || !Object.values(result.responses).every(isResponse)) throw new Error('invalid');
      }
      for (const [id,w] of Object.entries(incoming.wrongs || {})) {
        if (!getQuestion(id) || !isObject(w) || !isSet(w.set_id) || w.question_id !== id || (w.sources && !Array.isArray(w.sources))) throw new Error('invalid');
      }
      for (const [id,m] of Object.entries(incoming.memory || {})) if (!getQuestion(id) || !isObject(m)) throw new Error('invalid');
      for (const map of [incoming.answeredIds, incoming.lastWrongIds]) {
        for (const [set,ids] of Object.entries(map || {})) if (!isSet(set) || !isIds(ids)) throw new Error('invalid');
      }
      for (const [set,batches] of Object.entries(incoming.reviewBatches || {})) {
        if (!isSet(set) || !Array.isArray(batches) || !batches.every(b=>isObject(b)&&isIds(b.wrong_ids)&&isIds(b.resolved_ids||[])&&(!b.responses||(isObject(b.responses)&&Object.values(b.responses).every(isResponse))))) throw new Error('invalid');
      }
      for (const [set,saved] of Object.entries(incoming.suspendedExams || {})) {
        if (!isSet(set) || !isObject(saved) || saved.set_id !== set || !Array.isArray(saved.questions) || !saved.questions.length || !saved.questions.every(q=>isObject(q)&&getQuestion(q.question_id)?.set_id===set) || !isObject(saved.responses) || !Object.values(saved.responses).every(isResponse) || !Number.isInteger(saved.index) || saved.index<0 || saved.index>=saved.questions.length) throw new Error('invalid');
        saved.questions = saved.questions.map(q=>getQuestion(q.question_id));
      }
      if (!confirm('导入将替换当前浏览器的学习记录。建议先导出当前数据；确认导入？')) return;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(incoming));
      store = loadStore();
      ui.lastResult = null;
      render();
      showToast('学习数据已导入，可以继续刷题');
    } catch (error) {
      alert('未能导入：请选择本软件导出的完整 JSON 备份，并检查浏览器存储空间。');
    }
  }

  function clearCurrentSet() {
    const setId = ui.setId;
    if (!confirm(`确认清空当前套系「${getSet().short_name}」的刷题、错题、记忆和未完成考试记录？`)) return;
    store.attempts = store.attempts.filter(a => a.set_id !== setId);
    store.results = store.results.filter(r => r.set_id !== setId);
    store.practiceResults = store.practiceResults.filter(r => r.set_id !== setId);
    ui.lastResult = null;
    Object.keys(store.wrongs).forEach(id => { if (store.wrongs[id].set_id === setId) delete store.wrongs[id]; });
    Object.keys(store.memory).forEach(id => { if (store.memory[id].set_id === setId) delete store.memory[id]; });
    delete store.lastWrongIds[setId];
    if (store.reviewBatches) delete store.reviewBatches[setId];
    delete store.recentComprehensive[setId];
    delete store.answeredIds[setId];
    if (store.suspendedExams) delete store.suspendedExams[setId];
    if (ui.exam?.set_id === setId) {
      ui.exam = null;
      ui.screen = 'home';
      releaseBrowserBackGuard();
    }
    saveStore();
    render();
  }

  function clearAll() {
    if (!confirm('确认清空全部本地学习记录？此操作不可恢复。')) return;
    localStorage.removeItem(STORAGE_KEY);
    store = loadStore();
    ui.exam = null;
    ui.lastResult = null;
    ui.showExitDialog = false;
    ui.showStartConflictDialog = false;
    ui.screen = 'home';
    releaseBrowserBackGuard();
    render();
  }


  window.addEventListener('popstate', (event) => {
    if (ui.screen === 'exam' || ui.showExitDialog) {
      requestExamExit('home');
      try { history.pushState({ forestQuizExamGuard: true }, '', location.href); } catch (e) {}
      ui.browserGuardArmed = true;
    }
  });

  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && (ui.showExitDialog || ui.showStartConflictDialog)) {
      event.preventDefault();
      if (ui.showExitDialog) cancelExamExit();
      else cancelStartConflict();
    }
    if (event.key === 'Tab' && (ui.showExitDialog || ui.showStartConflictDialog)) {
      const buttons = [...document.querySelectorAll('#dialogs button')];
      if (event.shiftKey && document.activeElement === buttons[0]) { event.preventDefault(); buttons.at(-1)?.focus(); }
      else if (!event.shiftKey && document.activeElement === buttons.at(-1)) { event.preventDefault(); buttons[0]?.focus(); }
    }
  });

  window.addEventListener('pagehide', checkpoint);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (ui.exam && !inactiveAt) inactiveAt = Date.now();
      checkpoint();
    } else {
      if (ui.exam && inactiveAt) ui.exam.started_at += Date.now() - inactiveAt;
      inactiveAt = 0;
      if (ui.exam) checkpoint();
      updateViewport();
    }
  });
  function retrySave() {
    if (checkpoint()) showToast('进度已保存');
  }
  function dismissKeyboard() {
    document.getElementById('shortDraft')?.blur();
    updateViewport();
  }
  function updateViewport() {
    const viewport = window.visualViewport;
    const focusedInput = document.activeElement?.matches('textarea, input:not([type="checkbox"]):not([type="file"])');
    const normalScale = !viewport || Math.abs((viewport.scale || 1) - 1) < .05;
    const keyboard = viewport && focusedInput && normalScale ? Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop) : 0;
    document.documentElement.style.setProperty('--keyboard-offset', `${keyboard > 100 ? keyboard : 0}px`);
    document.documentElement.style.setProperty('--visible-height', `${viewport && normalScale ? viewport.height : window.innerHeight}px`);
    document.documentElement.style.setProperty('--visible-top', `${viewport && normalScale ? viewport.offsetTop : 0}px`);
    document.body.classList.toggle('keyboard-open', keyboard > 100);
  }
  document.addEventListener('focusin', updateViewport);
  document.addEventListener('focusout', () => window.setTimeout(updateViewport, 0));
  window.addEventListener('resize', updateViewport);
  window.addEventListener('orientationchange', updateViewport);
  window.visualViewport?.addEventListener('resize', updateViewport);
  window.visualViewport?.addEventListener('scroll', updateViewport);

  window.App = {
    nav, directNav, render, goBack, goHome, cancelExamExit, saveAndExitExam, discardAndExitExam, continueSuspendedExam,
    cancelStartConflict, abandonSuspendedAndStart, continuePreviousFromConflict,
    setCurrentSet, selectAllChapters, setChapterMode, startFullChapter,
    startChapterExam, startComprehensiveExam, startRedo, startReviewQueue,
    toggleOption, submitCurrent, confirmSubmitCurrent, cancelSubmitConfirm, nextQuestion, prevQuestion, exitExam,
    setWrongTab, setMemoryChapter, toggleMemoryFavoriteFilter, openMemory, markMemory, toggleFavoriteMemory, toggleMemoryAnswer, showMemoryExample, randomMemory, randomMemoryFive, clearRandomMemory,
    exportData, importData, clearCurrentSet, clearAll, saveShortDraft, revealShortAnswer, toggleQuestionSheet, goToQuestion, retrySave, dismissKeyboard
  };

  window.addEventListener('scroll', updateDockState, { passive: true });
  window.addEventListener('resize', updateDockState);
  render();
})();
