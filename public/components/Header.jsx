// ─────────────────────────────────────────────────────────────────────────────
// Header.jsx
// 40px top bar: editable project name on the left, Export button on the right.
//
// Props:
//   projectName      {string}  Current project name
//   onRenameProject  {fn}      Called with new name string when user finishes editing
//   onExport         {fn}      Called when Export button is clicked
//
// Sets: window.Header
// ─────────────────────────────────────────────────────────────────────────────

(function () {
  var { useState, useRef, useCallback } = React;
  var { Download } = window.LucideReact;

  function Header({ projectName, onRenameProject, onExport }) {
    var [editing,  setEditing]  = useState(false);
    var [draft,    setDraft]    = useState('');
    var inputRef = useRef(null);

    function startEdit() {
      setDraft(projectName || 'Untitled Project');
      setEditing(true);
      // Focus on next tick after render
      setTimeout(function() { if (inputRef.current) inputRef.current.select(); }, 0);
    }

    function commitEdit() {
      var name = draft.trim() || 'Untitled Project';
      onRenameProject && onRenameProject(name);
      setEditing(false);
    }

    function handleKeyDown(e) {
      if (e.key === 'Enter')  { e.preventDefault(); commitEdit(); }
      if (e.key === 'Escape') { setEditing(false); }
    }

    return (
      <div style={{
        height:         40,
        display:        'flex',
        alignItems:     'center',
        padding:        '0 16px',
        background:     '#0d0d0d',
        userSelect:     'none',
        gap:            12,
      }}>

        {/* Logo / brand mark */}
        <span style={{ color: '#00BCD4', fontSize: 11, fontWeight: 700, letterSpacing: 2, flexShrink: 0, textTransform: 'uppercase' }}>
          VIBE
        </span>

        <div style={{ width: 1, height: 16, background: 'rgba(255,255,255,0.1)', flexShrink: 0 }} />

        {/* Editable project name */}
        {editing ? (
          <input
            ref={inputRef}
            value={draft}
            onChange={function(e) { setDraft(e.target.value); }}
            onBlur={commitEdit}
            onKeyDown={handleKeyDown}
            style={{
              background:   'rgba(255,255,255,0.06)',
              border:       '1px solid rgba(0,188,212,0.4)',
              borderRadius: 4,
              color:        '#eee',
              fontSize:     12,
              padding:      '2px 8px',
              outline:      'none',
              minWidth:     160,
              maxWidth:     320,
            }}
          />
        ) : (
          <span
            onClick={startEdit}
            title="Click to rename project"
            style={{
              color:        '#bbb',
              fontSize:     12,
              cursor:       'text',
              padding:      '2px 4px',
              borderRadius: 3,
              maxWidth:     320,
              overflow:     'hidden',
              textOverflow: 'ellipsis',
              whiteSpace:   'nowrap',
            }}
            onMouseEnter={function(e) { e.currentTarget.style.background = 'rgba(255,255,255,0.04)'; }}
            onMouseLeave={function(e) { e.currentTarget.style.background = 'none'; }}
          >
            {projectName || 'Untitled Project'}
          </span>
        )}

        {/* Spacer */}
        <div style={{ flex: 1 }} />

        {/* Export button */}
        <button
          onClick={onExport}
          style={{
            display:      'flex',
            alignItems:   'center',
            gap:          6,
            background:   '#00BCD4',
            border:       'none',
            borderRadius: 5,
            color:        '#000',
            fontSize:     11,
            fontWeight:   700,
            padding:      '5px 14px',
            cursor:       'pointer',
            letterSpacing: 0.5,
          }}
          onMouseEnter={function(e) { e.currentTarget.style.background = '#00ACC1'; }}
          onMouseLeave={function(e) { e.currentTarget.style.background = '#00BCD4'; }}
        >
          <Download size={12} />
          Export
        </button>
      </div>
    );
  }

  window.Header = Header;
})();
