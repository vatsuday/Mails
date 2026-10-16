// Small rich-text email editor (contenteditable + toolbar) with an HTML source view.
import { esc, html, modal, mount } from './common.js';

const TOOLS = [
  ['bold', '<b>B</b>', 'Bold (Ctrl+B)'],
  ['italic', '<i>I</i>', 'Italic (Ctrl+I)'],
  ['underline', '<u>U</u>', 'Underline (Ctrl+U)'],
  ['strikeThrough', '<s>S</s>', 'Strikethrough'],
  '|',
  ['color', '', 'Text colour'],
  '|',
  ['insertUnorderedList', '&bull;&equiv;', 'Bulleted list'],
  ['insertOrderedList', '1.&equiv;', 'Numbered list'],
  ['outdent', '&#8676;', 'Decrease indent'],
  ['indent', '&#8677;', 'Increase indent'],
  '|',
  ['justifyLeft', '&#8676;&#8801;', 'Align left'],
  ['justifyCenter', '&#8801;', 'Align centre'],
  ['justifyRight', '&#8801;&#8677;', 'Align right'],
  '|',
  ['link', '&#128279;', 'Insert link'],
  ['image', '&#128444;', 'Insert image from a web address'],
  ['button', '&#9634;', 'Insert a button link'],
  ['insertHorizontalRule', '&mdash;', 'Horizontal line'],
  ['removeFormat', '&#10007;', 'Clear formatting'],
  '|',
  ['undo', '&#8630;', 'Undo (Ctrl+Z)'],
  ['redo', '&#8631;', 'Redo (Ctrl+Y)'],
  '|',
  ['source', '&lt;/&gt;', 'Edit HTML source'],
];

