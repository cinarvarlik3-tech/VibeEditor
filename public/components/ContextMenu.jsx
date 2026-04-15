// ─────────────────────────────────────────────────────────────────────────────
// ContextMenu.jsx
// Right-click context menu for timeline elements and track areas.
//
// Props:
//   x, y           {number}   Screen coordinates (fixed position)
//   elementId      {string|null}  Right-clicked element id (null = track area)
//   trackId        {string|null}  Track id of the right-clicked area
//   pasteTime      {number}   Timeline time at which to paste
//   hasClipboard   {boolean}  Whether a clipboard element exists
//   onCopy         {fn}
//   onCut          {fn}
//   onDuplicate    {fn}
//   onDelete       {fn}
//   onPaste        {fn}
//   onClose        {fn}       Called to dismiss the menu
//
// Sets: window.ContextMenu
// ─────────────────────────────────────────────────────────────────────────────

(function () {
  var _Lucide = window.LucideReact;
  var Copy      = _Lucide.Copy;
  var Scissors  = _Lucide.Scissors;
  var Trash2    = _Lucide.Trash2;
  var Clipboard = _Lucide.Clipboard;
  var CopyPlus  = _Lucide.CopyPlus;

  function ContextMenu({
    x, y,
    elementId, trackId,
    pasteTime,
    hasClipboard,
    onCopy, onCut, onDuplicate, onDelete, onPaste,
    onClose,
  }) {
    // Build menu items
    var items = [];

    if (elementId) {
      items.push({
        label:  'Copy',
        Icon:   Copy,
        action: function() { onCopy && onCopy(elementId); },
      });
      items.push({
        label:  'Cut',
        Icon:   Scissors,
        action: function() { onCut && onCut(elementId); },
      });
      items.push({
        label:  'Duplicate',
        Icon:   CopyPlus,
        action: function() { onDuplicate && onDuplicate(elementId); },
      });
      items.push({ separator: true });
      items.push({
        label:  'Delete',
        Icon:   Trash2,
        danger: true,
        action: function() { onDelete && onDelete(elementId); },
      });
    }

    if (hasClipboard) {
      if (items.length > 0) items.push({ separator: true });
      items.push({
        label:  'Paste',
        Icon:   Clipboard,
        action: function() { onPaste && onPaste(pasteTime, trackId); },
      });
    }

    if (items.filter(function(i) { return !i.separator; }).length === 0) return null;

    // Clamp to viewport so menu doesn't overflow right/bottom edge
    var menuW  = 160;
    var menuH  = items.length * 30 + 8;
    var left   = Math.min(x, window.innerWidth  - menuW  - 8);
    var top    = Math.min(y, window.innerHeight - menuH - 8);

    function doAction(fn) {
      fn();
      onClose && onClose();
    }

    return (
      <div
        style={{
          position:     'fixed',
          left:         left,
          top:          top,
          zIndex:       9999,
          background:   '#1e1e1e',
          border:       '1px solid rgba(255,255,255,0.12)',
          borderRadius: 6,
          padding:      '4px 0',
          minWidth:     menuW,
          boxShadow:    '0 8px 24px rgba(0,0,0,0.6)',
          userSelect:   'none',
        }}
        onMouseDown={function(e) { e.stopPropagation(); }}
      >
        {items.map(function(item, i) {
          if (item.separator) {
            return (
              <div
                key={'sep-' + i}
                style={{ height: 1, background: 'rgba(255,255,255,0.07)', margin: '3px 0' }}
              />
            );
          }
          return (
            <button
              key={item.label}
              onClick={function() { doAction(item.action); }}
              style={{
                display:    'flex',
                alignItems: 'center',
                gap:        8,
                width:      '100%',
                padding:    '5px 12px',
                background: 'none',
                border:     'none',
                cursor:     'pointer',
                color:      item.danger ? '#FF6B6B' : '#ccc',
                fontSize:   12,
                textAlign:  'left',
              }}
              onMouseEnter={function(e) { e.currentTarget.style.background = 'rgba(255,255,255,0.06)'; }}
              onMouseLeave={function(e) { e.currentTarget.style.background = 'none'; }}
            >
              {item.Icon && React.createElement(item.Icon, { size: 12 })}
              {item.label}
            </button>
          );
        })}
      </div>
    );
  }

  window.ContextMenu = ContextMenu;
})();
