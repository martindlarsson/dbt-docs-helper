// @ts-check
// Renders the "Model" view from the data posted by src/modelSummary.ts.
// Uses DOM APIs only (textContent), so descriptions cannot inject markup.
(function () {
  // eslint-disable-next-line no-undef
  const vscode = acquireVsCodeApi();
  const app = /** @type {HTMLElement} */ (document.getElementById('app'));
  const saved = vscode.getState() || {};
  let filter = saved.filter || 'all';
  /** @type {any} */
  let last;

  /**
   * @param {string} tag
   * @param {Record<string, any>} [attrs]
   * @param {(Node|string|null|undefined|false)[]} [children]
   */
  function h(tag, attrs, children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'onclick') el.addEventListener('click', v);
      else if (k === 'onkeydown') el.addEventListener('keydown', v);
      else if (k === 'class') el.className = v;
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

  const STATUS = {
    documented: { label: 'Documented', cls: 'documented' },
    inheritable: { label: 'Can be inherited', cls: 'inheritable' },
    missing: { label: 'Missing', cls: 'missing' },
  };

  /** @param {any} s */
  function header(s) {
    const meta = [s.kind, s.materialized, s.layer && s.layer !== 'other' ? s.layer : undefined].filter(Boolean);
    return h('header', {}, [
      h('div', { class: 'title-row' }, [
        h('h1', { title: s.uniqueId }, [s.label]),
        h('span', { class: 'chips' }, meta.map((m) => h('span', { class: 'chip' }, [m]))),
      ]),
      h('div', { class: 'file-links' }, [
        s.locations.source && h('a', { href: '#', onclick: () => open(s.locations.source), title: s.locations.source.file }, [fileName(s.locations.source.file)]),
        s.locations.yaml && h('a', { href: '#', onclick: () => open(s.locations.yaml), title: s.locations.yaml.file }, [fileName(s.locations.yaml.file)]),
      ]),
      s.tags.length || s.owner
        ? h('div', { class: 'muted small' }, [
            s.owner ? `Owner: ${s.owner}` : '',
            s.owner && s.tags.length ? ' · ' : '',
            s.tags.length ? `Tags: ${s.tags.join(', ')}` : '',
          ])
        : null,
    ]);
  }

  /** @param {string} f */
  function fileName(f) {
    return f.split('/').pop() || f;
  }

  /** @param {any} s */
  function description(s) {
    const has = s.description && s.description.trim().length > 0;
    return h('section', { class: 'model-description' }, [
      has
        ? h('p', {}, [s.description])
        : h('p', { class: 'warning' }, [s.locations.yaml ? 'This model has no description.' : 'This model has no YAML entry yet.']),
      h('div', { class: 'actions' }, [
        s.docBlock && h('span', { class: 'chip', title: 'Doc block' }, [`{{ doc('${s.docBlock}') }}`]),
        s.locations.yaml && button(has ? 'Edit description' : 'Write description', 'Edit the model description', () => post({ type: 'action', action: 'editModel' })),
      ]),
    ]);
  }

  /** @param {any} s */
  function coverage(s) {
    const c = s.counts;
    const total = Math.max(1, c.columns);
    const pct = (/** @type {number} */ n) => `${(100 * n) / total}%`;
    const safe = s.columns.filter((/** @type {any} */ col) => col.inherit && col.inherit.safe).length;
    return h('section', { class: 'coverage' }, [
      h('div', { class: 'bar', role: 'img', 'aria-label': `${c.documented} documented, ${c.inheritable} inheritable, ${c.missing} missing` }, [
        h('span', { class: 'documented', style: `width:${pct(c.documented)}` }),
        h('span', { class: 'inheritable', style: `width:${pct(c.inheritable)}` }),
        h('span', { class: 'missing', style: `width:${pct(c.missing)}` }),
      ]),
      h('div', { class: 'legend' }, [
        h('span', {}, [h('i', { class: 'dot documented' }), ` ${c.documented} documented`]),
        h('span', {}, [h('i', { class: 'dot inheritable' }), ` ${c.inheritable} inheritable`]),
        h('span', {}, [h('i', { class: 'dot missing' }), ` ${c.missing} missing`]),
      ]),
      safe > 0 || c.notInYaml > 0
        ? h('div', { class: 'actions' }, [
            safe > 0 && button(`Inherit ${safe} safe`, 'Write all descriptions that are passed through unchanged from a single upstream column', () => post({ type: 'action', action: 'inheritAll' }), 'primary'),
            c.notInYaml > 0 && s.locations.yaml && button(`Add ${c.notInYaml} missing column${c.notInYaml === 1 ? '' : 's'}`, 'Columns in the warehouse (catalog.json) that are not in YAML', () => post({ type: 'action', action: 'addColumns' })),
          ])
        : null,
    ]);
  }

  /** @param {any} col @param {boolean} ai */
  function columnRow(col, ai) {
    const st = STATUS[/** @type {'documented'|'inheritable'|'missing'} */ (col.status)];
    const acts = [];
    if (!col.notInYaml) {
      if (col.inherit) acts.push(button('Inherit', `Write ${col.inherit.docBlock ? `{{ doc('${col.inherit.docBlock}') }}` : 'the text'} from ${col.inherit.from}.${col.inherit.fromColumn}`, () => action('inherit', col.name), col.inherit.safe ? 'primary' : 'secondary'));
      acts.push(button('Edit', 'Write or change the description', () => action('edit', col.name)));
      if (col.status === 'documented' && !col.docBlock) acts.push(button('To doc block', 'Move the description to a doc block and link it', () => action('move', col.name)));
      if (!col.docBlock) acts.push(button('Link…', 'Link to an existing doc block', () => action('link', col.name)));
      if (ai && col.status !== 'documented') acts.push(button('AI', 'Suggest a description with AI', () => action('ai', col.name)));
    }
    let text;
    if (col.notInYaml) text = h('p', { class: 'muted' }, ['In the warehouse, not in YAML.']);
    else if (col.status === 'documented') text = h('p', {}, [col.description]);
    else if (col.inherit)
      text = h('p', { class: 'inherited' }, [
        h('span', { class: 'from' }, [`↳ ${col.inherit.from}${col.inherit.fromColumn !== col.name ? `.${col.inherit.fromColumn}` : ''}`, col.inherit.kind !== 'passthrough' ? ` (${col.inherit.kind})` : '', ': ']),
        col.inherit.description,
        col.moreCandidates > 0 ? h('span', { class: 'muted' }, [` +${col.moreCandidates} more`]) : null,
      ]);
    else text = h('p', { class: 'muted' }, ['No description, and nothing to inherit.']);
    return h('li', {
      class: `column ${st.cls}`,
      title: st.label,
      tabindex: 0,
      onclick: () => open(col.location),
      onkeydown: (/** @type {KeyboardEvent} */ e) => { if (e.key === 'Enter' && e.target === e.currentTarget) open(col.location); },
    }, [
      h('div', { class: 'col-head' }, [
        h('i', { class: `dot ${col.notInYaml ? 'notinyaml' : st.cls}`, title: col.notInYaml ? 'Not in YAML' : st.label }),
        h('span', { class: 'col-name' }, [col.name]),
        col.dataType && h('span', { class: 'muted small type' }, [col.dataType.toLowerCase()]),
        col.docBlock && h('span', { class: 'chip small', title: `{{ doc('${col.docBlock}') }}` }, ['doc block']),
      ]),
      text,
      acts.length ? h('div', { class: 'actions row-actions' }, acts) : null,
    ]);
  }

  /** @param {any} s @param {boolean} ai */
  function columns(s, ai) {
    const needs = s.columns.filter((/** @type {any} */ c) => c.status !== 'documented');
    const shown = filter === 'needs' ? needs : s.columns;
    const tab = (/** @type {string} */ id, /** @type {string} */ label) =>
      h('button', { class: `tab ${filter === id ? 'active' : ''}`, 'aria-pressed': filter === id, onclick: () => { filter = id; vscode.setState({ filter }); render(last); } }, [label]);
    return h('section', {}, [
      h('div', { class: 'section-head' }, [h('h2', {}, ['Columns']), h('span', { class: 'tabs' }, [tab('all', `All ${s.columns.length}`), tab('needs', `Needs work ${needs.length}`)])]),
      shown.length === 0
        ? h('p', { class: 'muted' }, [s.columns.length === 0 ? 'No columns in YAML or catalog.json.' : 'Every column is documented.'])
        : h('ul', { class: 'columns' }, shown.map((/** @type {any} */ c) => columnRow(c, ai))),
    ]);
  }

  /** @param {string} title @param {any[]} items */
  function relations(title, items) {
    return h('section', {}, [
      h('h2', {}, [`${title} (${items.length})`]),
      items.length === 0
        ? h('p', { class: 'muted' }, ['None'])
        : h('ul', { class: 'relations' }, items.map((r) =>
            h('li', { onclick: () => open(r.location), title: r.uniqueId, class: r.location ? 'clickable' : '' }, [
              h('span', { class: 'chip small' }, [r.kind]),
              ` ${r.label}`,
              r.coverage !== undefined ? h('span', { class: 'muted small right' }, [`${r.coverage}%`]) : null,
            ]),
          )),
    ]);
  }

  /** @param {any} m */
  function render(m) {
    last = m;
    app.replaceChildren();
    if (!m || m.type === 'empty') {
      app.append(h('p', { class: 'empty' }, [m ? m.message : 'Loading…']));
      return;
    }
    const s = m.summary;
    app.append(
      m.stale ? h('p', { class: 'banner' }, ['manifest.json is out of date; lineage may be incomplete.']) : '',
      header(s),
      description(s),
      coverage(s),
      columns(s, m.aiEnabled),
      relations('Upstream', s.upstream),
      relations('Downstream', s.downstream),
    );
  }

  window.addEventListener('message', (e) => render(e.data));
  post({ type: 'ready' });
})();