export function createEditor(container, { value = '', placeholder = 'Write your message…', onChange = () => {}, tall = false } = {}) {
  const root = document.createElement('div');
  root.className = `rte${tall ? ' tall' : ''}`;
  const tools = TOOLS.map((t) => {
    if (t === '|') return '<span class="sep"></span>';
    if (t[0] === 'color') return `<input type="color" value="#c81e1e" title="${t[2]}" data-cmd="foreColor">`;
    return `<button type="button" data-cmd="${t[0]}" title="${t[2]}" aria-label="${t[2]}">${t[1]}</button>`;
  }).join('');
  root.innerHTML = `<div class="rte-tools">
      <select data-cmd="formatBlock" title="Paragraph style" aria-label="Paragraph style">
        <option value="p">Normal</option><option value="h1">Heading 1</option><option value="h2">Heading 2</option><option value="h3">Heading 3</option><option value="blockquote">Quote</option>
      </select>
      <select data-cmd="fontSize" title="Text size" aria-label="Text size">
        <option value="">Size</option><option value="2">Small</option><option value="3">Normal</option><option value="4">Large</option><option value="5">Larger</option><option value="6">Huge</option>
      </select>
      ${tools}</div>
    <div class="rte-body" contenteditable="true" spellcheck="true" role="textbox" aria-multiline="true"></div>
    <textarea class="rte-source hidden" spellcheck="false" aria-label="HTML source"></textarea>`;
  container.replaceChildren(root);

  const body = root.querySelector('.rte-body');
  const source = root.querySelector('.rte-source');
  body.dataset.placeholder = placeholder;
  body.innerHTML = value || '';
  let sourceMode = false;
  let savedRange = null;

  try { document.execCommand('styleWithCSS', false, true); } catch { /* not supported */ }
  try { document.execCommand('defaultParagraphSeparator', false, 'p'); } catch { /* not supported */ }

  const changed = () => onChange(api.getHTML());
  const saveSel = () => {
    const sel = window.getSelection();
    if (sel.rangeCount && body.contains(sel.anchorNode)) savedRange = sel.getRangeAt(0).cloneRange();
  };
  const restoreSel = () => {
    body.focus();
    if (savedRange) {
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(savedRange);
    }
  };
  const exec = (cmd, arg = null) => {
    restoreSel();
    document.execCommand(cmd, false, arg);
    saveSel();
    changed();
    updateState();
  };
  const updateState = () => {
    for (const b of root.querySelectorAll('button[data-cmd]')) {
      const c = b.dataset.cmd;
      if (['bold', 'italic', 'underline', 'strikeThrough', 'insertUnorderedList', 'insertOrderedList'].includes(c)) {
        try { b.classList.toggle('on', document.queryCommandState(c)); } catch { /* ignore */ }
      }
    }
  };

  body.addEventListener('input', () => { if (body.innerHTML === '<br>') body.innerHTML = ''; changed(); });
  body.addEventListener('keyup', () => { saveSel(); updateState(); });
  body.addEventListener('mouseup', () => { saveSel(); updateState(); });
  body.addEventListener('blur', saveSel);
  source.addEventListener('input', changed);

  // Pasting from Word/web keeps basic formatting; Ctrl+Shift+V pastes plain text.
  body.addEventListener('paste', (e) => {
    const htmlData = e.clipboardData.getData('text/html');
    if (!htmlData) return;
    e.preventDefault();
    const clean = htmlData
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<(script|style|meta|link|title|xml|o:p)\b[\s\S]*?(<\/\1>|\/?>)/gi, '')
      .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
      .replace(/\sclass\s*=\s*("[^"]*"|'[^']*')/gi, '')
      .replace(/<\/?(html|body|head)[^>]*>/gi, '');
    document.execCommand('insertHTML', false, clean);
    changed();
  });

  root.querySelector('.rte-tools').addEventListener('mousedown', (e) => {
    // Keep the caret in the editor when clicking toolbar buttons.
    if (e.target.closest('button')) e.preventDefault();
  });

  root.querySelector('.rte-tools').addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-cmd]');
    if (!b) return;
    const cmd = b.dataset.cmd;
    if (cmd === 'source') return toggleSource();
    if (sourceMode) return;
    if (cmd === 'link') {
      saveSel();
      const selected = window.getSelection().toString();
      const r = await askLink(selected);
      if (!r) return;
      if (selected) exec('createLink', r.url);
      else exec('insertHTML', `<a href="${esc(r.url)}">${esc(r.text || r.url)}</a>`);
      return;
    }
    if (cmd === 'image') {
      saveSel();
      const r = await askImage();
      if (r) exec('insertHTML', `<img src="${esc(r.url)}" alt="${esc(r.alt)}" style="max-width:100%;${r.width ? `width:${Number(r.width)}px;` : ''}">`);
      return;
    }
    if (cmd === 'button') {
      saveSel();
      const r = await askLink('', true);
      if (r) {
        exec('insertHTML', `<p><a href="${esc(r.url)}" style="display:inline-block;background:#4338ca;color:#ffffff;text-decoration:none;font-weight:bold;padding:11px 22px;border-radius:6px">${esc(r.text || 'Open')}</a></p><p></p>`);
      }
      return;
    }
    exec(cmd);
  });

  root.querySelectorAll('select[data-cmd]').forEach((s) => s.addEventListener('change', () => {
    if (!s.value) return;
    exec(s.dataset.cmd, s.dataset.cmd === 'formatBlock' ? `<${s.value}>` : s.value);
    if (s.dataset.cmd === 'fontSize') s.value = '';
  }));
  root.querySelector('input[type="color"]').addEventListener('input', (e) => exec('foreColor', e.target.value));

  function toggleSource() {
    sourceMode = !sourceMode;
    if (sourceMode) {
      source.value = formatHtml(body.innerHTML);
      source.style.height = `${Math.max(300, body.offsetHeight)}px`;
    } else {
      body.innerHTML = source.value;
    }
    body.classList.toggle('hidden', sourceMode);
    source.classList.toggle('hidden', !sourceMode);
    root.querySelectorAll('.rte-tools button, .rte-tools select, .rte-tools input').forEach((el) => {
      if (el.dataset.cmd !== 'source') el.disabled = sourceMode;
    });
    root.querySelector('[data-cmd="source"]').classList.toggle('on', sourceMode);
    changed();
  }

  const api = {
    root,
    getHTML() {
      const h = sourceMode ? source.value : body.innerHTML;
      return h.replace(/^(<p><br><\/p>|<br>)+$/i, '').trim();
    },
    setHTML(h) {
      if (sourceMode) source.value = h || '';
      else body.innerHTML = h || '';
      changed();
    },
    /** Inserts text at the caret (or the end if the editor was never focused). */
    insertText(text) {
      if (sourceMode) {
        const { selectionStart: s, selectionEnd: e2 } = source;
        source.setRangeText(text, s, e2, 'end');
        source.focus();
        changed();
        return;
      }
      if (!savedRange) {
        body.focus();
        const r = document.createRange();
        r.selectNodeContents(body);
        r.collapse(false);
        savedRange = r;
      }
      exec('insertText', text);
    },
    insertHTML(h) {
      if (sourceMode) return api.insertText(h);
      if (!savedRange) {
        body.focus();
        const r = document.createRange();
        r.selectNodeContents(body);
        r.collapse(false);
        savedRange = r;
      }
      exec('insertHTML', h);
    },
    focus() { (sourceMode ? source : body).focus(); },
    isEmpty() {
      const h = api.getHTML();
      return !h.replace(/<(?!img)[^>]*>/gi, '').replace(/&nbsp;/g, ' ').trim();
    },
  };
  return api;
}

