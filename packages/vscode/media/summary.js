// @ts-check
// The documentation editor (src/docEditor.ts renders the data, this script the page).
// - DOM APIs only (textContent), so descriptions cannot inject markup.
// - Text fields save on blur, Ctrl/Cmd+Enter, or when the panel loses focus. Escape reverts.
// - A re-render (after a save, or when the manifest changes) keeps unsaved text, focus and cursor.
(function () {
  // eslint-disable-next-line no-undef
  const vscode = acquireVsCodeApi();
  const app = /** @type {HTMLElement} */ (document.getElementById('app'));
  const isPanel = document.body.classList.contains('host-panel');
  const saved = vscode.getState() || {};
  let filter = saved.filter || 'all';
  /** @type {any} */
  let last;
  /** @type {string|undefined} */
  let modelId;
  let status = '';
  /** @type {ReturnType<typeof setTimeout>|undefined} */
  let statusTimer;
  /** True while the page is rebuilt: removing a focused field fires "blur", which must not save. */
  let rendering = false;

  /**
   * @param {string} tag
   * @param {Record<string, any>} [attrs]
   * @param {(Node|string|null|undefined|false)[]} [children]
   */
  function h(tag, attrs, children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'class') el.className = v;
      else if (k === 'width') el.style.width = v; // CSSOM: allowed by the content security policy
      else if (k === 'value') /** @type {HTMLTextAreaElement} */ (el).value = v;
      else el.setAttribute(k, String(v));
    }
    for (const c of children || []) {
      if (c === undefined || c === null || c === false) continue;
      el.append(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return el;
  }

  const post = (/** @type {any} */ m) => vscode.postMessage(m);
  const open = (/** @type {{file: string, offset: number}|undefined} */ loc) => loc && post({ type: 'open', file: loc.file, offset: loc.offset });
  const action = (/** @type {string} */ a, /** @type {string} */ column) => post({ type: 'action', action: a, column });

  /** @param {string} label @param {string} title @param {() => void} fn @param {string} [cls] */
  function button(label, title, fn, cls) {
    return h('button', { class: cls || 'secondary', title, onclick: (/** @type {Event} */ e) => { e.stopPropagation(); fn(); } }, [label]);
  }
  /** @param {string} label @param {string} title @param {() => void} fn */
  function link(label, title, fn) {
    return h('a', { href: '#', title, onclick: (/** @type {Event} */ e) => { e.preventDefault(); e.stopPropagation(); fn(); } }, [label]);
  }

  // ---------------------------------------------------------------------------
  // Editable text fields

  /**
   * A text field bound to a save message.
   * @param {string} key unique key, used to keep drafts across re-renders
   * @param {string} value the saved value
   * @param {string} placeholder
   * @param {(value: string) => any} message builds the save message
   * @param {string} label accessible label
   */
  function field(key, value, placeholder, message, label) {
    const ta = /** @type {HTMLTextAreaElement} */ (
      h('textarea', {
        rows: 1,
        placeholder,
        'aria-label': label,
        'data-key': key,
        'data-original': value,
        spellcheck: 'true',
        value,
        oninput: () => grow(ta),
        onblur: () => commit(ta),
        onkeydown: (/** @type {KeyboardEvent} */ e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            commit(ta);
          } else if (e.key === 'Enter' && !e.shiftKey && !ta.value.includes('\n')) {
            // Single-line text: Enter saves and moves on. Shift+Enter adds a line.
            e.preventDefault();
            commit(ta);
            focusNext(ta);
          } else if (e.key === 'Escape') {
            ta.value = ta.getAttribute('data-original') || '';
            grow(ta);
            ta.blur();
          }
        },
      })
    );
    /** @type {any} */ (ta).saveMessage = message;
    return ta;
  }

  /**
   * A small text input for the column's data_type.
   * @param {any} col
   */
  function typeField(col) {
    const t = col.suggestedType;
    const from = t ? (t.source === 'warehouse' ? 'the warehouse' : t.source === 'cast' ? 'a cast in the SQL' : t.source === 'seed' ? 'seed column_types' : t.from) : '';
    const input = /** @type {HTMLInputElement} */ (
      h('input', {
        type: 'text',
        class: `type-input${col.typeMismatch ? ' mismatch' : ''}`,
        'data-key': `type:${col.name}`,
        'data-original': col.dataType || '',
        value: col.dataType || '',
        placeholder: t ? t.type.toLowerCase() : 'data type',
        size: Math.max(6, (col.dataType || (t && t.type) || 'data type').length + 1),
        'aria-label': `Data type of ${col.name}`,
        title: col.typeMismatch
          ? `data_type is ${col.typeMismatch.yaml}, but the column is ${col.typeMismatch.warehouse} in the warehouse`
          : col.dataType
            ? `data_type in YAML${t ? ` (known type: ${t.type}, from ${from})` : ''}`
            : t
              ? `Not set in YAML. Known type: ${t.type}, from ${from}. Type it, or press Enter to use it.`
              : 'Not set in YAML',
        spellcheck: 'false',
        onblur: () => commit(/** @type {any} */ (input)),
        onkeydown: (/** @type {KeyboardEvent} */ e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            if (!input.value && t) input.value = t.type.toLowerCase();
            commit(/** @type {any} */ (input));
          } else if (e.key === 'Escape') {
            input.value = input.getAttribute('data-original') || '';
            input.blur();
          }
        },
      })
    );
    /** @type {any} */ (input).saveMessage = (/** @type {string} */ value) => ({ type: 'saveType', column: col.name, value });
    return input;
  }

  /** @param {HTMLTextAreaElement} ta */
  function grow(ta) {
    if (ta.tagName !== 'TEXTAREA') return;
    ta.style.height = 'auto';
    ta.style.height = `${ta.scrollHeight + 2}px`;
  }

  /** @param {HTMLTextAreaElement} ta */
  function commit(ta) {
    if (rendering) return;
    const original = ta.getAttribute('data-original') || '';
    if (ta.value.trim() === original.trim()) return;
    ta.setAttribute('data-original', ta.value);
    ta.classList.add('saving');
    setStatus('Saving\u2026');
    post(/** @type {any} */ (ta).saveMessage(ta.value));
  }

  /** @param {HTMLTextAreaElement} ta */
  function focusNext(ta) {
    const all = /** @type {HTMLTextAreaElement[]} */ ([...document.querySelectorAll('textarea')]);
    const next = all[all.indexOf(ta) + 1];
    if (next) next.focus();
  }

  function commitAll() {
    for (const ta of /** @type {NodeListOf<HTMLTextAreaElement>} */ (document.querySelectorAll('[data-key]'))) commit(ta);
  }

  /** @param {string} text */
  function setStatus(text) {
    status = text;
    const el = document.getElementById('status');
    if (el) el.textContent = text;
    if (statusTimer) clearTimeout(statusTimer);
    if (text && text !== 'Saving\u2026') statusTimer = setTimeout(() => setStatus(''), 4000);
  }

  // ---------------------------------------------------------------------------
  // Sections

  const STATUS = {
    documented: { label: 'Documented', cls: 'documented' },
    inheritable: { label: 'Can be inherited', cls: 'inheritable' },
    missing: { label: 'Missing', cls: 'missing' },
  };
  const SOURCE = {
    manifest: 'not in YAML',
    catalog: 'in the warehouse, not in YAML',
    sql: 'from the SQL, not in YAML',
  };

  /** @param {string} f */
  const fileName = (f) => f.split('/').pop() || f;

  /** @param {any} s */
  function header(s) {
    const meta = [s.kind, s.materialized, s.layer && s.layer !== 'other' ? s.layer : undefined].filter(Boolean);
    return h('header', {}, [
      h('div', { class: 'title-row' }, [
        h('h1', { title: s.uniqueId }, [s.label]),
        h('span', { class: 'chips' }, meta.map((m) => h('span', { class: 'chip' }, [m]))),
        h('span', { id: 'status', class: 'status', role: 'status', 'aria-live': 'polite' }, [status]),
      ]),
      h('div', { class: 'file-links' }, [
        s.locations.source && link(fileName(s.locations.source.file), s.locations.source.file, () => open(s.locations.source)),
        s.locations.yaml
          ? link(fileName(s.locations.yaml.file), s.locations.yaml.file, () => open(s.locations.yaml))
          : h('span', { class: 'muted' }, ['no YAML yet: it is created when you write']),
      ]),
      s.tags.length || s.owner
        ? h('div', { class: 'muted small' }, [s.owner ? `Owner: ${s.owner}` : '', s.owner && s.tags.length ? ' \u00b7 ' : '', s.tags.length ? `Tags: ${s.tags.join(', ')}` : ''])
        : null,
    ]);
  }

  /** @param {any} s */
  function modelDescription(s) {
    const editable = s.kind !== 'source' || !!s.locations.yaml;
    const act = (/** @type {string} */ a) => post({ type: 'action', action: a });
    /** @type {(Node|null|false)[]} */
    const extras = [];
    let input;
    if (s.docBlock && editable) {
      // The description is a doc block: edit the block's text (for every description that uses it).
      input = field(`modelblock:${s.docBlock}`, s.description || '', 'Text of the doc block\u2026', (value) => ({ type: 'saveBlock', block: s.docBlock, value }), `Doc block ${s.docBlock}`);
      extras.push(
        h('span', { class: 'muted small' }, [`Doc block ${s.docBlock}`, s.docBlockUsages > 1 ? ` \u00b7 used by ${s.docBlockUsages} descriptions, edits change all of them` : '']),
        link('Unlink', 'Copy the text into this model so it can be changed here only', () => act('unlinkModel')),
        link('Link to another doc block\u2026', 'Use another doc block', () => act('linkModel')),
      );
    } else if (editable) {
      input = field(`model:${s.uniqueId}`, s.rawDescription || '', `Describe ${s.label}\u2026`, (value) => ({ type: 'save', target: 'model', value }), `Description of ${s.label}`);
      if (s.locations.yaml) {
        extras.push(link('Link to doc block\u2026', 'Use an existing doc block', () => act('linkModel')));
        if ((s.rawDescription || '').trim()) extras.push(link('Move to doc block\u2026', 'Move the text to a doc block that can be reused', () => act('moveModel')));
      }
    } else {
      input = h('p', {}, [s.description]);
    }
    return h('section', { class: 'model-description' }, [h('h2', {}, ['Description']), input, extras.length ? h('div', { class: 'actions row-actions' }, extras) : null]);
  }

  /**
   * The compact overview in the side bar: status of the model and a button to the editor tab.
   * @param {any} m
   */
  function overview(m) {
    const s = m.summary;
    const c = s.counts;
    const total = Math.max(1, c.columns);
    const pct = (/** @type {number} */ n) => `${(100 * n) / total}%`;
    const todo = s.columns.filter((/** @type {any} */ col) => col.status !== 'documented');
    const meta = [s.kind, s.materialized, s.layer && s.layer !== 'other' ? s.layer : undefined].filter(Boolean);
    const hasDescription = !!(s.description && s.description.trim());
    const text = hasDescription ? (s.description.length > 220 ? `${s.description.slice(0, 219)}\u2026` : s.description) : '';
    const facts = [
      c.typesToSet + c.typeMismatches > 0 ? `${c.typesToSet + c.typeMismatches} data type${c.typesToSet + c.typeMismatches === 1 ? '' : 's'} to set` : '',
      `${s.upstream.length} upstream`,
      `${s.downstream.length} downstream`,
    ].filter(Boolean);
    return h('div', { class: 'overview' }, [
      m.stale ? h('p', { class: 'banner' }, ['manifest.json is out of date.']) : '',
      h('div', { class: 'title-row' }, [
        h('h1', { title: s.uniqueId }, [s.label]),
        h('span', { class: 'chips' }, meta.map((x) => h('span', { class: 'chip small' }, [x]))),
      ]),
      hasDescription
        ? h('p', { class: 'overview-description', title: s.description }, [text])
        : h('p', { class: 'warning' }, ['No description yet.']),
      h('div', { class: 'bar', role: 'img', 'aria-label': `${c.documented} documented, ${c.inheritable} inheritable, ${c.missing} missing` }, [
        h('span', { class: 'documented', width: pct(c.documented) }),
        h('span', { class: 'inheritable', width: pct(c.inheritable) }),
        h('span', { class: 'missing', width: pct(c.missing) }),
      ]),
      h('p', { class: 'muted small' }, [
        `${c.documented}/${c.columns} columns documented`,
        c.inheritable ? ` \u00b7 ${c.inheritable} can inherit` : '',
        c.missing ? ` \u00b7 ${c.missing} missing` : '',
      ]),
      todo.length > 0
        ? h('p', { class: 'small todo' }, [
            h('span', { class: 'muted' }, ['To do: ']),
            todo.slice(0, 6).map((/** @type {any} */ col) => col.name).join(', '),
            todo.length > 6 ? ` +${todo.length - 6}` : '',
          ])
        : h('p', { class: 'small' }, ['Every column is documented.']),
      h('p', { class: 'muted small' }, [facts.join(' \u00b7 ')]),
      h('button', { class: 'primary wide', onclick: () => post({ type: 'openPanel' }) }, ['Edit documentation']),
    ]);
  }

  /** @param {any} s */
  function coverage(s) {
    const c = s.counts;
    const total = Math.max(1, c.columns);
    const pct = (/** @type {number} */ n) => `${(100 * n) / total}%`;
    const safe = s.columns.filter((/** @type {any} */ col) => col.inherit && col.inherit.safe && col.source === 'yaml').length;
    const catalogOnly = s.columns.filter((/** @type {any} */ col) => col.source === 'catalog').length;
    return h('section', { class: 'coverage' }, [
      h('div', { class: 'bar', role: 'img', 'aria-label': `${c.documented} documented, ${c.inheritable} inheritable, ${c.missing} missing` }, [
        h('span', { class: 'documented', width: pct(c.documented) }),
        h('span', { class: 'inheritable', width: pct(c.inheritable) }),
        h('span', { class: 'missing', width: pct(c.missing) }),
      ]),
      h('div', { class: 'legend' }, [
        h('span', {}, [h('i', { class: 'dot documented' }), ` ${c.documented} documented`]),
        h('span', {}, [h('i', { class: 'dot inheritable' }), ` ${c.inheritable} can inherit`]),
        h('span', {}, [h('i', { class: 'dot missing' }), ` ${c.missing} missing`]),
      ]),
      safe > 0 || (catalogOnly > 0 && s.locations.yaml) || c.typesToSet + c.typeMismatches > 0
        ? h('div', { class: 'actions' }, [
            safe > 0 && button(`Inherit ${safe} safe`, 'Write all descriptions that are passed through unchanged from a single upstream column', () => post({ type: 'action', action: 'inheritAll' }), 'primary'),
            c.typesToSet + c.typeMismatches > 0 &&
              button(
                `Set ${c.typesToSet + c.typeMismatches} data type${c.typesToSet + c.typeMismatches === 1 ? '' : 's'}`,
                `Write data_type for columns where the type is known (warehouse, casts, seed column_types, upstream)${c.typeMismatches ? `, and fix ${c.typeMismatches} that differ from the warehouse` : ''}`,
                () => post({ type: 'action', action: 'setAllTypes' }),
              ),
            catalogOnly > 0 && s.locations.yaml && button(`Add ${catalogOnly} column${catalogOnly === 1 ? '' : 's'} to YAML`, 'Columns in the warehouse (catalog.json) that are not in YAML', () => post({ type: 'action', action: 'addColumns' })),
          ])
        : null,
    ]);
  }

  /** @param {any} col @param {any} s @param {boolean} ai */
  function columnRow(col, s, ai) {
    const st = STATUS[/** @type {'documented'|'inheritable'|'missing'} */ (col.status)];
    const inYaml = col.source === 'yaml';
    const editable = s.kind !== 'source' || inYaml;
    const save = (/** @type {string} */ value) => ({ type: 'save', target: 'column', column: col.name, value });

    let input;
    if (col.docBlock && inYaml) {
      // Edit the shared block's text; it changes every column that uses it.
      input = field(`block:${col.docBlock}:${col.name}`, col.description || '', 'Text of the doc block\u2026', (value) => ({ type: 'saveBlock', block: col.docBlock, value }), `Doc block ${col.docBlock}`);
    } else if (editable) {
      const placeholder = col.inherit ? `\u21b3 ${col.inherit.from}: ${col.inherit.description}` : `Describe ${col.name}\u2026`;
      input = field(`col:${col.name}`, col.rawDescription || '', placeholder, save, `Description of ${col.name}`);
    } else {
      input = h('p', { class: 'muted' }, [col.description || 'No description.']);
    }

    const extras = [];
    if (col.docBlock && inYaml) {
      extras.push(
        h('span', { class: 'muted small' }, [`Doc block ${col.docBlock}`, col.docBlockUsages > 1 ? ` \u00b7 used by ${col.docBlockUsages} columns, edits change all of them` : '']),
        link('Unlink', 'Copy the text into this column so it can be changed here only', () => action('unlink', col.name)),
      );
    }
    if (col.status !== 'documented' && col.inherit && editable) {
      extras.push(
        button(
          `Use \u21b3 ${col.inherit.from}${col.inherit.fromColumn !== col.name ? `.${col.inherit.fromColumn}` : ''}`,
          `${col.inherit.docBlock ? `Link to the same doc block (${col.inherit.docBlock})` : `Copy: ${col.inherit.description}`}${col.inherit.kind !== 'passthrough' ? ` \u2014 the column is ${col.inherit.kind}, check that the text fits` : ''}`,
          () => (inYaml ? action('inherit', col.name) : post(save(col.inherit.docBlock ? `{{ doc('${col.inherit.docBlock}') }}` : col.inherit.description))),
          col.inherit.safe ? 'primary' : 'secondary',
        ),
      );
      if (col.inherit.kind !== 'passthrough') extras.push(h('span', { class: 'muted small' }, [col.inherit.kind]));
    }
    if (ai && col.status !== 'documented' && inYaml) extras.push(button('AI', 'Suggest a description with AI', () => action('ai', col.name)));
    if (inYaml && !col.docBlock) {
      extras.push(link('Link to doc block\u2026', 'Use an existing doc block', () => action('link', col.name)));
      if (col.status === 'documented') extras.push(link('Move to doc block\u2026', 'Move the text to a doc block that other models can use', () => action('move', col.name)));
    }

    return h('li', { class: `column ${st.cls}` }, [
      h('div', { class: 'col-head' }, [
        h('i', { class: `dot ${inYaml ? st.cls : 'notinyaml'}`, title: inYaml ? st.label : SOURCE[/** @type {'manifest'} */ (col.source)] }),
        col.location
          ? link(col.name, 'Show in YAML', () => open(col.location))
          : h('span', { class: 'col-name' }, [col.name]),
        editable ? typeField(col) : (col.dataType || col.suggestedType) && h('span', { class: 'type' }, [(col.dataType || col.suggestedType.type).toLowerCase()]),
        col.typeMismatch && editable && button(`Use ${col.typeMismatch.warehouse.toLowerCase()}`, 'Set data_type to the type in the warehouse', () => post({ type: 'saveType', column: col.name, value: col.typeMismatch.warehouse })),
        !inYaml && h('span', { class: 'muted small' }, [SOURCE[/** @type {'manifest'} */ (col.source)]]),
      ]),
      input,
      extras.length ? h('div', { class: 'actions row-actions' }, extras) : null,
    ]);
  }

  /** @param {any} s @param {boolean} ai */
  function columns(s, ai) {
    const needs = s.columns.filter((/** @type {any} */ c) => c.status !== 'documented');
    const shown = filter === 'needs' ? needs : s.columns;
    const tab = (/** @type {string} */ id, /** @type {string} */ label) =>
      h('button', { class: `tab ${filter === id ? 'active' : ''}`, 'aria-pressed': filter === id, onclick: () => { filter = id; vscode.setState({ filter }); render(last); } }, [label]);
    return h('section', {}, [
      h('div', { class: 'section-head' }, [h('h2', {}, ['Columns']), h('span', { class: 'tabs' }, [tab('all', `All ${s.columns.length}`), tab('needs', `To do ${needs.length}`)])]),
      shown.length === 0
        ? h('p', { class: 'muted' }, [s.columns.length === 0 ? 'No columns found in YAML, catalog.json or the SQL.' : 'Every column is documented.'])
        : h('ul', { class: 'columns' }, shown.map((/** @type {any} */ c) => columnRow(c, s, ai))),
    ]);
  }

  /** @param {string} title @param {any[]} items */
  function relations(title, items) {
    return h('section', { class: 'relations-section' }, [
      h('h2', {}, [`${title} (${items.length})`]),
      items.length === 0
        ? h('p', { class: 'muted' }, ['None'])
        : h('ul', { class: 'relations' }, items.map((r) =>
            h('li', {}, [
              h('span', { class: 'chip small' }, [r.kind]),
              r.location ? link(r.label, r.uniqueId, () => open(r.location)) : h('span', {}, [r.label]),
              r.coverage !== undefined ? h('span', { class: 'muted small right' }, [`${r.coverage}%`]) : null,
            ]),
          )),
    ]);
  }

  // ---------------------------------------------------------------------------
  // Rendering that keeps what the user is typing

  function snapshot() {
    const fields = new Map();
    const active = /** @type {HTMLElement|null} */ (document.activeElement);
    for (const ta of /** @type {NodeListOf<HTMLTextAreaElement>} */ (document.querySelectorAll('[data-key]'))) {
      fields.set(ta.getAttribute('data-key'), {
        value: ta.value,
        original: ta.getAttribute('data-original') || '',
        focused: ta === active,
        start: ta.selectionStart,
        end: ta.selectionEnd,
      });
    }
    return { fields, scroll: window.scrollY };
  }

  /** @param {ReturnType<typeof snapshot>} snap */
  function restore(snap) {
    for (const ta of /** @type {NodeListOf<HTMLTextAreaElement>} */ (document.querySelectorAll('[data-key]'))) {
      const old = snap.fields.get(ta.getAttribute('data-key'));
      if (old) {
        const dirty = old.value !== old.original;
        if (dirty && old.value !== ta.value) ta.value = old.value;
        if (old.focused) {
          ta.focus();
          ta.setSelectionRange(old.start, old.end);
        }
      }
      grow(ta);
    }
    window.scrollTo(0, snap.scroll);
  }

  /** @param {any} m */
  function render(m) {
    const sameModel = m && m.type === 'summary' && m.summary.uniqueId === modelId;
    if (!sameModel) commitAll(); // switching model: save what was typed for the previous one
    const snap = sameModel ? snapshot() : undefined;
    rendering = true;
    try {
      draw(m);
      if (snap) restore(snap);
      else for (const ta of /** @type {NodeListOf<HTMLTextAreaElement>} */ (document.querySelectorAll('[data-key]'))) grow(ta);
    } finally {
      rendering = false;
    }
  }

  /** @param {any} m */
  function draw(m) {
    last = m;
    modelId = m && m.type === 'summary' ? m.summary.uniqueId : undefined;
    app.replaceChildren();
    if (!m || m.type === 'empty') {
      app.append(h('p', { class: 'empty' }, [m ? m.message : 'Loading\u2026']));
      return;
    }
    if (!isPanel) {
      app.append(overview(m));
      return;
    }
    const s = m.summary;
    app.append(
      m.stale ? h('p', { class: 'banner' }, ['manifest.json is out of date; new columns or lineage may be missing.']) : '',
      header(s),
      modelDescription(s),
      coverage(s),
      columns(s, m.aiEnabled),
      h('div', { class: 'relations-grid' }, [relations('Upstream', s.upstream), relations('Downstream', s.downstream)]),
      h('p', { class: 'muted small hint' }, ['Saved to YAML when you leave a field or press Enter. Shift+Enter: new line. Esc: undo.']),
    );
  }

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (m.type === 'saved') setStatus(`Saved to ${fileName(m.file)}`);
    else if (m.type === 'error') setStatus(`Not saved: ${m.message}`);
    else render(m);
  });
  window.addEventListener('blur', commitAll);
  window.addEventListener('resize', () => document.querySelectorAll('[data-key]').forEach((ta) => grow(/** @type {HTMLTextAreaElement} */ (ta))));
  post({ type: 'ready' });
})();
