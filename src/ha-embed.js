// Runs before the House Control bundle when the page is embedded in a Home Assistant
// card (embed.html?embed=ha#<plan>). It stands in for the native shell: the plan comes
// from the URL hash, and the "native" message channel is the parent window, where the
// card turns commands into Home Assistant service calls and reports device states back.
(function () {
  var params = new URLSearchParams(location.search);
  if (!params.has('embed')) return;
  document.documentElement.classList.add('embed');

  var config = null;
  try {
    var b64 = location.hash.slice(1).replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    var bin = atob(b64);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    config = JSON.parse(new TextDecoder().decode(bytes));
  } catch (e) {
    console.error('[house-embed] cannot read the plan from the URL', e);
  }
  window.__HOUSE_BOOT__ = config ? { config: config, plan: 'custom', platform: 'web' } : { plan: 'home', platform: 'web' };

  var host = window.parent;
  if (!host || host === window) return; // opened on its own: behave like the plain web demo

  window.webkit = window.webkit || {};
  window.webkit.messageHandlers = window.webkit.messageHandlers || {};
  window.webkit.messageHandlers.house = {
    postMessage: function (msg) {
      try { host.postMessage({ __house: 1, msg: JSON.parse(JSON.stringify(msg)) }, '*'); } catch (e) { /* ignore */ }
    },
  };

  // The edit trigger lives next to the home title, but file handling and HA access
  // stay in the trusted parent. This bridge never receives credentials.
  var editorState = { open: false, preview: false, busy: false };
  var editButton = null;
  function updateEditorButton(state) {
    editorState = state || editorState;
    if (!editButton) return;
    editButton.setAttribute('aria-expanded', String(Boolean(editorState.open)));
    editButton.classList.toggle('active', Boolean(editorState.open));
    editButton.classList.toggle('has-preview', Boolean(editorState.preview));
    var label = editorState.open ? '收起地图编辑工具' : '展开地图编辑工具';
    if (editorState.preview) label += '（只读预览，设备控制已暂停）';
    editButton.setAttribute('aria-label', label);
    editButton.title = label;
    if (editorState.restoreFocus) editButton.focus({ preventScroll: true });
  }
  var observer = new MutationObserver(function () {
    var name = document.querySelector('.home-name');
    if (!name || editButton) return;
    var row = document.createElement('div');
    row.className = 'home-name-row';
    name.parentNode.insertBefore(row, name);
    row.appendChild(name);
    editButton = document.createElement('button');
    editButton.className = 'ha-edit-trigger';
    editButton.type = 'button';
    editButton.innerHTML = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="2.5" fill="#202127"/><circle cx="15" cy="17" r="2.5" fill="#202127"/></svg>';
    editButton.onclick = function () { window.webkit.messageHandlers.house.postMessage({ type: 'toggleEdit' }); };
    row.appendChild(editButton);
    updateEditorButton(editorState);
    observer.disconnect();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  window.addEventListener('message', function (e) {
    if (e.source !== host || !e.data || !e.data.__houseHost) return;
    if (e.data.fn === 'setEditorState') { updateEditorButton(e.data.args && e.data.args[0]); return; }
    var fn = window.house && window.house[e.data.fn];
    if (typeof fn === 'function') fn.apply(null, e.data.args || []);
  });
})();
