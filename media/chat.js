(function () {
  const vscode = acquireVsCodeApi();
  const transcript = document.getElementById('transcript');
  const composer = document.getElementById('composer');
  const promptInput = document.getElementById('prompt');
  const status = document.getElementById('status');
  const connection = document.getElementById('connection');
  const composerHint = document.getElementById('composer-hint');
  const newThreadButton = document.getElementById('new-thread-button');
  const findThreadButton = document.getElementById('find-thread-button');
  const findBar = document.getElementById('find-bar');
  const findInput = document.getElementById('find-input');
  const findCount = document.getElementById('find-count');
  const findPrevButton = document.getElementById('find-prev-button');
  const findNextButton = document.getElementById('find-next-button');
  const findCloseButton = document.getElementById('find-close-button');
  const threadList = document.getElementById('thread-list');
  const submitButtons = Array.from(composer.querySelectorAll('[data-submit-action]'));
  const chatSubmitButton = composer.querySelector('[data-submit-action="chat"]');
  const currentFileDetail = document.getElementById('current-file-detail');
  const selectionDetail = document.getElementById('selection-detail');
  const workspaceDetail = document.getElementById('workspace-detail');
  const problemsDetail = document.getElementById('problems-detail');
  const contextButtons = Array.from(document.querySelectorAll('[data-context-target]'));
  const pendingEditSection = document.getElementById('pending-edit');
  const pendingEditPath = document.getElementById('pending-edit-path');
  const pendingEditSummary = document.getElementById('pending-edit-summary');
  const pendingEditStats = document.getElementById('pending-edit-stats');
  const pendingEditFiles = document.getElementById('pending-edit-files');
  const pendingEditButtons = Array.from(document.querySelectorAll('[data-pending-edit-action]'));
  const pendingCommandSection = document.getElementById('pending-command');
  const pendingCommandSummary = document.getElementById('pending-command-summary');
  const pendingCommandText = document.getElementById('pending-command-text');
  const pendingCommandCwd = document.getElementById('pending-command-cwd');
  const pendingCommandButtons = Array.from(
    document.querySelectorAll('[data-pending-command-action]')
  );
  const taskHistorySection = document.getElementById('task-history');
  const taskHistoryTitle = document.getElementById('task-history-title');
  const taskHistoryList = document.getElementById('task-history-list');
  const actionDock = document.getElementById('action-dock');
  const actionDockEyebrow = document.getElementById('action-dock-eyebrow');
  const actionDockTitle = document.getElementById('action-dock-title');
  const actionDockPrimary = document.getElementById('action-dock-primary');
  const actionDockSecondary = document.getElementById('action-dock-secondary');
  const emptyStateTemplate = transcript.querySelector('.empty-state')?.cloneNode(true) || null;

  let activeAssistantBody = null;
  let activeAssistantRaw = '';
  let isBusy = false;
  let composerEnterBehavior = 'cmdIfMultiline';
  let searchMatches = [];
  let activeSearchIndex = -1;
  let persistentStatusText = status ? status.textContent : '';
  let transientStatusTimer = null;
  let currentPendingEdit = null;
  let currentPendingCommand = null;

  function removeEmptyState() {
    const emptyState = transcript.querySelector('.empty-state');
    if (emptyState) {
      emptyState.remove();
    }
  }

  function createMessageShell(role) {
    removeEmptyState();

    const article = document.createElement('article');
    article.className = `message ${role}`;

    const label = document.createElement('p');
    label.className = 'message-role';
    label.textContent =
      role === 'assistant' ? 'Assistant' : role === 'user' ? 'You' : 'Activity';

    const body = document.createElement('div');
    body.className = 'message-text';

    article.appendChild(label);
    article.appendChild(body);
    transcript.appendChild(article);
    transcript.scrollTop = transcript.scrollHeight;

    return { article, body };
  }

  function appendMessage(role, text) {
    const shell = createMessageShell(role);
    renderRichText(shell.body, text);
    refreshSearchMatches(false);
  }

  function startAssistantMessage() {
    const shell = createMessageShell('assistant');
    shell.article.classList.add('streaming');
    shell.body.textContent = '';
    activeAssistantBody = shell.body;
    activeAssistantRaw = '';
  }

  function appendAssistantChunk(text) {
    if (!activeAssistantBody) {
      startAssistantMessage();
    }

    activeAssistantRaw += text;
    activeAssistantBody.textContent = activeAssistantRaw;
    transcript.scrollTop = transcript.scrollHeight;
    refreshSearchMatches(false);
  }

  function finishAssistantMessage() {
    if (!activeAssistantBody) {
      return;
    }

    const article = activeAssistantBody.closest('.message');
    if (!activeAssistantRaw.trim()) {
      article?.remove();
      activeAssistantBody = null;
      activeAssistantRaw = '';
      refreshSearchMatches(false);
      return;
    }

    renderRichText(activeAssistantBody, activeAssistantRaw);
    article?.classList.remove('streaming');
    activeAssistantBody = null;
    activeAssistantRaw = '';
    transcript.scrollTop = transcript.scrollHeight;
    refreshSearchMatches(false);
  }

  function renderRichText(container, text) {
    container.replaceChildren(...buildRichNodes(text));
  }

  function buildRichNodes(text) {
    const nodes = [];
    const codePattern = /```([A-Za-z0-9_-]+)?\n?([\s\S]*?)```/g;
    let lastIndex = 0;
    let match;

    while ((match = codePattern.exec(text)) !== null) {
      appendTextNodes(text.slice(lastIndex, match.index), nodes);

      const pre = document.createElement('pre');
      pre.className = 'message-code';

      if (match[1]) {
        pre.setAttribute('data-language', match[1]);
      }

      const code = document.createElement('code');
      code.textContent = match[2].replace(/\n$/, '');
      pre.appendChild(code);
      nodes.push(pre);
      lastIndex = codePattern.lastIndex;
    }

    appendTextNodes(text.slice(lastIndex), nodes);

    if (nodes.length === 0) {
      const paragraph = document.createElement('p');
      paragraph.className = 'message-paragraph';
      paragraph.textContent = '';
      nodes.push(paragraph);
    }

    return nodes;
  }

  function appendTextNodes(text, nodes) {
    const trimmed = text.trim();
    if (!trimmed) {
      return;
    }

    const blocks = trimmed.split(/\n{2,}/);
    blocks.forEach(function (block) {
      if (!block.trim()) {
        return;
      }

      const lines = block.split('\n');
      if (isBulletList(lines)) {
        nodes.push(buildList(lines, false));
        return;
      }

      if (isOrderedList(lines)) {
        nodes.push(buildList(lines, true));
        return;
      }

      if (isBlockquote(lines)) {
        const quote = document.createElement('blockquote');
        quote.className = 'message-quote';
        appendInlineNodes(quote, lines.map((line) => line.replace(/^\s*>\s?/, '')).join('\n'));
        nodes.push(quote);
        return;
      }

      const paragraph = document.createElement('p');
      paragraph.className = 'message-paragraph';
      appendInlineNodes(paragraph, block);
      nodes.push(paragraph);
    });
  }

  function isBulletList(lines) {
    return lines.every(function (line) {
      return /^\s*[-*]\s+/.test(line);
    });
  }

  function isOrderedList(lines) {
    return lines.every(function (line) {
      return /^\s*\d+\.\s+/.test(line);
    });
  }

  function isBlockquote(lines) {
    return lines.every(function (line) {
      return /^\s*>\s?/.test(line);
    });
  }

  function buildList(lines, ordered) {
    const list = document.createElement(ordered ? 'ol' : 'ul');
    list.className = 'message-list';

    lines.forEach(function (line) {
      const item = document.createElement('li');
      appendInlineNodes(item, line.replace(/^\s*(?:[-*]|\d+\.)\s+/, ''));
      list.appendChild(item);
    });

    return list;
  }

  function appendInlineNodes(container, text) {
    const inlineCodePattern = /`([^`]+)`/g;
    const lines = text.split('\n');

    lines.forEach(function (line, lineIndex) {
      let lastIndex = 0;
      let match;

      while ((match = inlineCodePattern.exec(line)) !== null) {
        if (match.index > lastIndex) {
          container.appendChild(document.createTextNode(line.slice(lastIndex, match.index)));
        }

        const code = document.createElement('code');
        code.className = 'message-inline-code';
        code.textContent = match[1];
        container.appendChild(code);
        lastIndex = match.index + match[0].length;
      }

      if (lastIndex < line.length) {
        container.appendChild(document.createTextNode(line.slice(lastIndex)));
      }

      inlineCodePattern.lastIndex = 0;

      if (lineIndex < lines.length - 1) {
        container.appendChild(document.createElement('br'));
      }
    });
  }

  composer.addEventListener('submit', function (event) {
    event.preventDefault();

    const text = promptInput.value.trim();
    const submitter = event.submitter;
    const submitAction =
      submitter && submitter.dataset ? submitter.dataset.submitAction || 'chat' : 'chat';
    if (!text && submitAction !== 'fixProblems' && submitAction !== 'fixLastFailure') {
      return;
    }

    appendMessage('user', getSubmittedPromptText(text, submitAction));

    vscode.postMessage(
      submitAction === 'edit'
        ? {
            type: 'proposeEdit',
            text
          }
        : submitAction === 'fixProblems'
          ? {
              type: 'fixProblems',
              text
            }
          : submitAction === 'fixLastFailure'
            ? {
                type: 'fixLastFailure',
                text
              }
            : submitAction === 'command'
              ? {
                  type: 'proposeCommand',
                  text
                }
              : {
                  type: 'sendPrompt',
                  text
                }
    );
    promptInput.value = '';
    autoResizePrompt();
  });

  promptInput.addEventListener('keydown', function (event) {
    if (event.key !== 'Enter' || event.shiftKey) {
      return;
    }

    const hasMultipleLines = promptInput.value.includes('\n');
    const shouldRequireModifier =
      composerEnterBehavior === 'cmdIfMultiline' && hasMultipleLines;

    if (shouldRequireModifier && !event.ctrlKey && !event.metaKey) {
      return;
    }

    event.preventDefault();
    composer.requestSubmit(chatSubmitButton || undefined);
  });

  promptInput.addEventListener('input', autoResizePrompt);

  newThreadButton?.addEventListener('click', function () {
    if (isBusy) {
      return;
    }

    vscode.postMessage({ type: 'newThread' });
  });

  threadList?.addEventListener('click', function (event) {
    if (!(event.target instanceof Element) || isBusy) {
      return;
    }

    const threadButton = event.target.closest('[data-thread-id]');
    if (!threadButton) {
      return;
    }

    vscode.postMessage({
      type: 'openThread',
      id: threadButton.getAttribute('data-thread-id')
    });
  });

  findThreadButton?.addEventListener('click', function () {
    openFindBar();
  });

  findInput?.addEventListener('input', function () {
    refreshSearchMatches(true);
  });

  findInput?.addEventListener('keydown', function (event) {
    if (event.key === 'Enter') {
      event.preventDefault();
      stepSearch(event.shiftKey ? -1 : 1);
      return;
    }

    if (event.key === 'Escape') {
      event.preventDefault();
      closeFindBar();
    }
  });

  findPrevButton?.addEventListener('click', function () {
    stepSearch(-1);
  });

  findNextButton?.addEventListener('click', function () {
    stepSearch(1);
  });

  findCloseButton?.addEventListener('click', function () {
    closeFindBar();
  });

  contextButtons.forEach(function (button) {
    button.addEventListener('click', function () {
      const enabled = button.getAttribute('aria-pressed') !== 'true';
      vscode.postMessage({
        type: 'setContextEnabled',
        target: button.dataset.contextTarget,
        enabled
      });
    });
  });

  pendingEditButtons.forEach(function (button) {
    button.addEventListener('click', function () {
      switch (button.dataset.pendingEditAction) {
        case 'preview':
          vscode.postMessage({ type: 'previewPendingEdit' });
          break;
        case 'apply':
          vscode.postMessage({ type: 'applyPendingEdit' });
          break;
        case 'reject':
          vscode.postMessage({ type: 'rejectPendingEdit' });
          break;
      }
    });
  });

  pendingEditFiles.addEventListener('click', function (event) {
    if (!(event.target instanceof Element)) {
      return;
    }

    const previewButton = event.target.closest('[data-preview-pending-edit-file]');
    if (previewButton && !isBusy) {
      vscode.postMessage({
        type: 'previewPendingEditFile',
        path: previewButton.getAttribute('data-preview-pending-edit-file')
      });
      return;
    }

    const openButton = event.target.closest('[data-open-workspace-path]');
    if (openButton && !isBusy) {
      vscode.postMessage({
        type: 'openWorkspacePath',
        path: openButton.getAttribute('data-open-workspace-path')
      });
    }
  });

  pendingCommandButtons.forEach(function (button) {
    button.addEventListener('click', function () {
      switch (button.dataset.pendingCommandAction) {
        case 'run':
          vscode.postMessage({ type: 'runPendingCommand' });
          break;
        case 'reject':
          vscode.postMessage({ type: 'rejectPendingCommand' });
          break;
      }
    });
  });

  taskHistoryList?.addEventListener('click', function (event) {
    if (!(event.target instanceof Element) || isBusy) {
      return;
    }

    const previewButton = event.target.closest('[data-preview-task-path]');
    if (previewButton) {
      vscode.postMessage({
        type: 'previewPendingEditFile',
        path: previewButton.getAttribute('data-preview-task-path')
      });
      return;
    }

    const openButton = event.target.closest('[data-open-workspace-path]');
    if (openButton) {
      vscode.postMessage({
        type: 'openWorkspacePath',
        path: openButton.getAttribute('data-open-workspace-path')
      });
    }
  });

  window.addEventListener('message', function (event) {
    const message = event.data;

    switch (message.type) {
      case 'systemMessage':
        showTransientStatus(message.text);
        break;
      case 'resetTranscript':
        activeAssistantBody = null;
        activeAssistantRaw = '';
        transcript.replaceChildren();
        if (emptyStateTemplate) {
          transcript.appendChild(emptyStateTemplate.cloneNode(true));
        }
        refreshSearchMatches(false);
        break;
      case 'hydrateTranscript':
        message.entries.forEach(function (entry) {
          if (entry.role === 'system') {
            return;
          }
          appendMessage(entry.role, entry.text);
        });
        break;
      case 'showFindInThread':
        openFindBar();
        break;
      case 'assistantStart':
        startAssistantMessage();
        break;
      case 'assistantChunk':
        appendAssistantChunk(message.text);
        break;
      case 'assistantEnd':
        finishAssistantMessage();
        break;
      case 'setStatus':
        persistentStatusText = message.text;
        status.textContent = message.text;
        status.title = message.text;
        break;
      case 'setComposerBehavior':
        composerEnterBehavior = message.behavior;
        syncComposerHint();
        break;
      case 'setConnection':
        connection.textContent = message.text;
        break;
      case 'setThreads':
        syncThreads(message.threads);
        break;
      case 'setTaskHistory':
        syncTaskHistory(message.artifacts);
        break;
      case 'setContextState':
        currentFileDetail.textContent = message.context.currentFile.detail;
        selectionDetail.textContent = message.context.selection.detail;
        workspaceDetail.textContent = message.context.workspace.detail;
        problemsDetail.textContent = message.context.problems.detail;
        syncContextButton('currentFile', message.context.currentFile);
        syncContextButton('selection', message.context.selection);
        syncContextButton('workspace', message.context.workspace);
        syncContextButton('problems', message.context.problems);
        break;
      case 'setPendingEdit':
        syncPendingEdit(message.pendingEdit);
        break;
      case 'setPendingCommand':
        syncPendingCommand(message.pendingCommand);
        break;
      case 'setBusy':
        isBusy = message.busy;
        if (newThreadButton) {
          newThreadButton.disabled = message.busy;
        }
        contextButtons.forEach(function (button) {
          button.disabled = message.busy;
        });
        pendingEditButtons.forEach(function (button) {
          button.disabled = message.busy;
        });
        syncPendingEditPreviewButtonsDisabled(message.busy);
        pendingCommandButtons.forEach(function (button) {
          button.disabled = message.busy;
        });
        syncActionDock();
        threadList
          ?.querySelectorAll('[data-thread-id]')
          .forEach(function (button) {
            button.disabled = message.busy;
          });
        if (!message.busy) {
          promptInput.focus();
        }
        break;
    }
  });

  vscode.postMessage({ type: 'ready' });
  syncComposerHint();
  autoResizePrompt();

  function getSubmittedPromptText(text, submitAction) {
    if (text) {
      return text;
    }

    switch (submitAction) {
      case 'fixProblems':
        return 'Fix current workspace problems';
      case 'fixLastFailure':
        return 'Fix last terminal failure';
      default:
        return '';
    }
  }

  function syncComposerHint() {
    if (!composerHint) {
      return;
    }

    composerHint.textContent =
      composerEnterBehavior === 'enter'
        ? 'Enter sends. Shift+Enter adds a new line.'
        : 'Enter sends for single-line prompts. Shift+Enter adds a new line. Ctrl+Enter or Cmd+Enter sends multiline prompts.';
  }

  function autoResizePrompt() {
    promptInput.style.height = 'auto';
    promptInput.style.height = `${Math.min(Math.max(promptInput.scrollHeight, 116), 280)}px`;
  }

  function syncContextButton(target, state) {
    const button = contextButtons.find(function (candidate) {
      return candidate.dataset.contextTarget === target;
    });

    if (!button) {
      return;
    }

    button.setAttribute('aria-pressed', String(state.enabled));
    button.classList.toggle('active', state.enabled);
    button.classList.toggle('unavailable', !state.available);
  }

  function syncPendingEdit(pendingEdit) {
    currentPendingEdit = pendingEdit;
    if (!pendingEdit) {
      pendingEditSection.classList.add('hidden');
      pendingEditPath.textContent = 'No pending edit';
      pendingEditSummary.textContent = '';
      pendingEditStats.textContent = '';
      pendingEditFiles.replaceChildren();
      syncActionDock();
      return;
    }

    pendingEditSection.classList.remove('hidden');
    pendingEditPath.textContent = pendingEdit.title;
    pendingEditSummary.textContent = pendingEdit.summary;
    pendingEditStats.textContent = pendingEdit.statsText;
    pendingEditFiles.replaceChildren(
      ...pendingEdit.files.map(function (file) {
        const row = document.createElement('div');
        row.className = 'pending-edit-file';

        const meta = document.createElement('div');
        meta.className = 'pending-edit-file-meta';

        const path = document.createElement('p');
        path.className = 'pending-edit-file-path';
        path.textContent = file.path;

        const stats = document.createElement('p');
        stats.className = 'pending-edit-file-stats';
        stats.textContent = file.statsText;

        meta.appendChild(path);
        meta.appendChild(stats);

        const actions = document.createElement('div');
        actions.className = 'pending-edit-file-actions';

        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'subtle pending-edit-file-preview';
        button.textContent = 'Preview';
        button.disabled = isBusy;
        button.setAttribute('data-preview-pending-edit-file', file.path);

        const openButton = document.createElement('button');
        openButton.type = 'button';
        openButton.className = 'subtle pending-edit-file-preview';
        openButton.textContent = 'Open';
        openButton.disabled = isBusy;
        openButton.setAttribute('data-open-workspace-path', file.path);

        actions.appendChild(button);
        actions.appendChild(openButton);

        row.appendChild(meta);
        row.appendChild(actions);
        return row;
      })
    );
    syncActionDock();
  }

  function syncPendingCommand(pendingCommand) {
    currentPendingCommand = pendingCommand;
    if (!pendingCommand) {
      pendingCommandSection.classList.add('hidden');
      pendingCommandSummary.textContent = 'No pending terminal command';
      pendingCommandText.textContent = '';
      pendingCommandCwd.textContent = '';
      syncActionDock();
      return;
    }

    pendingCommandSection.classList.remove('hidden');
    pendingCommandSummary.textContent = pendingCommand.summary;
    pendingCommandText.textContent = pendingCommand.command;
    pendingCommandCwd.textContent = `Run from: ${pendingCommand.cwdLabel}`;
    syncActionDock();
  }

  function syncActionDock() {
    if (
      !actionDock ||
      !actionDockEyebrow ||
      !actionDockTitle ||
      !actionDockPrimary ||
      !actionDockSecondary
    ) {
      return;
    }

    if (currentPendingEdit) {
      actionDock.classList.remove('hidden');
      actionDockEyebrow.textContent = 'Pending Edit';
      actionDockTitle.textContent = currentPendingEdit.title;
      actionDockPrimary.textContent = 'Apply';
      actionDockPrimary.disabled = isBusy;
      actionDockPrimary.onclick = function () {
        vscode.postMessage({ type: 'applyPendingEdit' });
      };
      actionDockSecondary.textContent = 'Preview';
      actionDockSecondary.disabled = isBusy;
      actionDockSecondary.onclick = function () {
        vscode.postMessage({ type: 'previewPendingEdit' });
      };
      return;
    }

    if (currentPendingCommand) {
      actionDock.classList.remove('hidden');
      actionDockEyebrow.textContent = 'Pending Command';
      actionDockTitle.textContent = currentPendingCommand.summary;
      actionDockPrimary.textContent = 'Run';
      actionDockPrimary.disabled = isBusy;
      actionDockPrimary.onclick = function () {
        vscode.postMessage({ type: 'runPendingCommand' });
      };
      actionDockSecondary.textContent = 'Reject';
      actionDockSecondary.disabled = isBusy;
      actionDockSecondary.onclick = function () {
        vscode.postMessage({ type: 'rejectPendingCommand' });
      };
      return;
    }

    actionDock.classList.add('hidden');
    actionDockEyebrow.textContent = 'Quick Actions';
    actionDockTitle.textContent = 'No pending action';
    actionDockPrimary.onclick = null;
    actionDockSecondary.onclick = null;
  }

  function syncTaskHistory(artifacts) {
    if (!taskHistorySection || !taskHistoryTitle || !taskHistoryList) {
      return;
    }

    if (!artifacts || artifacts.length === 0) {
      taskHistorySection.classList.add('hidden');
      taskHistoryTitle.textContent = 'No recent runs';
      taskHistoryList.replaceChildren();
      return;
    }

    taskHistorySection.classList.remove('hidden');
    taskHistoryTitle.textContent =
      artifacts.length === 1 ? '1 recent item' : `${artifacts.length} recent items`;
    taskHistoryList.replaceChildren(
      ...artifacts.map(function (artifact) {
        const card = document.createElement('article');
        card.className = `task-card ${artifact.kind} ${artifact.status}`;

        const meta = document.createElement('div');
        meta.className = 'task-card-meta';

        const badge = document.createElement('p');
        badge.className = 'task-card-badge';
        badge.textContent = `${formatTaskKind(artifact.kind)} · ${formatTaskStatus(artifact.status)}`;

        const time = document.createElement('p');
        time.className = 'task-card-time';
        time.textContent = formatTaskTime(artifact.timestamp);

        meta.appendChild(badge);
        meta.appendChild(time);

        const title = document.createElement('p');
        title.className = 'task-card-title';
        title.textContent = artifact.title;

        const detail = document.createElement('p');
        detail.className = 'task-card-detail';
        detail.textContent = artifact.detail;

        card.appendChild(meta);
        card.appendChild(title);
        card.appendChild(detail);

        if (Array.isArray(artifact.targets) && artifact.targets.length > 0) {
          const targets = document.createElement('div');
          targets.className = 'task-card-target-list';

          artifact.targets.forEach(function (targetPath) {
            const row = document.createElement('div');
            row.className = 'task-card-target-row';

            const path = document.createElement('p');
            path.className = 'task-card-targets';
            path.textContent = targetPath;

            const actions = document.createElement('div');
            actions.className = 'task-card-target-actions';

            if (hasPendingPreviewForPath(targetPath)) {
              const preview = document.createElement('button');
              preview.type = 'button';
              preview.className = 'subtle task-card-target-button';
              preview.textContent = 'Preview';
              preview.disabled = isBusy;
              preview.setAttribute('data-preview-task-path', targetPath);
              actions.appendChild(preview);
            }

            const open = document.createElement('button');
            open.type = 'button';
            open.className = 'subtle task-card-target-button';
            open.textContent = 'Open';
            open.disabled = isBusy;
            open.setAttribute('data-open-workspace-path', targetPath);
            actions.appendChild(open);

            row.appendChild(path);
            row.appendChild(actions);
            targets.appendChild(row);
          });

          card.appendChild(targets);
        }

        if (artifact.command) {
          const command = document.createElement('pre');
          command.className = 'task-card-command';
          command.textContent = artifact.command;
          card.appendChild(command);
        }

        return card;
      })
    );
  }

  function formatTaskKind(kind) {
    switch (kind) {
      case 'edit':
        return 'Edit';
      case 'command':
        return 'Command';
      case 'failure':
        return 'Failure';
      case 'verification':
        return 'Verification';
      default:
        return 'Task';
    }
  }

  function formatTaskStatus(statusValue) {
    switch (statusValue) {
      case 'pending':
        return 'Pending';
      case 'queued':
        return 'Queued';
      case 'running':
        return 'Running';
      case 'applied':
        return 'Applied';
      case 'rejected':
        return 'Rejected';
      case 'failed':
        return 'Failed';
      case 'succeeded':
        return 'Succeeded';
      default:
        return statusValue || 'Unknown';
    }
  }

  function formatTaskTime(timestamp) {
    if (!timestamp) {
      return '';
    }

    try {
      return new Date(timestamp).toLocaleTimeString([], {
        hour: '2-digit',
        minute: '2-digit'
      });
    } catch {
      return '';
    }
  }

  function hasPendingPreviewForPath(path) {
    if (!currentPendingEdit || !Array.isArray(currentPendingEdit.files)) {
      return false;
    }

    return currentPendingEdit.files.some(function (file) {
      return normalizeWorkspacePath(file.path) === normalizeWorkspacePath(path);
    });
  }

  function normalizeWorkspacePath(path) {
    return String(path || '').replace(/\\/g, '/').toLowerCase();
  }

  function syncPendingEditPreviewButtonsDisabled(disabled) {
    pendingEditFiles
      .querySelectorAll('[data-preview-pending-edit-file]')
      .forEach(function (button) {
        button.disabled = disabled;
      });
  }

  function syncThreads(threads) {
    if (!threadList) {
      return;
    }

    threadList.replaceChildren(
      ...threads.map(function (thread) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'thread-card';
        if (thread.active) {
          button.classList.add('active');
        }
        button.disabled = isBusy;
        button.setAttribute('data-thread-id', thread.id);

        const title = document.createElement('p');
        title.className = 'thread-card-title';
        title.textContent = thread.title;

        const preview = document.createElement('p');
        preview.className = 'thread-card-preview';
        preview.textContent = thread.preview;

        button.appendChild(title);
        button.appendChild(preview);
        return button;
      })
    );
  }

  function openFindBar() {
    if (!findBar || !findInput) {
      return;
    }

    findBar.classList.remove('hidden');
    refreshSearchMatches(false);
    findInput.focus();
    findInput.select();
  }

  function closeFindBar() {
    if (!findBar || !findInput) {
      return;
    }

    findBar.classList.add('hidden');
    findInput.value = '';
    refreshSearchMatches(false);
    promptInput.focus();
  }

  function refreshSearchMatches(scrollToCurrent) {
    if (!findBar || !findInput) {
      return;
    }

    const query = findInput.value.trim().toLowerCase();
    const messages = Array.from(transcript.querySelectorAll('.message'));
    messages.forEach(function (message) {
      message.classList.remove('search-hit', 'search-hit-current');
    });

    if (!query) {
      searchMatches = [];
      activeSearchIndex = -1;
      syncSearchCount();
      return;
    }

    searchMatches = messages.filter(function (message) {
      return (message.textContent || '').toLowerCase().includes(query);
    });

    if (searchMatches.length === 0) {
      activeSearchIndex = -1;
      syncSearchCount();
      return;
    }

    if (activeSearchIndex < 0 || activeSearchIndex >= searchMatches.length) {
      activeSearchIndex = 0;
    }

    searchMatches.forEach(function (message) {
      message.classList.add('search-hit');
    });
    activateSearchMatch(activeSearchIndex, scrollToCurrent);
  }

  function stepSearch(direction) {
    if (searchMatches.length === 0) {
      refreshSearchMatches(true);
      return;
    }

    activeSearchIndex =
      (activeSearchIndex + direction + searchMatches.length) % searchMatches.length;
    activateSearchMatch(activeSearchIndex, true);
  }

  function activateSearchMatch(index, scrollToCurrent) {
    searchMatches.forEach(function (message, messageIndex) {
      message.classList.toggle('search-hit-current', messageIndex === index);
    });

    syncSearchCount();

    if (!scrollToCurrent || index < 0 || index >= searchMatches.length) {
      return;
    }

    searchMatches[index].scrollIntoView({
      block: 'center',
      behavior: 'smooth'
    });
  }

  function syncSearchCount() {
    if (!findCount) {
      return;
    }

    if (searchMatches.length === 0) {
      findCount.textContent = '0 / 0';
      return;
    }

    findCount.textContent = `${activeSearchIndex + 1} / ${searchMatches.length}`;
  }

  function showTransientStatus(text) {
    if (!status || !text) {
      return;
    }

    if (transientStatusTimer) {
      clearTimeout(transientStatusTimer);
    }

    status.textContent = text.length > 44 ? `${text.slice(0, 43)}…` : text;
    status.title = text;
    transientStatusTimer = setTimeout(function () {
      status.textContent = persistentStatusText;
      status.title = persistentStatusText;
      transientStatusTimer = null;
    }, 4000);
  }
})();