function formatHtml(h) {
  return h.replace(/(<\/(p|div|h[1-6]|ul|ol|li|table|tr|blockquote)>)(?!\n)/gi, '$1\n').replace(/(<br\s*\/?>)(?!\n)/gi, '$1\n');
}

function askLink(text, isButton = false) {
  return modal((box, close) => {
    mount(box, html`
      <div class="modal-head"><h2>${isButton ? 'Insert button' : 'Insert link'}</h2></div>
      <form class="stack">
        <label class="field">Web address<input name="url" required placeholder="https://example.com" autofocus></label>
        ${text ? '' : html`<label class="field">${isButton ? 'Button text' : 'Text to show'}<input name="text" placeholder="${isButton ? 'View offer' : 'Optional'}"></label>`}
        <div class="modal-actions"><button type="button" class="btn secondary" data-close>Cancel</button><button class="btn">Insert</button></div>
      </form>`);
    box.querySelector('form').onsubmit = (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      let url = String(f.get('url')).trim();
      if (!/^(https?:|mailto:|tel:|\{\{)/i.test(url)) url = /@/.test(url) && !/\//.test(url) ? `mailto:${url}` : `https://${url}`;
      close({ url, text: String(f.get('text') || '').trim() });
    };
  });
}

function askImage() {
  return modal((box, close) => {
    mount(box, html`
      <div class="modal-head"><h2>Insert image</h2></div>
      <form class="stack">
        <label class="field">Image web address<input name="url" required placeholder="https://yourcompany.com/logo.png" autofocus>
          <span class="hint">Use an image that is already online (your website, Google Drive public link, etc.). Images inside emails must be hosted on the web to show for everyone.</span></label>
        <div class="form-grid">
          <label class="field">Description<input name="alt" placeholder="Company logo"></label>
          <label class="field">Width in pixels<input name="width" type="number" min="10" max="1200" placeholder="Auto"></label>
        </div>
        <div class="modal-actions"><button type="button" class="btn secondary" data-close>Cancel</button><button class="btn">Insert</button></div>
      </form>`);
    box.querySelector('form').onsubmit = (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      let url = String(f.get('url')).trim();
      if (!/^https?:/i.test(url)) url = `https://${url}`;
      close({ url, alt: String(f.get('alt') || ''), width: f.get('width') });
    };
  });
}
