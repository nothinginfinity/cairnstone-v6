const CONTINUATION_PROMPT = 'Check your CairnStone inbox and continue the Code Session.';
const CAP_STORE_KEY = 'cs.workspaceCapability';
const SESSION_STORE_KEY = 'cs.codeSessionId';

/**
 * V7.7.7f Persistent Code Mode Console panel.
 * Centered on a Code Session (not one model chat). Invite Agent reuses V7.7.6 mint.
 */
export function initCodeSessionPanel(api) {
  const {
    mcpCall,
    toast,
    busy,
    esc,
    chip,
    actorId,
    panel,
    invitePrefill
  } = api;

  const els = {
    sessionId: document.getElementById('codeSessionId'),
    workspaceCap: document.getElementById('codeWorkspaceCap'),
    load: document.getElementById('codeLoad'),
    surface: document.getElementById('codeSurface'),
    projectName: document.getElementById('codeProjectName'),
    sessionLifecycle: document.getElementById('codeSessionLifecycle'),
    currentTask: document.getElementById('codeCurrentTask'),
    actors: document.getElementById('codeActors'),
    tests: document.getElementById('codeTests'),
    workingTree: document.getElementById('codeWorkingTree'),
    meta: document.getElementById('codeMeta'),
    detail: document.getElementById('codeDetail'),
    detailTitle: document.getElementById('codeDetailTitle'),
    detailBody: document.getElementById('codeDetailBody'),
    invite: document.getElementById('codeInviteAgent'),
    send: document.getElementById('codeSendMessage'),
    checkpoints: document.getElementById('codeCheckpoints'),
    viewWork: document.getElementById('codeViewWork'),
    propose: document.getElementById('codeProposeMerge'),
    proposeForm: document.getElementById('codeProposeForm'),
    proposeTitle: document.getElementById('codeProposeTitle'),
    proposeNote: document.getElementById('codeProposeNote'),
    proposePrefix: document.getElementById('codeProposePrefix'),
    proposePaths: document.getElementById('codeProposePaths'),
    proposeConfirm: document.getElementById('codeProposeConfirm'),
    proposeCancel: document.getElementById('codeProposeCancel')
  };

  let view = null;

  if (els.sessionId) els.sessionId.value = sessionStorage.getItem(SESSION_STORE_KEY) || '';
  if (els.workspaceCap) els.workspaceCap.value = sessionStorage.getItem(CAP_STORE_KEY) || '';

  function persistInputs() {
    const sid = (els.sessionId?.value || '').trim();
    const cap = (els.workspaceCap?.value || '').trim();
    if (sid) sessionStorage.setItem(SESSION_STORE_KEY, sid);
    else sessionStorage.removeItem(SESSION_STORE_KEY);
    if (cap) sessionStorage.setItem(CAP_STORE_KEY, cap);
    else sessionStorage.removeItem(CAP_STORE_KEY);
  }

  function credentials() {
    persistInputs();
    const code_session_id = (els.sessionId?.value || '').trim();
    const workspace_capability = (els.workspaceCap?.value || '').trim();
    const actor_id = actorId();
    if (!code_session_id) throw new Error('Code Session ID is required');
    if (!workspace_capability) throw new Error('Workspace capability is required (session only; never stoned)');
    if (!actor_id) throw new Error('Actor ID is required');
    return { code_session_id, actor_id, workspace_capability };
  }

  function workspaceId() {
    return view?.project?.workspace_id
      || view?.actions?.invite_agent?.binds?.workspace_id
      || view?.permissions?.workspace_id
      || null;
  }

  function setActionsEnabled(on) {
    [els.invite, els.send, els.checkpoints, els.viewWork, els.propose].forEach(btn => {
      if (btn) btn.disabled = !on;
    });
  }

  function renderSurface(data) {
    view = data;
    if (!els.surface) return;
    if (!data?.ok) {
      els.surface.classList.add('hidden');
      setActionsEnabled(false);
      if (els.detail) els.detail.classList.add('hidden');
      if (els.proposeForm) els.proposeForm.classList.add('hidden');
      return;
    }

    const op = data.operator_surface || {};
    els.projectName.textContent = op.project_value || data.project?.name || '—';
    els.sessionLifecycle.textContent = op.session_value
      || data.persistent_code_session?.display
      || data.persistent_code_session?.lifecycle
      || '—';
    els.currentTask.textContent = op.current_task_value
      || data.current_task?.title
      || data.current_task?.task_id
      || 'None';
    els.tests.textContent = op.tests_value || data.tests?.summary || '—';
    els.workingTree.textContent = op.working_tree_value
      || data.working_tree?.summary
      || '—';

    const actorLines = Array.isArray(op.actors_lines) && op.actors_lines.length
      ? op.actors_lines
      : (data.actors || []).map(a => {
        const detail = a.detail ? ` · ${a.detail}` : '';
        return `${a.display || a.actor_id}     ${a.status || 'idle'}${detail}`;
      });
    els.actors.innerHTML = actorLines.length
      ? actorLines.map(line => `<div class="code-actor-line">${esc(line)}</div>`).join('')
      : '<div class="muted small">No actors reported</div>';

    if (els.meta) {
      const bits = [];
      if (data.project?.workspace_id) bits.push(chip(data.project.workspace_id));
      if (data.persistent_code_session?.code_session_id) bits.push(chip(data.persistent_code_session.code_session_id));
      if (data.console_grants_no_new_authority) bits.push(chip('console grants no new authority'));
      if (data.accepted_state_authority === false) bits.push(chip('accepted_state_authority: false'));
      els.meta.innerHTML = bits.join('');
    }

    els.surface.classList.remove('hidden');
    setActionsEnabled(true);
  }

  function showDetail(title, content) {
    if (!els.detail) return;
    els.detailTitle.textContent = title;
    if (typeof content === 'string') {
      els.detailBody.textContent = content;
    } else {
      els.detailBody.textContent = JSON.stringify(content, null, 2);
    }
    els.detail.classList.remove('hidden');
  }

  async function loadView() {
    busy(els.load, true, 'Loading…');
    try {
      const args = credentials();
      const data = await mcpCall('cairnstone_code_session_console_view', args);
      if (!data?.ok) throw new Error(data?.error || 'console_view_failed');
      renderSurface(data);
      if (els.detail) els.detail.classList.add('hidden');
      if (els.proposeForm) els.proposeForm.classList.add('hidden');
      toast('Code Session view loaded');
    } catch (err) {
      renderSurface(null);
      showDetail('Load failed', err.payload || { error: err.message });
      toast(err.message);
    } finally {
      busy(els.load, false, 'Load console view');
    }
  }

  function inviteAgent() {
    const ws = workspaceId();
    if (!ws) return toast('Load a Code Session view first (workspace_id missing)');
    const prompt = view?.continuation_prompt || CONTINUATION_PROMPT;
    if (typeof invitePrefill === 'function') {
      invitePrefill({
        workspaceId: ws,
        instruction: prompt,
        fallback: prompt
      });
    }
    panel('invite');
    toast('Invite uses V7.7.6 mint — Mint & Send on Invite tab (no second ticket format)');
  }

  async function sendMessage() {
    const prompt = view?.continuation_prompt || CONTINUATION_PROMPT;
    const suggested = view?.actions?.send_message || {};
    const toField = document.getElementById('composeTo');
    const subjectField = document.getElementById('composeSubject');
    const bodyField = document.getElementById('composeBody');
    const intentField = document.getElementById('composeIntent');

    if (bodyField) bodyField.value = suggested.suggested_body || prompt;
    if (subjectField) {
      subjectField.value = suggested.suggested_subject
        || `Continue Code Session${view?.persistent_code_session?.code_session_id ? `: ${view.persistent_code_session.code_session_id}` : ''}`;
    }
    if (intentField) intentField.value = 'message';

    const recipients = (toField?.value || '')
      .split(/[\n,]+/)
      .map(s => s.trim())
      .filter(Boolean);

    if (!recipients.length) {
      panel('invite');
      toast('Set recipients in Invite → Send message, then send the continuation prompt');
      const compose = document.getElementById('composeBody');
      compose?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }

    try {
      const r = await mcpCall('cairnstone_send_message', {
        from: actorId(),
        to: recipients,
        content: bodyField?.value || prompt,
        intent: 'message',
        priority: 'normal',
        subject: subjectField?.value || 'Continue Code Session',
        labels: ['work-plane', 'informational', 'code-session']
      });
      showDetail('Message sent', {
        ok: r.ok,
        message_id: r.message_id || r.metadata?.message_id,
        stone_hash: r.stone_hash,
        accepted_state_authority: false,
        note: 'AC1 correspondence only — no grants minted'
      });
      toast('Continuation message sent');
    } catch (err) {
      showDetail('Send failed', err.payload || { error: err.message });
      toast(err.message);
    }
  }

  async function listCheckpoints() {
    busy(els.checkpoints, true, '…');
    try {
      const args = credentials();
      const r = await mcpCall('cairnstone_code_checkpoint_list', { ...args, limit: 20 });
      const rows = r.checkpoints || r.recent || [];
      if (!rows.length) {
        showDetail('Checkpoints', 'No checkpoints returned for this Code Session.');
        toast('No checkpoints');
        return;
      }
      const lines = rows.map((cp, i) => {
        const id = cp.checkpoint_id || cp.id || '—';
        const when = cp.created_at || cp.age || '';
        const boundary = cp.boundary || '';
        const actor = cp.actor_id || '';
        return `${i + 1}. ${id}${boundary ? ` · ${boundary}` : ''}${actor ? ` · ${actor}` : ''}${when ? ` · ${when}` : ''}`;
      });
      showDetail('Recent checkpoints', lines.join('\n'));
      toast(`Loaded ${rows.length} checkpoint${rows.length === 1 ? '' : 's'}`);
    } catch (err) {
      showDetail('Checkpoints failed', err.payload || { error: err.message });
      toast(err.message);
    } finally {
      busy(els.checkpoints, false, 'Checkpoints');
    }
  }

  async function viewWork() {
    busy(els.viewWork, true, '…');
    try {
      const { actor_id, workspace_capability } = credentials();
      const ws = workspaceId();
      if (!ws) throw new Error('workspace_id missing — load console view first');
      let tree;
      try {
        tree = await mcpCall('cairnstone_workspace_tree_ls', {
          workspace_id: ws,
          actor_id,
          workspace_capability
        });
      } catch {
        tree = await mcpCall('cairnstone_workspace_ls', {
          workspace_id: ws,
          actor_id,
          workspace_capability
        });
      }
      const entries = tree.entries || tree.paths || tree.files || tree.items || [];
      const paths = Array.isArray(entries)
        ? entries.map(x => (typeof x === 'string' ? x : (x.path || x.name || JSON.stringify(x))))
        : [];
      const digest = tree.tip_vector_digest || tree.digest || null;
      const summary = [
        `Workspace: ${ws}`,
        digest ? `tip_vector_digest: ${digest}` : null,
        `Paths: ${paths.length}`,
        paths.length ? '' : null,
        ...paths.slice(0, 80)
      ].filter(v => v !== null).join('\n');
      showDetail('Working tree / drafts', summary || JSON.stringify({
        ok: tree.ok,
        tip_vector_digest: digest,
        accepted_state_authority: false
      }, null, 2));
      toast(`View work · ${paths.length} path${paths.length === 1 ? '' : 's'}`);
    } catch (err) {
      showDetail('View work failed', err.payload || { error: err.message });
      toast(err.message);
    } finally {
      busy(els.viewWork, false, 'View Work');
    }
  }

  function openProposeForm() {
    const ws = workspaceId();
    if (!ws) return toast('Load a Code Session view first');
    if (els.proposeForm) els.proposeForm.classList.remove('hidden');
    els.proposeForm?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    toast('Propose/Merge uses cairnstone_workspace_propose_accept only — Console grants no new authority');
  }

  async function confirmPropose() {
    const ws = workspaceId();
    if (!ws) return toast('workspace_id missing');
    const { actor_id, workspace_capability } = credentials();
    const title = (els.proposeTitle?.value || '').trim();
    const note = (els.proposeNote?.value || '').trim();
    const prefix = (els.proposePrefix?.value || '').trim();
    const paths = (els.proposePaths?.value || '')
      .split(/[\n,]+/)
      .map(s => s.trim())
      .filter(Boolean);

    const confirmed = window.confirm(
      [
        'Propose / Merge calls cairnstone_workspace_propose_accept only.',
        'Console grants no new merge/deploy authority.',
        'accepted_state_authority remains false; HEADs are not moved.',
        '',
        `Workspace: ${ws}`,
        title ? `Title: ${title}` : null,
        prefix ? `Prefix: ${prefix}` : null,
        paths.length ? `Paths: ${paths.length}` : 'Paths: (all eligible tips / server default)',
        '',
        'Continue?'
      ].filter(Boolean).join('\n')
    );
    if (!confirmed) return toast('Propose cancelled');

    busy(els.proposeConfirm, true, 'Proposing…');
    try {
      const body = {
        workspace_id: ws,
        actor_id,
        workspace_capability
      };
      if (title) body.title = title;
      if (note) body.note = note;
      if (prefix) body.prefix = prefix;
      if (paths.length) body.paths = paths;

      const r = await mcpCall('cairnstone_workspace_propose_accept', body);
      showDetail('Propose / Merge result', {
        ok: r.ok,
        proposal_id: r.proposal_id || r.proposal?.proposal_id,
        snapshot_id: r.snapshot_id || r.workspace_snapshot_id || r.snapshot?.snapshot_id,
        stone_hash: r.stone_hash,
        accepted_state_authority: r.accepted_state_authority === true ? true : false,
        console_grants_no_new_authority: true
      });
      if (els.proposeForm) els.proposeForm.classList.add('hidden');
      toast(r.ok ? 'Proposal submitted (no HEAD move)' : (r.error || 'Propose failed'));
    } catch (err) {
      showDetail('Propose failed', err.payload || { error: err.message });
      toast(err.message || 'Propose failed — fail closed');
    } finally {
      busy(els.proposeConfirm, false, 'Confirm propose');
    }
  }

  els.sessionId?.addEventListener('change', persistInputs);
  els.workspaceCap?.addEventListener('input', persistInputs);
  els.load?.addEventListener('click', loadView);
  els.invite?.addEventListener('click', inviteAgent);
  els.send?.addEventListener('click', sendMessage);
  els.checkpoints?.addEventListener('click', listCheckpoints);
  els.viewWork?.addEventListener('click', viewWork);
  els.propose?.addEventListener('click', openProposeForm);
  els.proposeConfirm?.addEventListener('click', confirmPropose);
  els.proposeCancel?.addEventListener('click', () => {
    els.proposeForm?.classList.add('hidden');
    toast('Propose cancelled');
  });

  setActionsEnabled(false);
}
